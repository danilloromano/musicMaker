// Análise de uma música inteira (a mix renderizada ou uma faixa de referência): loudness, dinâmica,
// equilíbrio de frequências e imagem estéreo. Base da comparação A/B e do master automático.
import { TruePeak, Loudness, dbfs, lufs } from './dsp/loudness';

/** Regiões de frequência usadas no equilíbrio tonal. */
export const BANDS: { name: string; lo: number; hi: number }[] = [
  { name: 'Sub-grave', lo: 20, hi: 60 },
  { name: 'Graves', lo: 60, hi: 250 },
  { name: 'Médio-graves', lo: 250, hi: 1000 },
  { name: 'Médios', lo: 1000, hi: 4000 },
  { name: 'Presença', lo: 4000, hi: 10000 },
  { name: 'Ar', lo: 10000, hi: 20000 },
];

/** Pontos do espectro médio (escala logarítmica). */
export const SPEC_MIN = 30;
export const SPEC_MAX = 18000;
export const SPEC_POINTS = 120;
export const specFreq = (i: number) => SPEC_MIN * (SPEC_MAX / SPEC_MIN) ** (i / (SPEC_POINTS - 1));

export interface Analysis {
  duration: number;
  /** LUFS integrado */
  lufs: number;
  /** pico real (dBTP) */
  truePeak: number;
  /** variação de loudness (LU): diferença entre as partes altas e as baixas da música */
  lra: number;
  /** pico real − LUFS (dB): quanto espaço os picos têm acima do volume médio (baixo = muito comprimido) */
  plr: number;
  /** energia de cada região (dB, relativa à energia total) */
  bands: number[];
  /** espectro médio (dB, relativo ao pico do próprio espectro) nos pontos specFreq */
  spectrum: number[];
  /** correlação de fase (−1 a 1) */
  correlation: number;
  /** energia dos lados (diferença E−D) relativa ao meio, abaixo de 150 Hz (dB) */
  sideLow: number;
  /** energia dos lados relativa ao meio, na música toda (dB): mede a largura */
  sideAll: number;
}

/** FFT complexa de raiz 2, no lugar. */
function fft(re: Float64Array, im: Float64Array) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k, b = a + len / 2;
        const tr = re[b] * cr - im[b] * ci;
        const ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr;
        im[b] = im[a] - ti;
        re[a] += tr;
        im[a] += ti;
        const nr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = nr;
      }
    }
  }
}

const tick = () => new Promise((ok) => setTimeout(ok, 0));

export async function analyze(l: Float32Array, r: Float32Array, sr: number, onProgress?: (p: number) => void): Promise<Analysis> {
  const n = l.length;
  // loudness, variação (curto prazo a cada 0,5 s) e pico real
  const meter = new Loudness(sr);
  const tpL = new TruePeak(), tpR = new TruePeak();
  let peak = 0;
  const shorts: number[] = [];
  const hop = Math.round(sr / 2);
  for (let s = 0; s < n; s += hop) {
    const e = Math.min(n, s + hop);
    meter.push(l, r, s, e);
    for (let i = s; i < e; i++) peak = Math.max(peak, tpL.next(l[i]), tpR.next(r[i]));
    if (s >= sr * 3) shorts.push(meter.shortTerm());
    if ((s / hop) % 40 === 39) {
      onProgress?.((s / n) * 0.5);
      await tick();
    }
  }
  const integrated = meter.integrated();
  // LRA (EBU 3342): curto prazo acima de −70 LUFS e acima de (média − 20 LU); faixa entre os percentis 10 e 95
  const abs = shorts.filter((v) => v > -70);
  let lra = 0;
  if (abs.length > 2) {
    const mean = lufs(abs.reduce((a, v) => a + 10 ** ((v + 0.691) / 10), 0) / abs.length);
    const g = abs.filter((v) => v > mean - 20).sort((a, b) => a - b);
    if (g.length > 2) lra = g[Math.floor(g.length * 0.95) - 1] - g[Math.floor(g.length * 0.1)];
  }

  // espectro médio (meio e lados), janelas de Hann de 4096 com metade de sobreposição
  const N = 4096;
  const win = Float64Array.from({ length: N }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1)));
  const midPow = new Float64Array(N / 2);
  const sidePow = new Float64Array(N / 2);
  const re = new Float64Array(N), im = new Float64Array(N);
  const re2 = new Float64Array(N), im2 = new Float64Array(N);
  let frames = 0, sumLR = 0, sumLL = 0, sumRR = 0;
  for (let s = 0; s + N <= n; s += N / 2, frames++) {
    for (let i = 0; i < N; i++) {
      const a = l[s + i], b = r[s + i];
      re[i] = ((a + b) / 2) * win[i];
      re2[i] = ((a - b) / 2) * win[i];
      im[i] = im2[i] = 0;
      if (i < N / 2) {
        sumLR += a * b;
        sumLL += a * a;
        sumRR += b * b;
      }
    }
    fft(re, im);
    fft(re2, im2);
    for (let k = 0; k < N / 2; k++) {
      midPow[k] += re[k] * re[k] + im[k] * im[k];
      sidePow[k] += re2[k] * re2[k] + im2[k] * im2[k];
    }
    if (frames % 200 === 199) {
      onProgress?.(0.5 + (s / n) * 0.5);
      await tick();
    }
  }
  const hz = sr / N;
  const binOf = (f: number) => Math.max(1, Math.min(N / 2 - 1, Math.round(f / hz)));
  const sumPow = (p: Float64Array, lo: number, hi: number) => {
    let s = 0;
    for (let k = binOf(lo); k <= binOf(hi); k++) s += p[k];
    return s;
  };
  const total = sumPow(midPow, 20, 20000) + sumPow(sidePow, 20, 20000);
  const bands = BANDS.map((b) => 10 * Math.log10((sumPow(midPow, b.lo, b.hi) + sumPow(sidePow, b.lo, b.hi)) / total + 1e-20));
  // espectro suavizado em 1/6 de oitava
  const raw = Array.from({ length: SPEC_POINTS }, (_, i) => {
    const f = specFreq(i);
    const lo = binOf(f / 2 ** (1 / 12)), hi = binOf(f * 2 ** (1 / 12));
    let s = 0;
    for (let k = lo; k <= hi; k++) s += midPow[k] + sidePow[k];
    return 10 * Math.log10(s / (hi - lo + 1) + 1e-20);
  });
  const top = Math.max(...raw);
  const spectrum = raw.map((v) => v - top);
  const sideLow = 10 * Math.log10((sumPow(sidePow, 20, 150) + 1e-20) / (sumPow(midPow, 20, 150) + 1e-20));
  const sideAll = 10 * Math.log10((sumPow(sidePow, 20, 20000) + 1e-20) / (sumPow(midPow, 20, 20000) + 1e-20));
  const tp = dbfs(peak);
  onProgress?.(1);
  return {
    duration: n / sr,
    lufs: integrated,
    truePeak: tp,
    lra,
    plr: tp - integrated,
    bands,
    spectrum,
    correlation: sumLL && sumRR ? sumLR / Math.sqrt(sumLL * sumRR) : 1,
    sideLow,
    sideAll,
  };
}

/** Equilíbrio tonal típico de músicas masterizadas (pop/rock atual), para quando não há referência. */
export const TYPICAL_BANDS = [-12, -4.5, -6, -10, -14, -21];
