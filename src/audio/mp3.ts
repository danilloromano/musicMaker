// Codificador MP3 próprio (MPEG-1 Layer III, taxa constante), sem bibliotecas — como os de WAV e FLAC.
//
// Caminho de cada quadro (1152 amostras por canal, 2 grânulos de 576):
//   banco de 32 filtros polifásicos → inversão de frequência nas sub-bandas ímpares → MDCT de 36 pontos
//   (blocos longos) → redução de aliasing → estéreo M/S → corte dos agudos que a taxa não comporta →
//   quantização (o ganho global é achado por busca binária para caber nos bits do quadro) → códigos
//   Huffman (regiões, escolha da tabela mais econômica, quádruplas) → cabeçalho e informação lateral.
// Sem modelo psicoacústico, reservatório de bits nem blocos curtos (como o codificador "shine"): soa bem em
// 192–320 kbps; em taxas baixas, abaixo do LAME. As tabelas do padrão estão em mp3tables.ts.
import { HUFF, QUAD_A, QUAD_B, SFB_LONG, SYNTH_WINDOW } from './mp3tables';
import type { HuffTable } from './mp3tables';

export type Mp3Kbps = 128 | 160 | 192 | 224 | 256 | 320;
const BITRATES = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
const SR_INDEX: Record<number, number> = { 44100: 0, 48000: 1, 32000: 2 };

// ---------- bits ----------

class BitWriter {
  buf: Uint8Array;
  pos = 0; // em bits
  constructor(bytes: number) {
    this.buf = new Uint8Array(bytes);
  }
  put(value: number, n: number) {
    for (let i = n - 1; i >= 0; i--) {
      if ((value >>> i) & 1) this.buf[this.pos >> 3] |= 0x80 >> (this.pos & 7);
      this.pos++;
    }
  }
}

// ---------- banco de filtros e MDCT ----------

const C = Float64Array.from(SYNTH_WINDOW, (d) => d / 32); // janela de análise
const M = new Float64Array(32 * 64); // matriz de análise: cos((2k+1)(i−16)π/64)
for (let k = 0; k < 32; k++) for (let i = 0; i < 64; i++) M[k * 64 + i] = Math.cos(((2 * k + 1) * (i - 16) * Math.PI) / 64);
const MDCT_W = Float64Array.from({ length: 36 }, (_, i) => Math.sin((Math.PI / 36) * (i + 0.5)));
const MDCT_COS = new Float64Array(18 * 36);
for (let k = 0; k < 18; k++) for (let n = 0; n < 36; n++) MDCT_COS[k * 36 + n] = Math.cos((Math.PI / 72) * (2 * n + 1 + 18) * (2 * k + 1));
const CI = [-0.6, -0.535, -0.33, -0.185, -0.095, -0.041, -0.0142, -0.0037];
const CS = CI.map((c) => 1 / Math.sqrt(1 + c * c));
const CA = CI.map((c) => c / Math.sqrt(1 + c * c));
/** A MDCT de 36 pontos sem normalização ganha N/4 = 9 em relação à IMDCT do decodificador. */
const SCALE = 1 / 9;

/** Estado de um canal entre quadros: a fila do banco de filtros e as sub-bandas do grânulo anterior. */
class Channel {
  x = new Float64Array(512);
  prev = new Float64Array(32 * 18); // [banda][18] do grânulo anterior
  sb = new Float64Array(32 * 18);
  /** 576 coeficientes do grânulo a partir de 576 amostras (escala do padrão: ±1 = fundo de escala). */
  granule(pcm: Float32Array, off: number, out: Float64Array) {
    const x = this.x, sb = this.sb;
    const y = new Float64Array(64);
    for (let t = 0; t < 18; t++) {
      // entram 32 amostras novas (a mais nova em x[0])
      x.copyWithin(32, 0, 480);
      for (let i = 31; i >= 0; i--) {
        const j = off + t * 32 + (31 - i);
        x[i] = j < pcm.length ? pcm[j] : 0;
      }
      y.fill(0);
      for (let i = 0; i < 64; i++) {
        let s = 0;
        for (let j = 0; j < 8; j++) s += C[i + 64 * j] * x[i + 64 * j];
        y[i] = s;
      }
      for (let k = 0; k < 32; k++) {
        let s = 0;
        const row = k * 64;
        for (let i = 0; i < 64; i++) s += M[row + i] * y[i];
        // inversão de frequência: nas sub-bandas ímpares, as amostras ímpares trocam de sinal
        sb[k * 18 + t] = k & 1 && t & 1 ? -s : s;
      }
    }
    // MDCT de cada sub-banda sobre o grânulo anterior + o atual
    const z = new Float64Array(36);
    for (let k = 0; k < 32; k++) {
      for (let n = 0; n < 18; n++) {
        z[n] = this.prev[k * 18 + n] * MDCT_W[n];
        z[n + 18] = sb[k * 18 + n] * MDCT_W[n + 18];
      }
      for (let m = 0; m < 18; m++) {
        let s = 0;
        for (let n = 0; n < 36; n++) s += z[n] * MDCT_COS[m * 36 + n];
        out[k * 18 + m] = s * SCALE;
      }
    }
    this.prev.set(sb);
    // redução de aliasing entre sub-bandas vizinhas
    for (let k = 1; k < 32; k++) {
      for (let i = 0; i < 8; i++) {
        const a = k * 18 - 1 - i, b = k * 18 + i;
        const bu = out[a], bd = out[b];
        out[a] = bu * CS[i] + bd * CA[i];
        out[b] = bd * CS[i] - bu * CA[i];
      }
    }
  }
}

