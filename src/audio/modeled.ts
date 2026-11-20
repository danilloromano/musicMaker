// Instrumentos modelados fisicamente: Rhodes, Wurlitzer, clavinete e sino. Não há gravações desses
// instrumentos com licença livre, então cada nota é calculada amostra a amostra a partir de um modelo
// do mecanismo real (o que vibra, como decai, como o captador transforma a vibração em sinal elétrico),
// uma vez por nota-base e intensidade, e depois tocada como uma gravação pelo sampler (transposta para as
// notas do meio). O cálculo roda em segundo plano, uma nota por vez, para não travar a tela.

const TAU = Math.PI * 2;

export type ModeledSet = 'rhodes' | 'wurli' | 'clav' | 'bell';

/** Intensidades calculadas (o timbre muda com a força: o captador "rosna", a corda brilha). */
const VELOCITIES = [0.35, 0.7, 1];

interface Model {
  /** notas-base calculadas (as outras são transpostas da mais próxima) */
  keys: number[];
  /** duração calculada (s) para a nota */
  length: (f: number) => number;
  render: (out: Float32Array, sr: number, f: number, v: number, rnd: () => number) => void;
}

function prng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const clamp = (x: number, a: number, b: number) => Math.min(b, Math.max(a, x));
const range = (a: number, b: number, step: number) => Array.from({ length: Math.floor((b - a) / step) + 1 }, (_, i) => a + i * step);

/** Filtro de variáveis de estado (TPT): passa-baixa, passa-banda e passa-alta. */
class Svf {
  private ic1 = 0;
  private ic2 = 0;
  private a1 = 0;
  private a2 = 0;
  private a3 = 0;
  private k = 1;
  lp = 0;
  bp = 0;
  hp = 0;
  constructor(sr: number, fc: number, q = 0.707) {
    const g = Math.tan((Math.PI * Math.min(fc, sr * 0.45)) / sr);
    this.k = 1 / q;
    this.a1 = 1 / (1 + g * (g + this.k));
    this.a2 = g * this.a1;
    this.a3 = g * this.a2;
  }
  tick(x: number) {
    const v3 = x - this.ic2;
    const v1 = this.a1 * this.ic1 + this.a2 * v3;
    const v2 = this.ic2 + this.a2 * this.ic1 + this.a3 * v3;
    this.ic1 = 2 * v1 - this.ic1;
    this.ic2 = 2 * v2 - this.ic2;
    this.lp = v2;
    this.bp = v1;
    this.hp = x - this.k * v1 - v2;
  }
}

/**
 * Soma uma senoide amortecida (amp·e^(−t/tau)·sen(2πft + φ)) por recorrência — dois produtos por
 * amostra em vez de seno e exponencial —, até ela ficar inaudível.
 */
function addDamped(out: Float32Array, sr: number, f: number, amp: number, tau: number, phase = 0) {
  if (amp === 0 || f <= 0 || f >= sr * 0.45) return;
  const w = (TAU * f) / sr;
  const r = Math.exp(-1 / (sr * tau));
  const c1 = 2 * r * Math.cos(w);
  const c2 = r * r;
  let y1 = (amp * Math.sin(phase - w)) / r;
  let y2 = (amp * Math.sin(phase - 2 * w)) / c2;
  const end = Math.min(out.length, Math.ceil(tau * 9 * sr));
  for (let i = 0; i < end; i++) {
    const y = c1 * y1 - c2 * y2;
    out[i] += y;
    y2 = y1;
    y1 = y;
  }
}

/** Ataque: sobe de 0 em ~`tau` segundos (só o comecinho é afetado). */
function attack(out: Float32Array, sr: number, tau: number) {
  const n = Math.min(out.length, Math.ceil(tau * 10 * sr));
  for (let i = 0; i < n; i++) out[i] *= 1 - Math.exp(-i / sr / tau);
}

/** Remove o nível DC que os captadores assimétricos criam. */
function dcBlock(x: Float32Array, sr: number) {
  const hp = new Svf(sr, 20, 0.5);
  for (let i = 0; i < x.length; i++) {
    hp.tick(x[i]);
    x[i] = hp.hp;
  }
}

/** Martelo de feltro: um "tum" curto e abafado. */
function hammer(out: Float32Array, sr: number, rnd: () => number, level: number, fc: number, tau: number) {
  const f = new Svf(sr, fc, 0.6);
  const n = Math.min(out.length, Math.ceil(tau * 8 * sr));
  for (let i = 0; i < n; i++) {
    f.tick(rnd() * 2 - 1);
    out[i] += f.lp * level * Math.exp(-i / sr / tau);
  }
}

