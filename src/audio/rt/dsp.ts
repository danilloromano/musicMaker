// Blocos de DSP amostra a amostra, sem navegador, para o motor de baixa latência (electron/host). Cada um
// reproduz o nó do Web Audio que o rack do app usa (mesmas fórmulas da especificação), para o som monitorado
// ser o mesmo da trilha. Nada aloca memória durante o processamento: os buffers são criados na montagem.

/** Parâmetro com suavização, como o `setTargetAtTime(v, t, 0.015)` do rack do app (constante de 15 ms). */
export class Param {
  prev: number;
  value: number;
  target: number;
  constructor(v: number) {
    this.prev = this.value = this.target = v;
  }
  /** snap = muda na hora (montagem do rack) */
  set(v: number, snap = false) {
    this.target = v;
    if (snap) this.prev = this.value = v;
  }
  /** avança um bloco; k = 1 - e^(-bloco/(τ·taxa)) */
  tick(k: number) {
    this.prev = this.value;
    const d = this.target - this.value;
    this.value = Math.abs(d) <= 1e-7 * (Math.abs(this.target) + 1e-3) ? this.target : this.value + d * k;
  }
  get moving() {
    return this.prev !== this.value;
  }
}

/** Ganho aplicado no bloco, com interpolação linear entre o valor do bloco anterior e o atual (sem degraus). */
export function applyGain(buf: Float64Array, n: number, p: Param) {
  const a = p.prev, b = p.value;
  if (a === b) {
    if (b !== 1) for (let i = 0; i < n; i++) buf[i] *= b;
    return;
  }
  const d = (b - a) / n;
  for (let i = 0; i < n; i++) buf[i] *= a + d * (i + 1);
}

export type BiquadType = 'lowpass' | 'highpass' | 'peaking' | 'lowshelf' | 'highshelf';

/**
 * Biquad com as fórmulas do BiquadFilterNode (especificação Web Audio): nos passa-baixas e passa-altas o Q é em
 * dB, nos peaking em escala linear e as prateleiras ignoram o Q (inclinação S = 1).
 */
