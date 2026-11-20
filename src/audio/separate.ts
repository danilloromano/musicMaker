// Separação de instrumentos sem IA, com técnicas clássicas de processamento de sinal:
//
// • Bateria: separação harmônico/percussivo (HPSS, Fitzgerald 2010). No espectrograma, o que é percussivo
//   é uma linha vertical (energia em todas as frequências num instante) e o que é tonal é uma linha
//   horizontal (uma frequência que dura). A mediana ao longo do tempo realça o tonal; ao longo das
//   frequências, o percussivo; a proporção entre as duas vira uma máscara suave.
// • Baixo: a parte tonal abaixo de ~220 Hz.
// • Voz: a parte tonal entre ~120 Hz e 8 kHz que está no centro do estéreo — em cada frequência, quanto
//   mais esquerda e direita são iguais, mais aquilo está no meio (onde a voz costuma ser mixada).
// • Resto: a música menos as três (calculado na hora de misturar), então somar tudo dá o original.
//
// Processa em fluxo (STFT de 4096 pontos, salto de 1024), guardando só as 17 janelas da mediana: memória
// pequena mesmo para músicas longas. Puro (sem DOM): roda no worker de separate.worker.ts.

const N = 4096;
const HOP = 1024;
const HALF = N / 2 + 1;
const MED_T = 31; // janelas da mediana no tempo (~0,7 s)
const MED_F = 17; // faixas da mediana nas frequências
const MARGIN = 2;

/** FFT complexa in-place (raiz 2), com tabelas prontas para N. */
class FFT {
  private rev: Uint32Array;
  private cos: Float64Array;
  private sin: Float64Array;
  private n: number;
  constructor(n: number) {
    this.n = n;
    const bits = Math.log2(n);
    this.rev = new Uint32Array(n);
    for (let i = 0; i < n; i++) {
      let r = 0;
      for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
      this.rev[i] = r;
    }
    this.cos = new Float64Array(n / 2);
    this.sin = new Float64Array(n / 2);
    for (let i = 0; i < n / 2; i++) {
      this.cos[i] = Math.cos((2 * Math.PI * i) / n);
      this.sin[i] = Math.sin((2 * Math.PI * i) / n);
    }
  }
  /** inverse = true faz a transformada inversa (sem dividir por n). */
  run(re: Float64Array, im: Float64Array, inverse = false) {
    const n = this.n;
    for (let i = 0; i < n; i++) {
      const j = this.rev[i];
      if (j > i) {
        let t = re[i];
        re[i] = re[j];
        re[j] = t;
        t = im[i];
        im[i] = im[j];
        im[j] = t;
      }
    }
    const sgn = inverse ? 1 : -1;
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1;
      const step = n / size;
      for (let start = 0; start < n; start += size) {
        for (let k = 0; k < half; k++) {
          const wr = this.cos[k * step];
          const wi = sgn * this.sin[k * step];
          const a = start + k, b = a + half;
          const tr = re[b] * wr - im[b] * wi;
          const ti = re[b] * wi + im[b] * wr;
          re[b] = re[a] - tr;
          im[b] = im[a] - ti;
          re[a] += tr;
          im[a] += ti;
        }
      }
    }
  }
}

/** Mediana de um vetor pequeno (copia e ordena: com 17 valores é barato). */
function median(buf: Float64Array, tmp: Float64Array, len: number): number {
  for (let i = 0; i < len; i++) tmp[i] = buf[i];
  const t = tmp.subarray(0, len).sort();
  return t[len >> 1];
}

export interface Stems {
  /** bateria em estéreo */
  drumsL: Float32Array;
  drumsR: Float32Array;
  /** baixo e voz em mono (graves e o centro do estéreo não têm lado) */
  bass: Float32Array;
  vocals: Float32Array;
}

/**
 * Separa \`L\` e \`R\` (mono: passe o mesmo canal nos dois — a voz então não se separa dos outros
 * instrumentos, que também estão "no centro"). \`onProgress\` recebe 0..1.
 */