/**
 * Rhodes: o martelo bate numa haste de metal (tine) presa a uma barra de afinação. A haste vibra quase
 * como uma senoide, com um modo agudo inarmônico que some em milissegundos (o "plim") e uma leve
 * batida com a barra. O captador magnético é assimétrico: quanto mais a haste se aproxima dele, mais
 * harmônicos pares aparecem — o "rosnado" (bark) quando se toca forte.
 */
const rhodes: Model = {
  keys: range(28, 100, 3),
  length: (f) => clamp(7 * (110 / f) ** 0.45, 1.6, 7),
  render(out, sr, f, v, rnd) {
    const tau = clamp(3.2 * (110 / f) ** 0.5, 0.5, 6);
    const amp = 0.25 + 0.95 * v;
    const ding = f * 7.1 < sr * 0.45 ? 0.5 * v : 0;
    const beat = 0.3 + rnd() * 0.4;
    const ph0 = rnd() * TAU;
    const bias = 0.42;
    const g = 1.9;
    const off = Math.tanh(g * bias);
    // haste (com a leve batida com a barra de afinação: duas laterais em f ± batida), 2º harmônico e "plim"
    addDamped(out, sr, f, amp, tau, ph0);
    addDamped(out, sr, f + beat, amp * 0.0175, tau, ph0);
    addDamped(out, sr, f - beat, amp * 0.0175, tau, ph0 + Math.PI);
    addDamped(out, sr, 2 * f, amp * 0.12, tau * 0.3);
    addDamped(out, sr, 7.1 * f, amp * ding, 0.018);
    attack(out, sr, 0.0007);
    // captador magnético assimétrico
    for (let i = 0; i < out.length; i++) out[i] = Math.tanh(g * (out[i] + bias)) - off;
    hammer(out, sr, rnd, 0.05 * v, 1200, 0.003);
    dcBlock(out, sr);
  },
};

/**
 * Wurlitzer: o martelo bate numa palheta de aço; o captador é eletrostático (a palheta é uma placa de
 * capacitor), o que distorce de forma bem assimétrica — o som anasalado que "morde" quando se toca
 * forte. Passa pelo amplificador e pelo alto-falante pequeno do próprio piano.
 */
const wurli: Model = {
  keys: range(29, 98, 3),
  length: (f) => clamp(4.5 * (110 / f) ** 0.4, 1.2, 4.5),
  render(out, sr, f, v, rnd) {
    const tau = clamp(2 * (110 / f) ** 0.4, 0.35, 3.5);
    const amp = 0.3 + 0.65 * v;
    const k = 0.6;
    const ph0 = rnd() * TAU;
    const mode2 = f * 6.27 < sr * 0.45 ? 0.2 * v : 0;
    addDamped(out, sr, f, amp, tau, ph0);
    addDamped(out, sr, 6.27 * f, amp * mode2, 0.012);
    attack(out, sr, 0.0008);
    // captador eletrostático: a palheta é uma placa de capacitor
    for (let i = 0; i < out.length; i++) out[i] = out[i] / (1 - k * out[i]);
    hammer(out, sr, rnd, 0.08 * v, 2200, 0.004);
    dcBlock(out, sr);
    // amplificador e alto-falante do piano: corta graves e agudos extremos e satura de leve
    const hp = new Svf(sr, 110, 0.7);
    const lp = new Svf(sr, 4800, 0.8);
    for (let i = 0; i < out.length; i++) {
      hp.tick(out[i]);
      lp.tick(hp.hp);
      out[i] = Math.tanh(lp.lp * 1.4);
    }
  },
};

/**
 * Clavinete: uma lingueta bate na corda e a prende contra uma bigorna; a corda vibra (modelo de corda
 * Karplus-Strong, com perdas pequenas: som brilhante) e é lida por captadores perto da ponta, que
 * reforçam alguns harmônicos e cancelam outros — o timbre anasalado do funk.
 */