export class Biquad {
  b0 = 1; b1 = 0; b2 = 0; a1 = 0; a2 = 0;
  z1 = 0; z2 = 0;
  constructor(private sr: number, type?: BiquadType, f = 350, q = Math.SQRT1_2, db = 0) {
    if (type) this.set(type, f, q, db);
  }
  set(type: BiquadType, f: number, q = Math.SQRT1_2, db = 0) {
    const nyq = this.sr / 2;
    const fn = Math.min(1, Math.max(0, f / nyq));
    const A = 10 ** (db / 40);
    // nas pontas (0 Hz ou Nyquist) o nó do navegador vira um ganho fixo
    if (fn >= 1 || fn <= 0) {
      const top = fn >= 1;
      const g = type === 'lowpass' ? (top ? 1 : 0) : type === 'highpass' ? (top ? 0 : 1)
        : type === 'lowshelf' ? (top ? A * A : 1) : type === 'highshelf' ? (top ? 1 : A * A) : 1;
      return this.coef(g, 0, 0, 1, 0, 0);
    }
    const w = Math.PI * fn, cos = Math.cos(w), sin = Math.sin(w);
    switch (type) {
      case 'lowpass': {
        const al = sin / (2 * 10 ** (q / 20));
        return this.coef((1 - cos) / 2, 1 - cos, (1 - cos) / 2, 1 + al, -2 * cos, 1 - al);
      }
      case 'highpass': {
        const al = sin / (2 * 10 ** (q / 20));
        return this.coef((1 + cos) / 2, -(1 + cos), (1 + cos) / 2, 1 + al, -2 * cos, 1 - al);
      }
      case 'peaking': {
        const al = sin / (2 * q);
        return this.coef(1 + al * A, -2 * cos, 1 - al * A, 1 + al / A, -2 * cos, 1 - al / A);
      }
      case 'lowshelf': {
        const k = 2 * Math.sqrt(A) * (sin / 2) * Math.SQRT2;
        return this.coef(
          A * (A + 1 - (A - 1) * cos + k), 2 * A * (A - 1 - (A + 1) * cos), A * (A + 1 - (A - 1) * cos - k),
          A + 1 + (A - 1) * cos + k, -2 * (A - 1 + (A + 1) * cos), A + 1 + (A - 1) * cos - k,
        );
      }
      case 'highshelf': {
        const k = 2 * Math.sqrt(A) * (sin / 2) * Math.SQRT2;
        return this.coef(
          A * (A + 1 + (A - 1) * cos + k), -2 * A * (A - 1 + (A + 1) * cos), A * (A + 1 + (A - 1) * cos - k),
          A + 1 - (A - 1) * cos + k, 2 * (A - 1 - (A + 1) * cos), A + 1 - (A - 1) * cos - k,
        );
      }
    }
  }
  /** Coeficientes do livro de receitas com Q linear (filtros internos, como o antialias do oversampling). */
  setRaw(type: 'lowpass', f: number, qLinear: number) {
    const w = (2 * Math.PI * f) / this.sr, cos = Math.cos(w), al = Math.sin(w) / (2 * qLinear);
    this.coef((1 - cos) / 2, 1 - cos, (1 - cos) / 2, 1 + al, -2 * cos, 1 - al);
    return this;
  }
  private coef(b0: number, b1: number, b2: number, a0: number, a1: number, a2: number) {
    this.b0 = b0 / a0; this.b1 = b1 / a0; this.b2 = b2 / a0; this.a1 = a1 / a0; this.a2 = a2 / a0;
  }
  tick(x: number) {
    const y = this.b0 * x + this.z1;
    this.z1 = this.b1 * x - this.a1 * y + this.z2;
    this.z2 = this.b2 * x - this.a2 * y;
    return y;
  }
  run(buf: Float64Array, n: number) {
    const { b0, b1, b2, a1, a2 } = this;
    let z1 = this.z1, z2 = this.z2;
    for (let i = 0; i < n; i++) {
      const x = buf[i];
      const y = b0 * x + z1;
      z1 = b1 * x - a1 * y + z2;
      z2 = b2 * x - a2 * y;
      buf[i] = y;
    }
    this.z1 = z1; this.z2 = z2;
  }
}

/** Biquad com frequência/ganho que mudam (suavizados): recalcula os coeficientes só enquanto o botão se move. */
export class VarBiquad {
  readonly f: Param;
  readonly db: Param;
  readonly bq: Biquad;
  constructor(sr: number, private type: BiquadType, f: number, private q = Math.SQRT1_2, db = 0) {
    this.f = new Param(f);
    this.db = new Param(db);
    this.bq = new Biquad(sr, type, f, q, db);
    this.lastF = f;
    this.lastDb = db;
  }
  params() {
    return [this.f, this.db];
  }
  private lastF: number;
  private lastDb: number;
  /** Atualiza os coeficientes se a frequência ou o ganho mudaram desde o último bloco. */
  update() {
    if (this.f.value === this.lastF && this.db.value === this.lastDb) return;
    this.lastF = this.f.value;
    this.lastDb = this.db.value;
    this.bq.set(this.type, this.lastF, this.q, this.lastDb);
  }
  run(buf: Float64Array, n: number) {
    this.update();
    this.bq.run(buf, n);
  }
}