// ---------- quantização e Huffman ----------

/** Tabelas candidatas por valor máximo (sem linbits) e as de linbits (16–23 usam a 16; 24–31, a 24). */
const SMALL: [number, number][] = [[1, 1], [2, 2], [3, 2], [5, 3], [6, 3], [7, 5], [8, 5], [9, 5], [10, 7], [11, 7], [12, 7], [13, 15], [15, 15]];
const LINBITS: Record<number, number> = { 16: 1, 17: 2, 18: 3, 19: 4, 20: 6, 21: 8, 22: 10, 23: 13, 24: 4, 25: 5, 26: 6, 27: 7, 28: 8, 29: 9, 30: 11, 31: 13 };
const tableOf = (t: number): HuffTable => HUFF[t >= 24 ? 24 : t >= 16 ? 16 : t];

/** Bits para codificar os pares [a, b) com a tabela t. */
function pairBits(ix: Int32Array, a: number, b: number, t: number): number {
  if (t === 0) return 0;
  const h = tableOf(t), xl = h.xlen, lb = LINBITS[t] ?? 0;
  let bits = 0;
  for (let i = a; i < b; i += 2) {
    let x = ix[i], y = ix[i + 1];
    if (lb) {
      if (x >= 15) {
        bits += lb;
        x = 15;
      }
      if (y >= 15) {
        bits += lb;
        y = 15;
      }
    }
    bits += h.len[x * xl + y] + (x ? 1 : 0) + (y ? 1 : 0);
  }
  return bits;
}

/** A tabela mais econômica para os pares [a, b) e quantos bits ela gasta. */
function bestTable(ix: Int32Array, a: number, b: number): [number, number] {
  let max = 0;
  for (let i = a; i < b; i++) if (ix[i] > max) max = ix[i];
  if (max === 0) return [0, 0];
  let best = -1, bits = Infinity;
  if (max <= 15) {
    for (const [t, m] of SMALL) {
      if (m < max) continue;
      const n = pairBits(ix, a, b, t);
      if (n < bits) [best, bits] = [t, n];
    }
  } else {
    for (const t of [16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31]) {
      if (15 + (1 << LINBITS[t]) - 1 < max) continue;
      const n = pairBits(ix, a, b, t);
      if (n < bits) [best, bits] = [t, n];
      // dentro de cada família, o primeiro que cabe é o mais barato
      if (t === 23 || t === 31) continue;
    }
  }
  return [best, bits];
}

interface GranuleInfo {
  ix: Int32Array; // magnitudes quantizadas
  sign: Uint8Array;
  globalGain: number;
  bigValues: number;
  count1: number;
  tables: [number, number, number];
  region0: number;
  region1: number;
  count1Table: 0 | 1;
  bits: number;
}