const clav: Model = {
  keys: range(33, 96, 3),
  length: (f) => clamp(3 * (110 / f) ** 0.3, 1.2, 3),
  render(out, sr, f, v, rnd) {
    const period = sr / f;
    // a média ponderada do laço atrasa 0,25 amostra; o resto do período vira atraso inteiro + fração
    let n = Math.floor(period - 0.25);
    let frac = period - 0.25 - n;
    if (frac < 0) {
      n -= 1;
      frac += 1;
    }
    const size = n + 4;
    const line = new Float32Array(size);
    // excitação: golpe da lingueta, mais brilhante quanto mais forte
    const ex = new Svf(sr, 1500 + 9000 * v, 0.6);
    for (let i = 0; i < size; i++) {
      ex.tick(rnd() * 2 - 1);
      line[i] = ex.lp * (0.4 + 0.6 * v);
    }
    const decay = clamp(2.2 * (110 / f) ** 0.4, 0.5, 3);
    const loss = Math.exp(-1 / (f * decay));
    const pick = Math.max(1, Math.round(period * 0.1));
    const hist = new Float32Array(pick + 1);
    let w = 0;
    let prev = 0;
    for (let i = 0; i < out.length; i++) {
      // leitura com atraso fracionário (interpolação linear)
      const r = (w - n + size) % size;
      const r1 = (r - 1 + size) % size;
      const y = line[r] * (1 - frac) + line[r1] * frac;
      // perda no laço: média ponderada (pouco amortecimento = brilho)
      const next = loss * (0.75 * y + 0.25 * prev);
      prev = y;
      line[w] = next;
      w = (w + 1) % size;
      // captador: diferença entre dois pontos da corda (cancela alguns harmônicos)
      const hi = i % (pick + 1);
      const old = hist[hi];
      hist[hi] = y;
      out[i] = y - 0.85 * old;
    }
    hammer(out, sr, rnd, 0.06 * v, 3000, 0.002);
    dcBlock(out, sr);
  },
};

/**
 * Sino: modos de vibração de um sino de igreja (hum, fundamental, terça menor, quinta, nominal...),
 * cada um com seu decaimento — os graves soam por muito tempo, os agudos somem logo — e uma leve
 * batida entre pares de modos quase iguais (o sino não é perfeitamente redondo).
 */
const bell: Model = {
  keys: range(48, 108, 3),
  length: (f) => clamp(6 * (262 / f) ** 0.5, 2, 6),
  render(out, sr, f, v, rnd) {
    const modes: [number, number, number][] = [
      // razão, amplitude, decaimento (s, em C4)
      [0.5, 0.35, 4.5], [1, 0.8, 3.2], [1.183, 0.45, 2.4], [1.506, 0.3, 1.8], [2, 0.6, 1.5],
      [2.514, 0.25, 0.9], [2.662, 0.2, 0.8], [3.011, 0.18, 0.6], [4.166, 0.12 * v, 0.35], [5.433, 0.08 * v, 0.2],
    ];
    const scale = (262 / f) ** 0.5;
    for (const [ratio, a, tau0] of modes) {
      const fm = f * ratio;
      if (fm > sr * 0.45) continue;
      const tau = tau0 * scale;
      const split = 1 + (rnd() - 0.5) * 0.002; // o modo se divide em dois quase iguais: batimento
      const ph = rnd() * TAU;
      addDamped(out, sr, fm, a * 0.5, tau, ph);
      addDamped(out, sr, fm * split, a * 0.5, tau, ph);
    }
    attack(out, sr, 0.0005);
    hammer(out, sr, rnd, 0.05 * v, 5000, 0.0015);
  },
};

const MODELS: Record<ModeledSet, Model> = { rhodes, wurli, clav, bell };
export const MODELED_SETS = Object.keys(MODELS) as ModeledSet[];

export interface RenderedZone {
  key: number;
  /** uma gravação calculada por intensidade (da mais fraca à mais forte) */
  layers: Float32Array[];
}

/** Calcula todas as notas-base de um instrumento, uma por vez (cede a vez à tela entre elas). */
export async function renderModel(name: ModeledSet, sr: number): Promise<RenderedZone[]> {
  const m = MODELS[name];
  const zones: RenderedZone[] = [];
  for (const key of m.keys) {
    const f = 440 * 2 ** ((key - 69) / 12);
    const layers: Float32Array[] = [];
    for (const [li, v] of VELOCITIES.entries()) {
      await new Promise((ok) => setTimeout(ok, 0));
      const out = new Float32Array(Math.ceil(m.length(f) * sr));
      m.render(out, sr, f, v, prng(key * 131 + li * 17 + name.length));
      // suaviza o fim (o resto da nota foi cortado)
      const fade = Math.min(out.length, Math.ceil(0.08 * sr));
      for (let i = 0; i < fade; i++) out[out.length - 1 - i] *= i / fade;
      layers.push(out);
    }
    zones.push({ key, layers });
  }
  // normaliza o instrumento inteiro pela nota mais forte (mantém o equilíbrio entre notas e forças)
  let peak = 0;
  for (const z of zones) for (const l of z.layers) for (let i = 0; i < l.length; i++) peak = Math.max(peak, Math.abs(l[i]));
  for (const z of zones) for (const l of z.layers) for (let i = 0; i < l.length; i++) l[i] *= 0.9 / peak;
  return zones;
}