/** Passa-altas de 1ª ordem (o `highpass1` do rack: IIRFilterNode com um capacitor e um resistor). */
export class Highpass1 {
  private b0: number; private a1: number; private x1 = 0; private y1 = 0;
  constructor(sr: number, fc: number) {
    const k = Math.tan((Math.PI * fc) / sr);
    this.b0 = 1 / (1 + k);
    this.a1 = (k - 1) / (1 + k);
  }
  run(buf: Float64Array, n: number) {
    const { b0, a1 } = this;
    let x1 = this.x1, y1 = this.y1;
    for (let i = 0; i < n; i++) {
      const x = buf[i];
      const y = b0 * x - b0 * x1 - a1 * y1;
      x1 = x; y1 = y;
      buf[i] = y;
    }
    this.x1 = x1; this.y1 = y1;
  }
}

/** IIR de 3ª ordem (o tone stack), forma direta II transposta. */
export class Iir3 {
  private z0 = 0; private z1 = 0; private z2 = 0;
  b = [1, 0, 0, 0];
  a = [1, 0, 0, 0];
  setCoefs(b: number[], a: number[]) {
    this.b = [b[0] ?? 0, b[1] ?? 0, b[2] ?? 0, b[3] ?? 0];
    this.a = [1, a[1] ?? 0, a[2] ?? 0, a[3] ?? 0];
  }
  reset() {
    this.z0 = this.z1 = this.z2 = 0;
  }
  copyState(o: Iir3) {
    this.z0 = o.z0; this.z1 = o.z1; this.z2 = o.z2;
  }
  tick(x: number) {
    const b = this.b, a = this.a;
    const y = b[0] * x + this.z0;
    this.z0 = b[1] * x - a[1] * y + this.z1;
    this.z1 = b[2] * x - a[2] * y + this.z2;
    this.z2 = b[3] * x - a[3] * y;
    return y;
  }
}

/**
 * Curva de saturação como o WaveShaperNode: tabela de -1 a 1 com interpolação linear (entradas fora da faixa
 * ficam no ponto da ponta) e, se pedido, oversampling 4x com filtros antialias de 6ª ordem na subida e na descida.
 */
export class Shaper {
  private up: Biquad[] = [];
  private down: Biquad[] = [];
  private last: number;
  constructor(private table: Float32Array, sr: number, private os4 = false) {
    this.last = table.length - 1;
    if (os4) {
      // Butterworth de 6ª ordem em 0,45 da taxa original, rodando a 4x a taxa
      const mk = () => [0.5176, Math.SQRT1_2, 1.9319].map((q) => new Biquad(4 * sr).setRaw('lowpass', 0.45 * sr, q));
      this.up = mk();
      this.down = mk();
    }
  }
  /** Uma amostra pela tabela, sem oversampling (curvas de controle, como as do noise gate). */
  tick(x: number) {
    const t = this.table, last = this.last;
    const v = last * 0.5 * (x + 1);
    if (!(v > 0)) return t[0];
    if (v >= last) return t[last];
    const k = v | 0, f = v - k;
    return t[k] + (t[k + 1] - t[k]) * f;
  }
  run(buf: Float64Array, n: number) {
    if (!this.os4) {
      for (let i = 0; i < n; i++) buf[i] = this.tick(buf[i]);
      return;
    }
    const [u0, u1, u2] = this.up, [d0, d1, d2] = this.down;
    for (let i = 0; i < n; i++) {
      let y = 0;
      for (let k = 0; k < 4; k++) {
        // zeros entre as amostras (ganho 4 para manter o nível) → antialias → curva → antialias
        const u = u2.tick(u1.tick(u0.tick(k === 0 ? 4 * buf[i] : 0)));
        y = d2.tick(d1.tick(d0.tick(this.tick(u))));
      }
      buf[i] = y;
    }
  }
}