/** Divide os big values em 3 regiões pelos limites das bandas e acha tabelas e bits. */
function layout(ix: Int32Array, sfb: number[]): Omit<GranuleInfo, 'ix' | 'sign' | 'globalGain'> {
  // fim dos não-zeros (em pares) e a região de quádruplas (valores ≤ 1)
  let i = 576;
  while (i > 1 && !ix[i - 1] && !ix[i - 2]) i -= 2;
  let count1 = 0;
  while (i > 3 && ix[i - 1] <= 1 && ix[i - 2] <= 1 && ix[i - 3] <= 1 && ix[i - 4] <= 1) {
    count1++;
    i -= 4;
  }
  const big = i; // coeficientes nos big values
  // regiões: a 1ª até a banda region0+1, a 2ª até region0+region1+2 (como o decodificador lê)
  let best: [number, number, [number, number, number], number] | null = null;
  for (const r0 of [3, 5, 7, 9]) {
    for (const r1 of [3, 5, 7]) {
      const s1 = Math.min(big, sfb[Math.min(22, r0 + 1)]);
      const s2 = Math.min(big, sfb[Math.min(22, r0 + r1 + 2)]);
      const [t0, b0] = bestTable(ix, 0, s1);
      const [t1, b1] = bestTable(ix, s1, s2);
      const [t2, b2] = bestTable(ix, s2, big);
      const total = b0 + b1 + b2;
      if (!best || total < best[3]) best = [r0, r1, [t0 < 0 ? 0 : t0, t1 < 0 ? 0 : t1, t2 < 0 ? 0 : t2], total];
    }
  }
  const [region0, region1, tables, bigBits] = best!;
  // quádruplas: tabela A ou B (a que gastar menos)
  let qa = 0, qb = 0;
  for (let q = big; q < big + count1 * 4; q += 4) {
    const v = (ix[q] << 3) | (ix[q + 1] << 2) | (ix[q + 2] << 1) | ix[q + 3];
    const signs = ix[q] + ix[q + 1] + ix[q + 2] + ix[q + 3];
    qa += QUAD_A.len[v] + signs;
    qb += QUAD_B.len[v] + signs;
  }
  const count1Table: 0 | 1 = qb < qa ? 1 : 0;
  return { bigValues: big / 2, count1, tables, region0, region1, count1Table, bits: bigBits + Math.min(qa, qb) };
}

/** Quantiza com o ganho global gg (|xr| = ix^(4/3) · 2^((gg − 210)/4)). Devolve false se estourar. */
function quantize(xr: Float64Array, gg: number, ix: Int32Array): boolean {
  const step = Math.pow(2, -(gg - 210) / 4 * 0.75);
  for (let i = 0; i < 576; i++) {
    const v = Math.floor(Math.pow(Math.abs(xr[i]), 0.75) * step + 0.4054);
    if (v > 8206) return false;
    ix[i] = v;
  }
  return true;
}

/** Acha o menor ganho global (mais qualidade) que cabe em `budget` bits. */
function encodeGranule(xr: Float64Array, budget: number, sfb: number[]): GranuleInfo {
  const ix = new Int32Array(576);
  const sign = new Uint8Array(576);
  for (let i = 0; i < 576; i++) sign[i] = xr[i] < 0 ? 1 : 0;
  let lo = 0, hi = 255;
  let best: GranuleInfo | null = null;
  while (lo <= hi) {
    const gg = (lo + hi) >> 1;
    if (quantize(xr, gg, ix)) {
      const l = layout(ix, sfb);
      if (l.bits <= budget) {
        best = { ix: ix.slice(), sign, globalGain: gg, ...l };
        hi = gg - 1;
        continue;
      }
    }
    lo = gg + 1;
  }
  if (!best) {
    // nem com o ganho máximo coube: silêncio neste grânulo
    ix.fill(0);
    best = { ix, sign, globalGain: 255, ...layout(ix, sfb) };
  }
  return best;
}

function writeHuffman(w: BitWriter, g: GranuleInfo, sfb: number[]) {
  const big = g.bigValues * 2;
  const s1 = Math.min(big, sfb[Math.min(22, g.region0 + 1)]);
  const s2 = Math.min(big, sfb[Math.min(22, g.region0 + g.region1 + 2)]);
  const { ix, sign } = g;
  for (let i = 0; i < big; i += 2) {
    const t = i < s1 ? g.tables[0] : i < s2 ? g.tables[1] : g.tables[2];
    if (t === 0) continue;
    const h = tableOf(t), lb = LINBITS[t] ?? 0;
    const x = ix[i], y = ix[i + 1];
    const cx = lb && x >= 15 ? 15 : x, cy = lb && y >= 15 ? 15 : y;
    w.put(h.code[cx * h.xlen + cy], h.len[cx * h.xlen + cy]);
    if (lb && x >= 15) w.put(x - 15, lb);
    if (x) w.put(sign[i], 1);
    if (lb && y >= 15) w.put(y - 15, lb);
    if (y) w.put(sign[i + 1], 1);
  }
  const q = g.count1Table ? QUAD_B : QUAD_A;
  for (let i = big; i < big + g.count1 * 4; i += 4) {
    const v = (ix[i] << 3) | (ix[i + 1] << 2) | (ix[i + 2] << 1) | ix[i + 3];
    w.put(q.code[v], q.len[v]);
    for (let k = 0; k < 4; k++) if (ix[i + k]) w.put(sign[i + k], 1);
  }
}

// ---------- quadros ----------

/**
 * Codifica áudio em MP3 (canais de -1 a 1). Taxas de amostragem: 32000, 44100 ou 48000 Hz; 1 ou 2 canais.
 * `onProgress` recebe 0..1; a função cede a vez de tempos em tempos para a interface não travar.
 */