export function separate(L: Float32Array, R: Float32Array, sampleRate: number, onProgress?: (p: number) => void): Stems {
  const len = L.length;
  const fft = new FFT(N);
  const win = new Float64Array(N);
  for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N);
  const norm = 1 / 1.5; // Hann com 75% de sobreposição, janela na análise e na síntese: soma 1,5

  const out: Stems = {
    drumsL: new Float32Array(len),
    drumsR: new Float32Array(len),
    bass: new Float32Array(len),
    vocals: new Float32Array(len),
  };

  // pesos por frequência: graves (baixo) e faixa da voz
  const binHz = sampleRate / N;
  const low = new Float64Array(HALF); // 1 = grave (baixo), 0 = agudo; transição 160–280 Hz
  const voiceBand = new Float64Array(HALF); // faixa da voz: sobe em 120 Hz, desce a partir de 8 kHz
  for (let k = 0; k < HALF; k++) {
    const f = k * binHz;
    low[k] = f <= 160 ? 1 : f >= 280 ? 0 : 0.5 + 0.5 * Math.cos((Math.PI * (f - 160)) / 120);
    voiceBand[k] = f < 120 ? 0 : f < 200 ? (f - 120) / 80 : f > 12000 ? 0 : f > 8000 ? 1 - (f - 8000) / 4000 : 1;
  }

  // janelas guardadas para a mediana no tempo (anel): espectros de L e R e a magnitude
  type Frame = { lr: Float64Array; li: Float64Array; rr: Float64Array; ri: Float64Array; mag: Float64Array; idx: number; pos: number };
  const ring: Frame[] = [];
  const frames = Math.ceil((len + N - HOP) / HOP);
  const re = new Float64Array(N), im = new Float64Array(N);
  const re2 = new Float64Array(N), im2 = new Float64Array(N);
  const col = new Float64Array(Math.max(MED_T, MED_F));
  const tmp = new Float64Array(Math.max(MED_T, MED_F));
  const timeMed = new Float64Array(HALF);

  /** a janela t começa em t·HOP − (N − HOP): a primeira já cobre o começo do áudio */
  const analyse = (idx: number): Frame => {
    const pos = idx * HOP - (N - HOP);
    // L e R juntos numa FFT complexa (L no real, R no imaginário)
    for (let i = 0; i < N; i++) {
      const j = pos + i;
      const w = win[i];
      re[i] = j >= 0 && j < len ? L[j] * w : 0;
      im[i] = j >= 0 && j < len ? R[j] * w : 0;
    }
    fft.run(re, im);
    const f: Frame = { lr: new Float64Array(HALF), li: new Float64Array(HALF), rr: new Float64Array(HALF), ri: new Float64Array(HALF), mag: new Float64Array(HALF), idx, pos };
    for (let k = 0; k < HALF; k++) {
      const nk = (N - k) % N;
      // separa os dois espectros reais: X = (Z[k] + conj Z[N−k]) / 2, Y = (Z[k] − conj Z[N−k]) / 2i
      const lr = (re[k] + re[nk]) / 2, li = (im[k] - im[nk]) / 2;
      const rr = (im[k] + im[nk]) / 2, ri = (re[nk] - re[k]) / 2;
      f.lr[k] = lr;
      f.li[k] = li;
      f.rr[k] = rr;
      f.ri[k] = ri;
      f.mag[k] = (Math.hypot(lr, li) + Math.hypot(rr, ri)) / 2;
    }
    return f;
  };

  /** Monta o espectro hermitiano de dois sinais reais (a no real, b no imaginário) e volta ao tempo. */
  const synth = (
    ar: Float64Array, ai: Float64Array, br: Float64Array, bi: Float64Array,
    pos: number, outA: Float32Array, outB: Float32Array,
  ) => {
    for (let k = 0; k < HALF; k++) {
      // Z = A + iB
      re2[k] = ar[k] - bi[k];
      im2[k] = ai[k] + br[k];
      if (k > 0 && k < N / 2) {
        // Z[N−k] = conj(A) + i conj(B)
        re2[N - k] = ar[k] + bi[k];
        im2[N - k] = -ai[k] + br[k];
      }
    }
    fft.run(re2, im2, true);
    for (let i = 0; i < N; i++) {
      const j = pos + i;
      if (j < 0 || j >= len) continue;
      const w = win[i] * norm / N;
      outA[j] += re2[i] * w;
      outB[j] += im2[i] * w;
    }
  };

  const dL = new Float64Array(HALF), dLi = new Float64Array(HALF), dR = new Float64Array(HALF), dRi = new Float64Array(HALF);
  const bR = new Float64Array(HALF), bI = new Float64Array(HALF), vR = new Float64Array(HALF), vI = new Float64Array(HALF);

  /** Separa a janela do meio do anel. */
  const process = (f: Frame) => {
    // mediana no tempo (tonal), por frequência
    for (let k = 0; k < HALF; k++) {
      for (let t = 0; t < ring.length; t++) col[t] = ring[t].mag[k];
      timeMed[k] = median(col, tmp, ring.length);
    }
    const h = MED_F >> 1;
    for (let k = 0; k < HALF; k++) {
      // mediana nas frequências (percussivo)
      const a = Math.max(0, k - h), b = Math.min(HALF - 1, k + h);
      for (let i = a; i <= b; i++) col[i - a] = f.mag[i];
      const P = median(col, tmp, b - a + 1);
      const H = timeMed[k];
      const p2 = P * P, h2 = H * H;
      // margem: só é percussivo se superar o tonal com folga (sem ela, voz e acordes vazavam para a bateria)
      const mP = p2 + h2 > 1e-20 ? p2 / (p2 + MARGIN * MARGIN * h2) : 0;
      const mH = 1 - mP;
      // centro do estéreo: 1 quando esquerda = direita, 0 quando só de um lado ou fora de fase
      const dr = f.lr[k] - f.rr[k], di = f.li[k] - f.ri[k];
      const sum = Math.hypot(f.lr[k], f.li[k]) + Math.hypot(f.rr[k], f.ri[k]);
      const c = sum > 1e-12 ? Math.max(0, 1 - Math.hypot(dr, di) / sum) : 0;
      const center = c * c;
      const mB = mH * low[k];
      const mV = mH * (1 - low[k]) * voiceBand[k] * center;
      dL[k] = f.lr[k] * mP;
      dLi[k] = f.li[k] * mP;
      dR[k] = f.rr[k] * mP;
      dRi[k] = f.ri[k] * mP;
      const mr = (f.lr[k] + f.rr[k]) / 2, mi = (f.li[k] + f.ri[k]) / 2;
      bR[k] = mr * mB;
      bI[k] = mi * mB;
      vR[k] = mr * mV;
      vI[k] = mi * mV;
    }
    synth(dL, dLi, dR, dRi, f.pos, out.drumsL, out.drumsR);
    synth(bR, bI, vR, vI, f.pos, out.bass, out.vocals);
  };

  // para separar a janela t, a mediana no tempo usa as janelas t−8…t+8 (menos nas pontas da música)
  const reach = MED_T >> 1;
  let next = 0;
  for (let t = 0; t < frames; t++) {
    while (next < frames && next <= t + reach) ring.push(analyse(next++));
    while (ring.length && ring[0].idx < t - reach) ring.shift();
    process(ring[t - ring[0].idx]);
    if (onProgress && t % 200 === 0) onProgress(t / frames);
  }
  return out;
}
