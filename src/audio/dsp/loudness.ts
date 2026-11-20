// Medição de loudness no padrão ITU-R BS.1770 / EBU R128 (o que Spotify, YouTube e Apple Music usam
// para nivelar as músicas): filtro K (simula a sensibilidade do ouvido), LUFS momentâneo (400 ms), de
// curto prazo (3 s) e integrado (a música inteira, com as comportas absoluta e relativa do padrão);
// pico real (true peak: os picos entre as amostras, que aparecem na conversão para analógico ou para
// MP3/AAC), por superamostragem 4×; e correlação de fase entre os canais.
// Código puro (sem Web Audio): roda no AudioWorklet do master e na exportação.

/** Biquad em forma direta II transposta. */
class Biquad {
  private z1 = 0;
  private z2 = 0;
  constructor(private b0: number, private b1: number, private b2: number, private a1: number, private a2: number) {}
  tick(x: number) {
    const y = this.b0 * x + this.z1;
    this.z1 = this.b1 * x - this.a1 * y + this.z2;
    this.z2 = this.b2 * x - this.a2 * y;
    return y;
  }
}

/** Filtro K do BS.1770 (prateleira de agudos + passa-altas "RLB"), calculado para qualquer taxa. */
function kWeighting(sr: number): [Biquad, Biquad] {
  let f0 = 1681.974450955533;
  const G = 3.999843853973347;
  let Q = 0.7071752369554196;
  let K = Math.tan((Math.PI * f0) / sr);
  const Vh = 10 ** (G / 20);
  const Vb = Vh ** 0.4996667741545416;
  let a0 = 1 + K / Q + K * K;
  const shelf = new Biquad(
    (Vh + (Vb * K) / Q + K * K) / a0,
    (2 * (K * K - Vh)) / a0,
    (Vh - (Vb * K) / Q + K * K) / a0,
    (2 * (K * K - 1)) / a0,
    (1 - K / Q + K * K) / a0,
  );
  f0 = 38.13547087602444;
  Q = 0.5003270373238773;
  K = Math.tan((Math.PI * f0) / sr);
  a0 = 1 + K / Q + K * K;
  const hp = new Biquad(1, -2, 1, (2 * (K * K - 1)) / a0, (1 - K / Q + K * K) / a0);
  return [shelf, hp];
}

export const lufs = (energy: number) => (energy > 0 ? -0.691 + 10 * Math.log10(energy) : -Infinity);
export const dbfs = (lin: number) => (lin > 0 ? 20 * Math.log10(lin) : -Infinity);

/** Medidor de loudness em fluxo: alimente com blocos estéreo e consulte os valores a qualquer momento. */
export class Loudness {
  private kl: [Biquad, Biquad];
  private kr: [Biquad, Biquad];
  private readonly sub: number;
  private acc = 0;
  private cnt = 0;
  /** energia de cada trecho de 100 ms (os mais recentes) */
  private recent: number[] = [];
  /** energia de cada bloco de 400 ms (passo de 100 ms), para o integrado */
  private blocks: number[] = [];

  constructor(private sr: number) {
    this.kl = kWeighting(sr);
    this.kr = kWeighting(sr);
    this.sub = Math.round(sr / 10);
  }

  reset() {
    this.kl = kWeighting(this.sr);
    this.kr = kWeighting(this.sr);
    this.acc = 0;
    this.cnt = 0;
    this.recent = [];
    this.blocks = [];
  }

  push(l: Float32Array, r: Float32Array, from = 0, to = l.length) {
    const [l1, l2] = this.kl;
    const [r1, r2] = this.kr;
    for (let i = from; i < to; i++) {
      const a = l2.tick(l1.tick(l[i]));
      const b = r2.tick(r1.tick(r[i]));
      this.acc += a * a + b * b;
      if (++this.cnt === this.sub) {
        this.recent.push(this.acc / this.sub);
        if (this.recent.length > 30) this.recent.shift();
        if (this.recent.length >= 4) this.blocks.push(this.mean(4));
        this.acc = 0;
        this.cnt = 0;
      }
    }
  }

  private mean(n: number) {
    const k = Math.min(n, this.recent.length);
    if (!k) return 0;
    let s = 0;
    for (let i = this.recent.length - k; i < this.recent.length; i++) s += this.recent[i];
    return s / k;
  }

  /** LUFS momentâneo (últimos 400 ms) */
  momentary() {
    return lufs(this.mean(4));
  }
  /** LUFS de curto prazo (últimos 3 s) */
  shortTerm() {
    return lufs(this.mean(30));
  }
  /** LUFS integrado: comporta absoluta em -70 LUFS e relativa 10 LU abaixo da média */
  integrated() {
    const abs = this.blocks.filter((e) => lufs(e) > -70);
    if (!abs.length) return -Infinity;
    const rel = lufs(abs.reduce((a, b) => a + b, 0) / abs.length) - 10;
    const gated = abs.filter((e) => lufs(e) > rel);
    return gated.length ? lufs(gated.reduce((a, b) => a + b, 0) / gated.length) : -Infinity;
  }
}

// filtro de interpolação 4× (seno cardinal janelado), em 4 fases de 12 coeficientes
const OS = 4;
const TAPS = 12;
const PHASES: Float64Array[] = (() => {
  const n = OS * TAPS;
  const h = new Float64Array(n);
  const c = (n - 1) / 2;
  for (let k = 0; k < n; k++) {
    const x = (k - c) / OS;
    const sinc = x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x);
    const w = 0.42 - 0.5 * Math.cos((2 * Math.PI * k) / (n - 1)) + 0.08 * Math.cos((4 * Math.PI * k) / (n - 1));
    h[k] = sinc * w;
  }
  return Array.from({ length: OS }, (_, p) => Float64Array.from({ length: TAPS }, (_, j) => h[p + OS * j]));
})();
/** atraso (em amostras) entre uma amostra e o pico real que ela gera na detecção */
export const TRUE_PEAK_DELAY = Math.ceil((OS * TAPS - 1) / 2 / OS);

/** Detector de pico real de um canal: devolve o maior valor absoluto entre as amostras interpoladas. */
export class TruePeak {
  private hist = new Float64Array(TAPS);
  private pos = 0;
  next(x: number): number {
    this.hist[this.pos] = x;
    let peak = 0;
    for (let p = 0; p < OS; p++) {
      const h = PHASES[p];
      let y = 0;
      let idx = this.pos;
      for (let j = 0; j < TAPS; j++) {
        y += h[j] * this.hist[idx];
        idx = idx === 0 ? TAPS - 1 : idx - 1;
      }
      const a = Math.abs(y);
      if (a > peak) peak = a;
    }
    this.pos = (this.pos + 1) % TAPS;
    return peak;
  }
}

/** Correlação de fase (-1 = fora de fase, 0 = sem relação, +1 = mono), com média móvel exponencial. */
export class Correlation {
  private lr = 0;
  private ll = 0;
  private rr = 0;
  private k: number;
  constructor(sr: number, tau = 0.3) {
    this.k = Math.exp(-1 / (sr * tau));
  }
  push(l: Float32Array, r: Float32Array) {
    const k = this.k;
    for (let i = 0; i < l.length; i++) {
      this.lr = k * this.lr + (1 - k) * l[i] * r[i];
      this.ll = k * this.ll + (1 - k) * l[i] * l[i];
      this.rr = k * this.rr + (1 - k) * r[i] * r[i];
    }
  }
  value() {
    const d = Math.sqrt(this.ll * this.rr);
    return d > 1e-10 ? this.lr / d : 0;
  }
}