export async function encodeMp3(chans: Float32Array[], sampleRate: number, kbps: Mp3Kbps = 320, onProgress?: (p: number) => void): Promise<Blob> {
  const srIdx = SR_INDEX[sampleRate];
  if (srIdx === undefined) throw new Error(`MP3 não aceita ${sampleRate} Hz`);
  const nch = Math.min(2, chans.length);
  const stereo = nch === 2;
  const sfb = SFB_LONG[sampleRate];
  const brIdx = BITRATES.indexOf(kbps);
  const sideBytes = stereo ? 32 : 17;
  // corte dos agudos: o que a taxa não comporta vira ruído; melhor não gastar bits com isso
  const cutHz = kbps >= 256 ? 19500 : kbps >= 192 ? 18500 : kbps >= 160 ? 17000 : 16000;
  const cutBin = Math.min(576, Math.ceil((cutHz / (sampleRate / 2)) * 576));

  const channels = Array.from({ length: nch }, () => new Channel());
  const len = chans[0].length;
  // o banco de filtros + MDCT atrasam 576 amostras: um grânulo a mais no fim para não perder o final
  const frames = Math.ceil((len + 576) / 1152);
  const out: Uint8Array[] = [];
  const perFrame = (144 * kbps * 1000) / sampleRate;
  let acc = 0;
  const xr = [new Float64Array(576), new Float64Array(576)];

  for (let f = 0; f < frames; f++) {
    // tamanho do quadro: o "padding" mantém a taxa exata quando a conta não é inteira (44,1 kHz)
    const base = Math.floor(perFrame);
    acc += perFrame - base;
    const pad = acc >= 1 ? 1 : 0;
    acc -= pad;
    const bytes = base + pad;
    const mainBits = (bytes - 4 - sideBytes) * 8;

    const info: GranuleInfo[][] = [[], []];
    let left = mainBits;
    let todo = 2 * nch;
    for (let gr = 0; gr < 2; gr++) {
      for (let ch = 0; ch < nch; ch++) channels[ch].granule(chans[ch], f * 1152 + gr * 576, xr[ch]);
      if (stereo) {
        // M/S: meio e lado (o lado costuma ser pequeno e gasta poucos bits)
        for (let i = 0; i < 576; i++) {
          const l = xr[0][i], r = xr[1][i];
          xr[0][i] = (l + r) * Math.SQRT1_2;
          xr[1][i] = (l - r) * Math.SQRT1_2;
        }
      }
      for (let ch = 0; ch < nch; ch++) {
        xr[ch].fill(0, cutBin);
        // os bits que sobram de um grânulo ficam para os seguintes do mesmo quadro
        const g = encodeGranule(xr[ch], Math.floor(left / todo), sfb);
        info[gr][ch] = g;
        left -= g.bits;
        todo--;
      }
    }

    const w = new BitWriter(bytes);
    // cabeçalho
    w.put(0x7ff, 11); // sincronismo
    w.put(3, 2); // MPEG-1
    w.put(1, 2); // Layer III
    w.put(1, 1); // sem CRC
    w.put(brIdx, 4);
    w.put(srIdx, 2);
    w.put(pad, 1);
    w.put(0, 1); // privado
    w.put(stereo ? 1 : 3, 2); // joint stereo (M/S) ou mono
    w.put(stereo ? 2 : 0, 2); // extensão: M/S ligado, intensidade desligada
    w.put(0, 1); // copyright
    w.put(1, 1); // original
    w.put(0, 2); // ênfase
    // informação lateral
    w.put(0, 9); // main_data_begin: sem reservatório
    w.put(0, stereo ? 3 : 5);
    for (let ch = 0; ch < nch; ch++) w.put(0, 4); // scfsi
    for (let gr = 0; gr < 2; gr++) {
      for (let ch = 0; ch < nch; ch++) {
        const g = info[gr][ch];
        w.put(g.bits, 12); // part2_3_length (sem fatores de escala: só os códigos)
        w.put(g.bigValues, 9);
        w.put(g.globalGain, 8);
        w.put(0, 4); // scalefac_compress
        w.put(0, 1); // blocos longos
        for (const t of g.tables) w.put(t, 5);
        w.put(g.region0, 4);
        w.put(g.region1, 3);
        w.put(0, 1); // preflag
        w.put(0, 1); // scalefac_scale
        w.put(g.count1Table, 1);
      }
    }
    for (let gr = 0; gr < 2; gr++) for (let ch = 0; ch < nch; ch++) writeHuffman(w, info[gr][ch], sfb);
    out.push(w.buf);

    if (f % 40 === 0) {
      onProgress?.(f / frames);
      await new Promise((r) => setTimeout(r, 0));
    }
  }
  onProgress?.(1);
  return new Blob(out as BlobPart[], { type: 'audio/mpeg' });
}
