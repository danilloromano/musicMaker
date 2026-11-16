// Finalização da exportação: depois de renderizar a mixagem (com EQ, compressor e saturação do master),
// aplica o limitador de pico real — ajustando o ganho até atingir o alvo de loudness escolhido — e grava
// o WAV (24 bits, ou 16 bits com dither).
import { limitBuffer, truePeaks } from './dsp/limiter';
import { Loudness, dbfs } from './dsp/loudness';
import { EXPORT_TARGETS } from './master';
import type { MasterSettings } from '../types';

export interface ExportReport {
  /** LUFS integrado do arquivo final */
  lufs: number;
  /** pico real do arquivo final (dBTP) */
  truePeak: number;
  /** alvo pedido (LUFS) ou null */
  target: number | null;
  /** ganho que o limitador aplicou (dB) */
  gain: number;
  bits: 16 | 24;
}

const tick = () => new Promise((ok) => setTimeout(ok, 0));

/** Limitação máxima que o alvo automático aplica: além disso a música distorce e perde toda a dinâmica. */
export const MAX_AUTO_GAIN = 18;

async function integrated(l: Float32Array, r: Float32Array, sr: number) {
  const m = new Loudness(sr);
  const chunk = 1 << 18;
  for (let s = 0; s < l.length; s += chunk) {
    m.push(l, r, s, Math.min(l.length, s + chunk));
    await tick();
  }
  return m.integrated();
}

async function maxTruePeak(l: Float32Array, r: Float32Array, onProgress?: (p: number) => void) {
  const peaks = await truePeaks(l, r, onProgress);
  let p = 0;
  for (let i = 0; i < peaks.length; i++) if (peaks[i] > p) p = peaks[i];
  return dbfs(p);
}

/**
 * Aplica o limitador (e o alvo de loudness) ao áudio renderizado. Com alvo, ajusta o ganho de entrada
 * do limitador em poucas rodadas: mede o resultado, corrige a diferença, repete (o limitador comprime,
 * então cada dB a mais rende um pouco menos que 1 dB).
 */
export async function finishMaster(
  rendered: AudioBuffer,
  m: MasterSettings,
  onProgress: (p: number) => void,
): Promise<{ channels: [Float32Array, Float32Array]; report: ExportReport }> {
  const sr = rendered.sampleRate;
  const l = rendered.getChannelData(0);
  const r = rendered.numberOfChannels > 1 ? rendered.getChannelData(1) : l;
  const target = EXPORT_TARGETS.find((t) => t.id === m.exportTarget)?.lufs ?? null;

  // sem limitador e sem alvo: sai como está
  if (!m.limiter.on && target === null) {
    const tp = await maxTruePeak(l, r, (p) => onProgress(p * 0.9));
    return { channels: [l, r], report: { lufs: await integrated(l, r, sr), truePeak: tp, target, gain: 0, bits: m.exportBits } };
  }

  const peaks = await truePeaks(l, r, (p) => onProgress(p * 0.4));
  const ceiling = 10 ** (m.limiter.ceiling / 20);
  const release = m.limiter.release / 1000;
  const run = (gainDb: number) => limitBuffer(l, r, peaks, sr, { gain: 10 ** (gainDb / 20), ceiling, release });

  let gain = m.limiter.gain;
  let out: [Float32Array, Float32Array];
  if (target === null) {
    out = await run(gain);
    onProgress(0.7);
  } else {
    // ponto de partida: a diferença entre o alvo e o loudness sem limitador
    const before = await integrated(l, r, sr);
    gain = Number.isFinite(before) ? Math.min(MAX_AUTO_GAIN, target - before) : 0;
    out = await run(gain);
    // método da secante: mede quanto cada dB de ganho rende de loudness (com limitação pesada, bem
    // menos que 1 dB) e corrige por essa taxa
    let prev: { gain: number; got: number } | null = null;
    for (let i = 0; i < 10; i++) {
      onProgress(0.4 + (i / 10) * 0.3);
      const got = await integrated(out[0], out[1], sr);
      if (!Number.isFinite(got) || Math.abs(target - got) < 0.1) break;
      let slope = 1;
      if (prev && Math.abs(gain - prev.gain) > 0.01) slope = Math.min(1, Math.max(0.05, (got - prev.got) / (gain - prev.gain)));
      prev = { gain, got };
      const next = Math.min(MAX_AUTO_GAIN, gain + (target - got) / slope);
      if (Math.abs(next - gain) < 0.01) break; // já no limite
      gain = next;
      out = await run(gain);
    }
  }
  const tp = await maxTruePeak(out[0], out[1], (p) => onProgress(0.7 + p * 0.25));
  const lufs = await integrated(out[0], out[1], sr);
  return { channels: out, report: { lufs, truePeak: tp, target, gain, bits: m.exportBits } };
}

