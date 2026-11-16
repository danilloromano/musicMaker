// Bateria: kit acústico gravado (abaixo, "Kit gravado") com um kit sintetizado de reserva.
// Kit de bateria acústica sintetizado. Cada peça é calculada uma única vez, amostra a amostra, com um
// modelo mais próximo do instrumento real (modos da membrana, esteira da caixa, pratos com dezenas de
// parciais inarmônicas, uma pequena sala) e depois tocada como sample. Cada peça tem algumas variações
// para não soar "metralhadora", e a força do toque muda o volume e o brilho.

const TAU = Math.PI * 2;

/** Gerador pseudoaleatório com semente: cada variação de uma peça sai sempre igual. */
function prng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Filtro de variáveis de estado (TPT): passa-baixa, passa-banda e passa-alta de uma vez. */
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
  constructor(sr: number, fc: number, q: number) {
    this.set(sr, fc, q);
  }
  set(sr: number, fc: number, q: number) {
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

/** Modos de vibração de uma membrana circular (razões de frequência em relação ao fundamental). */
const MEMBRANE = [1, 1.59, 2.14, 2.3, 2.65, 2.92, 3.16];

/**
 * Soma modos senoidais (membrana) com uma leve queda de afinação no ataque, como a pele que
 * relaxa logo depois da batida.
 */
function addModes(
  out: Float32Array,
  sr: number,
  f0: number,
  modes: { ratio: number; amp: number; tau: number }[],
  bend: number,
  bendTau: number,
  rnd: () => number,
) {
  for (const m of modes) {
    let ph = rnd() * TAU * 0.1;
    const end = Math.min(out.length, Math.ceil(m.tau * 9 * sr));
    for (let i = 0; i < end; i++) {
      const t = i / sr;
      ph += (TAU * f0 * m.ratio * (1 + bend * Math.exp(-t / bendTau))) / sr;
      out[i] += Math.sin(ph) * m.amp * Math.exp(-t / m.tau);
    }
  }
}

/** Parciais metálicas inarmônicas (pratos e chimbal): frequências espalhadas em escala logarítmica. */
function addMetal(
  out: Float32Array,
  sr: number,
  n: number,
  fmin: number,
  fmax: number,
  tauMin: number,
  tauMax: number,
  rnd: () => number,
) {
  for (let p = 0; p < n; p++) {
    const f = fmin * (fmax / fmin) ** rnd();
    // as parciais mais agudas morrem um pouco antes
    const tau = (tauMin + (tauMax - tauMin) * rnd()) * (1.25 - 0.5 * Math.log(f / fmin) / Math.log(fmax / fmin));
    const amp = (0.4 + 0.6 * rnd()) / Math.sqrt(n);
    // oscilador recursivo amortecido: y[n] = 2·r·cos(w)·y[n-1] − r²·y[n-2] (seno com decaimento exponencial)
    const w = (TAU * f) / sr;
    const r = Math.exp(-1 / (sr * tau));
    const c1 = 2 * r * Math.cos(w);
    const c2 = r * r;
    const ph = rnd() * TAU;
    let y1 = amp * Math.sin(ph - w) / r;
    let y2 = amp * Math.sin(ph - 2 * w) / c2;
    const end = Math.min(out.length, Math.ceil(tau * 7 * sr));
    for (let i = 0; i < end; i++) {
      const y = c1 * y1 - c2 * y2;
      out[i] += y;
      y2 = y1;
      y1 = y;
    }
  }
}

/** Ruído filtrado com envelope: `env(t)` dá a amplitude, `pick` escolhe a saída do filtro. */
function addNoise(
  out: Float32Array,
  sr: number,
  rnd: () => number,
  flt: Svf,
  pick: (f: Svf) => number,
  env: (t: number) => number,
  dur: number,
) {
  const end = Math.min(out.length, Math.ceil(dur * sr));
  for (let i = 0; i < end; i++) {
    flt.tick(rnd() * 2 - 1);
    out[i] += pick(flt) * env(i / sr);
  }
}

const sat = (x: number, drive: number) => Math.tanh(x * drive) / Math.tanh(drive);

/** Sala pequena (Schroeder): pentes em paralelo + passa-tudo em série, com amortecimento dos agudos. */
function room(dry: Float32Array, sr: number, wet: number, tail = 0.35): Float32Array {
  const out = new Float32Array(dry.length + Math.ceil(tail * sr));
  out.set(dry);
  if (wet <= 0) return out;
  const verb = new Float32Array(out.length);
  for (const [ms, fb] of [[23.1, 0.74], [26.7, 0.72], [29.9, 0.7], [33.7, 0.68]] as const) {
    const d = Math.round((ms / 1000) * sr);
    const buf = new Float32Array(d);
    let idx = 0;
    let lp = 0;
    for (let i = 0; i < out.length; i++) {
      const y = buf[idx];
      lp = y * 0.6 + lp * 0.4;
      buf[idx] = out[i] + lp * fb;
      idx = (idx + 1) % d;
      verb[i] += y * 0.25;
    }
  }
  for (const ms of [5.1, 1.7]) {
    const d = Math.round((ms / 1000) * sr);
    const buf = new Float32Array(d);
    let idx = 0;
    for (let i = 0; i < out.length; i++) {
      const b = buf[idx];
      const x = verb[i] + b * 0.6;
      buf[idx] = x;
      verb[i] = b - x * 0.6;
      idx = (idx + 1) % d;
    }
  }
  for (let i = 0; i < out.length; i++) out[i] += verb[i] * wet;
  return out;
}

/** Normaliza o pico em 1 e suaviza o fim para não estalar. */
function finish(x: Float32Array, sr: number): Float32Array {
  let peak = 0;
  for (let i = 0; i < x.length; i++) peak = Math.max(peak, Math.abs(x[i]));
  const k = peak > 0 ? 1 / peak : 1;
  const fade = Math.min(x.length, Math.ceil(0.02 * sr));
  for (let i = 0; i < x.length; i++) {
    const r = x.length - i;
    x[i] *= k * (r < fade ? r / fade : 1);
  }
  return x;
}

const buf = (sr: number, sec: number) => new Float32Array(Math.ceil(sec * sr));

function kick(sr: number, rnd: () => number) {
  const x = buf(sr, 0.65);
  const f0 = 50 + rnd() * 4;
  let ph = 0;
  let ph2 = rnd();
  for (let i = 0; i < x.length; i++) {
    const t = i / sr;
    const f = f0 * (1 + 1.6 * Math.exp(-t / 0.025));
    ph += (TAU * f) / sr;
    ph2 += (TAU * f * 1.59) / sr;
    x[i] = Math.sin(ph) * Math.exp(-t / 0.2) * (1 - Math.exp(-t / 0.0012)) + Math.sin(ph2) * 0.22 * Math.exp(-t / 0.045);
  }
  // batida do pedal (feltro) e ressonância do casco
  const click = new Svf(sr, 3200 + rnd() * 800, 0.7);
  addNoise(x, sr, rnd, click, (f) => f.lp, (t) => 0.5 * Math.exp(-t / 0.004), 0.03);
  const shell = new Svf(sr, 95, 2.5);
  addNoise(x, sr, rnd, shell, (f) => f.bp, (t) => 0.9 * Math.exp(-t / 0.07), 0.4);
  for (let i = 0; i < x.length; i++) x[i] = sat(x[i], 1.6);
  return room(x, sr, 0.06);
}

function snare(sr: number, rnd: () => number) {
  const x = buf(sr, 0.5);
  const f0 = 182 + rnd() * 10;
  const amps = [1, 0.6, 0.45, 0.35, 0.3, 0.2, 0.15];
  const taus = [0.085, 0.06, 0.05, 0.045, 0.04, 0.035, 0.03];
  addModes(x, sr, f0, MEMBRANE.map((ratio, k) => ({ ratio, amp: amps[k] * 0.55, tau: taus[k] })), 0.08, 0.012, rnd);
  // esteira: chiado largo, com o corpo (passa-banda) e o brilho (passa-alta)
  const wires = new Svf(sr, 4800 + rnd() * 700, 0.55);
  const end = Math.ceil(0.45 * sr);
  for (let i = 0; i < end; i++) {
    const t = i / sr;
    wires.tick(rnd() * 2 - 1);
    const env = (1 - Math.exp(-t / 0.0025)) * Math.exp(-t / (0.1 + rnd() * 0.004));
    x[i] += (wires.bp * 0.9 + wires.hp * 0.45) * env * (1 + 0.5 * Math.exp(-t / 0.03));
  }
  // baqueta na pele
  const stick = new Svf(sr, 6000, 0.6);
  addNoise(x, sr, rnd, stick, (f) => f.bp, (t) => 0.6 * Math.exp(-t / 0.0015), 0.01);
  for (let i = 0; i < x.length; i++) x[i] = sat(x[i], 1.3);
  return room(x, sr, 0.14);
}

function tom(f0: number, tau: number) {
  return (sr: number, rnd: () => number) => {
    const x = buf(sr, tau * 5);
    const f = f0 * (1 + (rnd() - 0.5) * 0.02);
    const amps = [1, 0.35, 0.2, 0.12];
    const taus = [tau, tau * 0.4, tau * 0.25, tau * 0.18];
    addModes(x, sr, f, amps.map((amp, k) => ({ ratio: MEMBRANE[k === 3 ? 4 : k], amp, tau: taus[k] })), 0.14, 0.05, rnd);
    const att = new Svf(sr, f * 4, 1);
    addNoise(x, sr, rnd, att, (v) => v.bp, (t) => 0.35 * Math.exp(-t / 0.01), 0.06);
    const stick = new Svf(sr, 5000, 0.6);
    addNoise(x, sr, rnd, stick, (v) => v.bp, (t) => 0.25 * Math.exp(-t / 0.0015), 0.01);
    for (let i = 0; i < x.length; i++) x[i] = sat(x[i], 1.2);
    return room(x, sr, 0.12);
  };
}

function hihat(open: boolean) {
  return (sr: number, rnd: () => number) => {
    const len = open ? 0.9 : 0.14;
    const x = buf(sr, len);
    addMetal(x, sr, 48, open ? 2600 : 3200, 15000, open ? 0.18 : 0.018, open ? 0.42 : 0.04, rnd);
    const hp = new Svf(sr, 7000, 0.7);
    const nt = open ? 0.28 : 0.025;
    addNoise(x, sr, rnd, hp, (f) => f.hp, (t) => 0.8 * (1 - Math.exp(-t / 0.0008)) * Math.exp(-t / nt), len);
    // tira o grave das parciais
    const cut = new Svf(sr, 2500, 0.7);
    for (let i = 0; i < x.length; i++) {
      cut.tick(x[i]);
      x[i] = cut.hp;
    }
    return room(x, sr, 0.05, 0.25);
  };
}

function crash(sr: number, rnd: () => number) {
  const x = buf(sr, 2.8);
  addMetal(x, sr, 70, 380, 13000, 0.55, 1.4, rnd);
  const hp = new Svf(sr, 3500, 0.6);
  addNoise(x, sr, rnd, hp, (f) => f.hp, (t) => 0.5 * Math.exp(-t / 0.75) + 0.8 * Math.exp(-t / 0.02), 2.8);
  // o prato "abre" logo depois da batida
  for (let i = 0; i < x.length; i++) x[i] *= 0.7 + 0.3 * (1 - Math.exp(-i / sr / 0.03));
  return room(x, sr, 0.08, 0.4);
}

function clap(sr: number, rnd: () => number) {
  const x = buf(sr, 0.35);
  const hits: number[] = [];
  let at = 0;
  for (let k = 0; k < 4; k++) {
    hits.push(at);
    at += 0.007 + rnd() * 0.006;
  }
  const bp = new Svf(sr, 1150 + rnd() * 200, 0.9);
  const env = (t: number) => {
    let a = 0;
    for (const h of hits) if (t >= h) a = Math.max(a, Math.exp(-(t - h) / 0.0065));
    const last = hits[hits.length - 1];
    return t >= last ? Math.max(a, 0.55 * Math.exp(-(t - last) / 0.085)) : a;
  };
  addNoise(x, sr, rnd, bp, (f) => f.bp + f.hp * 0.15, env, 0.35);
  return room(x, sr, 0.15);
}

function cowbell(sr: number, rnd: () => number) {
  const x = buf(sr, 0.6);
  const bp = new Svf(sr, 1000, 1.4);
  const fs = [562 * (1 + (rnd() - 0.5) * 0.004), 845];
  const ph = [0, 0];
  for (let i = 0; i < x.length; i++) {
    const t = i / sr;
    let s = 0;
    for (let k = 0; k < 2; k++) {
      ph[k] += (TAU * fs[k]) / sr;
      // onda quadrada com poucas harmônicas (sem serrilhado)
      s += Math.sin(ph[k]) + Math.sin(3 * ph[k]) / 3 + Math.sin(5 * ph[k]) / 5;
    }
    bp.tick(s);
    x[i] = bp.bp * (0.6 * Math.exp(-t / 0.02) + 0.4 * Math.exp(-t / 0.22));
  }
  return room(x, sr, 0.08);
}

interface Piece {
  render: (sr: number, rnd: () => number) => Float32Array;
  variants: number;
  level: number;
  /** corte do passa-baixa num toque bem fraco (o toque forte abre até 20 kHz) */
  dark: number;
}

const PIECES: Record<number, Piece> = {
  36: { render: kick, variants: 2, level: 1.0, dark: 1500 },
  38: { render: snare, variants: 4, level: 0.85, dark: 2200 },
  39: { render: clap, variants: 3, level: 0.6, dark: 2500 },
  42: { render: hihat(false), variants: 4, level: 0.4, dark: 6000 },
  46: { render: hihat(true), variants: 3, level: 0.36, dark: 5500 },
  49: { render: crash, variants: 2, level: 0.45, dark: 4000 },
  45: { render: tom(84, 0.34), variants: 2, level: 0.85, dark: 1800 },
  48: { render: tom(118, 0.29), variants: 2, level: 0.85, dark: 2000 },
  50: { render: tom(162, 0.24), variants: 2, level: 0.85, dark: 2200 },
  56: { render: cowbell, variants: 1, level: 0.3, dark: 3000 },
};

const samples = new Map<string, Float32Array>();
function variantSample(sr: number, pitch: number, v: number): Float32Array {
  const key = `${sr}:${pitch}:${v}`;
  let s = samples.get(key);
  if (!s) samples.set(key, (s = finish(PIECES[pitch].render(sr, prng(pitch * 97 + v * 7919 + 1)), sr)));
  return s;
}
const pieceSamples = (sr: number, pitch: number) =>
  Array.from({ length: PIECES[pitch].variants }, (_, v) => variantSample(sr, pitch, v));

const bufferCache = new WeakMap<BaseAudioContext, Map<number, AudioBuffer[]>>();
function pieceBuffers(ctx: BaseAudioContext, pitch: number): AudioBuffer[] {
  let m = bufferCache.get(ctx);
  if (!m) bufferCache.set(ctx, (m = new Map()));
  let b = m.get(pitch);
  if (!b) {
    b = pieceSamples(ctx.sampleRate, pitch).map((d) => {
      const ab = ctx.createBuffer(1, d.length, ctx.sampleRate);
      ab.getChannelData(0).set(d);
      return ab;
    });
    m.set(pitch, b);
  }
  return b;
}

/**
 * Prepara a bateria em segundo plano: carrega o kit gravado e calcula o sintetizado (usado até o gravado
 * ficar pronto e para as palmas), uma variação por vez para a primeira batida não atrasar.
 */
export function warmDrumKit(ctx: BaseAudioContext) {
  void loadDrumSamples(ctx);
  const sr = ctx.sampleRate;
  const todo = Object.entries(PIECES).flatMap(([p, piece]) => Array.from({ length: piece.variants }, (_, v) => [+p, v]));
  const step = () => {
    const next = todo.shift();
    if (!next) return;
    variantSample(sr, next[0], next[1]);
    setTimeout(step, 0);
  };
  setTimeout(step, 0);
}

// ---------- Kit gravado ----------
// Virtuosity Drums (Versilian Studios, CC0), mixado por scripts/build-drums.cjs.

/** Nota → peça gravada. O kit gravado tem dois tons: o médio é o agudo tocado um pouco mais grave. */
const SAMPLED: Record<number, { piece: string; level: number; rate?: number }> = {
  36: { piece: 'kick', level: 0.6 },
  38: { piece: 'snare', level: 1.0 },
  42: { piece: 'hhClosed', level: 1.0 },
  46: { piece: 'hhOpen', level: 0.5 },
  49: { piece: 'crash', level: 0.6 },
  45: { piece: 'lowTom', level: 0.6 },
  48: { piece: 'highTom', level: 0.6, rate: 0.86 },
  50: { piece: 'highTom', level: 0.6 },
  56: { piece: 'cowbell', level: 0.25 },
};

/** peça → camadas (da mais fraca à mais forte) → repetições do mesmo golpe */
let sampled: Record<string, AudioBuffer[][]> | null = null;
let loading: Promise<void> | null = null;

/** Carrega e decodifica o kit gravado uma única vez (um AudioBuffer serve para qualquer contexto). */
export function loadDrumSamples(ctx: BaseAudioContext): Promise<void> {
  loading ??= (async () => {
    const { manifest, data } = await import('./drums/kitData.js');
    const str = atob(data);
    const bin = new Uint8Array(str.length);
    for (let i = 0; i < str.length; i++) bin[i] = str.charCodeAt(i);
    const kit: Record<string, AudioBuffer[][]> = {};
    for (const [piece, layers] of Object.entries(manifest)) {
      kit[piece] = await Promise.all(
        layers.map((takes) => Promise.all(takes.map(([o, n]) => ctx.decodeAudioData(bin.slice(o, o + n).buffer)))),
      );
    }
    sampled = kit;
  })().catch((e) => {
    console.warn('Bateria gravada indisponível; usando a sintetizada.', e);
    loading = null;
  });
  return loading;
}

const lastTake = new Map<string, number>();

/** Toca a gravação da peça: a força escolhe a camada, e a repetição é sorteada (sem repetir a anterior). */
function playSample(ctx: BaseAudioContext, dest: AudioNode, pitch: number, t: number, v: number): GainNode | null {
  const s = SAMPLED[pitch];
  const layers = s && sampled?.[s.piece];
  if (!layers?.length) return null;
  const idx = Math.min(layers.length - 1, Math.floor(v * layers.length));
  const takes = layers[idx];
  const key = `${pitch}:${idx}`;
  let k = Math.floor(Math.random() * takes.length);
  if (takes.length > 1 && k === lastTake.get(key)) k = (k + 1) % takes.length;
  lastTake.set(key, k);
  const src = ctx.createBufferSource();
  src.buffer = takes[k];
  src.playbackRate.value = s.rate ?? 1;
  const g = ctx.createGain();
  g.gain.value = s.level * (0.55 + 0.45 * v);
  src.connect(g).connect(dest);
  src.start(t);
  return g;
}

/**
 * Batidas de chimbal recentes em cada saída: uma batida nova abafa o chimbal aberto que já soava, como o
 * pedal fechando. As notas são agendadas fora de ordem de tempo, então compara pelos instantes.
 */
const hats = new WeakMap<AudioNode, { t: number; g?: GainNode }[]>();
function chokeHats(dest: AudioNode, t: number, g?: GainNode) {
  let list = hats.get(dest);
  if (!list) hats.set(dest, (list = []));
  for (const h of list) {
    if (h.g && h.t < t) h.g.gain.setTargetAtTime(0, t, 0.012);
    if (g && t < h.t) g.gain.setTargetAtTime(0, h.t, 0.012);
  }
  list.push({ t, g });
  const keep = list.filter((h) => Math.abs(h.t - t) < 2);
  hats.set(dest, keep);
}

/** Toca uma peça do kit; devolve false se a nota não for uma peça conhecida. */
export function playKitPiece(ctx: BaseAudioContext, dest: AudioNode, pitch: number, t: number, vel: number): boolean {
  const v = Math.max(0, Math.min(1, vel / 127));
  const hat = pitch === 42 || pitch === 46;
  const sg = playSample(ctx, dest, pitch, t, v);
  if (sg) {
    if (hat) chokeHats(dest, t, pitch === 46 ? sg : undefined);
    return true;
  }
  const p = PIECES[pitch];
  if (!p) return false;
  const bufs = pieceBuffers(ctx, pitch);
  const src = ctx.createBufferSource();
  src.buffer = bufs[Math.floor(Math.random() * bufs.length)];
  src.playbackRate.value = 1 + (Math.random() - 0.5) * 0.012;
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.Q.value = 0.5;
  lp.frequency.value = p.dark * (20000 / p.dark) ** (v ** 0.8);
  const g = ctx.createGain();
  g.gain.value = p.level * v ** 1.3 * (1 + (Math.random() - 0.5) * 0.1);
  src.connect(lp).connect(g).connect(dest);
  src.start(t);

  if (hat) chokeHats(dest, t, pitch === 46 ? g : undefined);
  return true;
}