/** FFT complexa radix-2 no lugar, de tamanho fixo. */
class FFT {
  private cos: Float64Array; private sin: Float64Array; private rev: Uint32Array;
  constructor(readonly n: number) {
    this.cos = new Float64Array(n / 2);
    this.sin = new Float64Array(n / 2);
    for (let i = 0; i < n / 2; i++) {
      this.cos[i] = Math.cos((2 * Math.PI * i) / n);
      this.sin[i] = -Math.sin((2 * Math.PI * i) / n);
    }
    this.rev = new Uint32Array(n);
    const bits = Math.log2(n);
    for (let i = 0; i < n; i++) {
      let r = 0;
      for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
      this.rev[i] = r;
    }
  }
  run(re: Float64Array, im: Float64Array, inverse: boolean) {
    const { n, rev, cos, sin } = this;
    for (let i = 0; i < n; i++) {
      const j = rev[i];
      if (j > i) {
        let t = re[i]; re[i] = re[j]; re[j] = t;
        t = im[i]; im[i] = im[j]; im[j] = t;
      }
    }
    const sg = inverse ? -1 : 1;
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1, step = n / size;
      for (let i = 0; i < n; i += size) {
        for (let j = 0; j < half; j++) {
          const wr = cos[j * step], wi = sg * sin[j * step];
          const a = i + j, b = a + half;
          const xr = re[b] * wr - im[b] * wi, xi = re[b] * wi + im[b] * wr;
          re[b] = re[a] - xr; im[b] = im[a] - xi;
          re[a] += xr; im[a] += xi;
        }
      }
    }
    if (inverse) for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
  }
}

/**
 * Convolução particionada uniforme (UPOLS) com partições do tamanho do bloco: nenhuma latência além do próprio
 * bloco, como o ConvolverNode. Sinais reais: só metade do espectro é multiplicada.
 */
export class Convolver {
  private N: number; private P: number; private fft: FFT;
  private Hr: Float64Array[]; private Hi: Float64Array[];
  private Xr: Float64Array[]; private Xi: Float64Array[];
  private pos = 0;
  private hist: Float64Array; private re: Float64Array; private im: Float64Array;
  constructor(ir: Float32Array, private B: number) {
    this.N = 2 * B;
    this.P = Math.max(1, Math.ceil(ir.length / B));
    this.fft = new FFT(this.N);
    const mk = () => Array.from({ length: this.P }, () => new Float64Array(this.N));
    this.Hr = mk(); this.Hi = mk(); this.Xr = mk(); this.Xi = mk();
    for (let p = 0; p < this.P; p++) {
      for (let i = 0; i < B && p * B + i < ir.length; i++) this.Hr[p][i] = ir[p * B + i];
      this.fft.run(this.Hr[p], this.Hi[p], false);
    }
    this.hist = new Float64Array(this.N);
    this.re = new Float64Array(this.N);
    this.im = new Float64Array(this.N);
  }
  /** Convolui um bloco de B amostras de `x` e escreve em `out` (podem ser o mesmo buffer). */
  run(x: Float64Array, out: Float64Array) {
    const { B, N, P, hist, re, im } = this;
    const half = N >> 1;
    hist.copyWithin(0, B);
    for (let i = 0; i < B; i++) hist[B + i] = x[i];
    this.pos = this.pos + 1 === P ? 0 : this.pos + 1;
    const xr = this.Xr[this.pos], xi = this.Xi[this.pos];
    xr.set(hist);
    xi.fill(0);
    this.fft.run(xr, xi, false);
    re.fill(0);
    im.fill(0);
    let k = this.pos;
    for (let p = 0; p < P; p++) {
      const ar = this.Xr[k], ai = this.Xi[k], hr = this.Hr[p], hi = this.Hi[p];
      for (let i = 0; i <= half; i++) {
        re[i] += ar[i] * hr[i] - ai[i] * hi[i];
        im[i] += ar[i] * hi[i] + ai[i] * hr[i];
      }
      k = k === 0 ? P - 1 : k - 1;
    }
    // espectro de sinal real: a outra metade é o conjugado
    for (let i = 1; i < half; i++) {
      re[N - i] = re[i];
      im[N - i] = -im[i];
    }
    this.fft.run(re, im, true);
    for (let i = 0; i < B; i++) out[i] = re[B + i];
  }
}