/** WAV PCM de 24 bits, ou 16 bits com dither triangular (evita a distorção da redução de bits). */
export function encodeWav(chans: Float32Array[], sr: number, bits: 16 | 24): Blob {
  const ch = chans.length;
  const n = chans[0].length;
  const bytes = bits / 8;
  const view = new DataView(new ArrayBuffer(44 + n * ch * bytes));
  const str = (o: number, s: string) => [...s].forEach((c, i) => view.setUint8(o + i, c.charCodeAt(0)));
  str(0, 'RIFF');
  view.setUint32(4, 36 + n * ch * bytes, true);
  str(8, 'WAVEfmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, ch, true);
  view.setUint32(24, sr, true);
  view.setUint32(28, sr * ch * bytes, true);
  view.setUint16(32, ch * bytes, true);
  view.setUint16(34, bits, true);
  str(36, 'data');
  view.setUint32(40, n * ch * bytes, true);
  let o = 44;
  const full = bits === 24 ? 8388607 : 32767;
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < ch; c++) {
      let v = chans[c][i] * full;
      if (bits === 16) v += Math.random() - Math.random(); // dither TPDF de ±1 LSB
      const q = Math.max(-full - 1, Math.min(full, Math.round(v)));
      if (bits === 24) {
        view.setUint8(o, q & 0xff);
        view.setUint8(o + 1, (q >> 8) & 0xff);
        view.setUint8(o + 2, (q >> 16) & 0xff);
      } else view.setInt16(o, q, true);
      o += bytes;
    }
  }
  return new Blob([view], { type: 'audio/wav' });
}

/** Converte para inteiros de `bits` bits; em 16 bits com dither triangular (TPDF) de ±1 LSB. */
export function quantize(chans: Float32Array[], bits: 16 | 24): Int32Array[] {
  const full = bits === 24 ? 8388607 : 32767;
  return chans.map((c) => {
    const out = new Int32Array(c.length);
    for (let i = 0; i < c.length; i++) {
      let v = c[i] * full;
      if (bits === 16) v += Math.random() - Math.random();
      out[i] = Math.max(-full - 1, Math.min(full, Math.round(v)));
    }
    return out;
  });
}

/** MP3 (encoder LAME em WebAssembly, carregado só quando necessário). */
export async function encodeMp3(chans: Float32Array[], sr: number, bitrate: 128 | 192 | 256 | 320, onProgress?: (p: number) => void): Promise<Blob> {
  const { createMp3Encoder } = await import('wasm-media-encoders');
  const enc = await createMp3Encoder();
  enc.configure({ sampleRate: sr, channels: chans.length as 1 | 2, bitrate });
  const parts: BlobPart[] = [];
  const step = 1152 * 64;
  for (let i = 0; i < chans[0].length; i += step) {
    parts.push(enc.encode(chans.map((c) => c.subarray(i, i + step))).slice());
    if ((i / step) % 16 === 15) {
      onProgress?.(i / chans[0].length);
      await new Promise((ok) => setTimeout(ok, 0));
    }
  }
  parts.push(enc.finalize().slice());
  return new Blob(parts, { type: 'audio/mpeg' });
}

/** Grava no formato escolhido no master; devolve o arquivo e a extensão. */
export async function encodeExport(
  chans: Float32Array[],
  sr: number,
  m: { exportFormat?: 'wav' | 'flac' | 'mp3'; exportBits: 16 | 24; mp3Bitrate?: 128 | 192 | 256 | 320 },
  onProgress?: (p: number) => void,
): Promise<{ blob: Blob; ext: string }> {
  const format = m.exportFormat ?? 'wav';
  if (format === 'mp3') return { blob: await encodeMp3(chans, sr, m.mp3Bitrate ?? 320, onProgress), ext: 'mp3' };
  if (format === 'flac') {
    const { encodeFlac } = await import('./flac');
    return { blob: await encodeFlac(quantize(chans, m.exportBits), sr, m.exportBits, onProgress), ext: 'flac' };
  }
  return { blob: encodeWav(chans, sr, m.exportBits), ext: 'wav' };
}
