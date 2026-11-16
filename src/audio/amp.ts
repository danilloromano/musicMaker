// Rack de guitarra/baixo: pedais → amplificador → caixa (impulse response) → pedais de modulação e tempo.
// Tudo roda no canal da trilha, então a gravação continua seca e o timbre pode ser trocado depois (re-amp).
import { AmpRig } from '../types';
import { workletsReady } from './master';
import { AMPS, AmpModel, ToneStackParts, gainPot, magnitude, outGain, powerDrive, powerTube, toneStackZ, triode } from './ampCircuits';

// ---------- Definições ----------

export interface PedalDef {
  id: string;
  name: string;
  color: string;
  /** true = entra depois do amp e da caixa (modulação/tempo), como no loop de efeitos */
  post: boolean;
  /** descrição curta do timbre, mostrada no pedal */
  desc?: string;
  /** `fmt` mostra o valor do botão na unidade dele (ex.: semitons) em vez da escala 0–10 */
  params: { label: string; def: number; fmt?: (v: number) => string }[];
  /** chave de dois lados (como as mini-chaves de pedal): guardada como 0/1 logo depois dos botões */
  toggles?: { labels: [string, string]; titles: [string, string]; def: 0 | 1 }[];
}

/** Tons do harmonizador e intervalos (em graus da escala: 2 = terça, 4 = quinta, 7 = oitava). */
const KEY_NAMES = ['Dó', 'Dó#', 'Ré', 'Ré#', 'Mi', 'Fá', 'Fá#', 'Sol', 'Sol#', 'Lá', 'Lá#', 'Si'];
const HARMONY_STEPS = [
  { name: '-8ª', deg: -7 }, { name: '-6ª', deg: -5 }, { name: '-5ª', deg: -4 }, { name: '-4ª', deg: -3 }, { name: '-3ª', deg: -2 },
  { name: '+3ª', deg: 2 }, { name: '+4ª', deg: 3 }, { name: '+5ª', deg: 4 }, { name: '+6ª', deg: 5 }, { name: '+8ª', deg: 7 },
];
const harmonyKey = (v: number) => Math.min(11, Math.round(v * 11));
const harmonyStep = (v: number) => Math.min(HARMONY_STEPS.length - 1, Math.round(v * (HARMONY_STEPS.length - 1)));
const HARMONY_DEF = 5 / (HARMONY_STEPS.length - 1); // terça acima

/** Botão de intervalo do pedal de pitch (0..1) → semitons inteiros de -12 a +12. */
export const pitchSemis = (v: number) => Math.round(v * 24 - 12);
const fmtSemis = (s: number) => (s === 12 ? '+8ª' : s === -12 ? '-8ª' : `${s > 0 ? '+' : ''}${s} st`);

/** Valores padrão de um pedal: botões e, se houver, a chave. */
export const pedalDefaults = (d: PedalDef) => [...d.params.map((x) => x.def), ...(d.toggles ?? []).map((t) => t.def)];

export const PEDALS: PedalDef[] = [
  { id: 'gate', name: 'Noise Gate', color: '#c8c8bd', post: false, params: [{ label: 'Limiar', def: 0.4 }, { label: 'Release', def: 0.3 }] },
  { id: 'comp', name: 'Compressor', color: '#38d9c0', post: false, params: [{ label: 'Sustain', def: 0.5 }, { label: 'Nível', def: 0.5 }] },
  { id: 'octave', name: 'Octaver', color: '#6a5acd', post: false,
    desc: 'Oitava e duas oitavas abaixo, como os octavers analógicos: grave gordo, toque uma nota por vez',
    params: [{ label: 'Direto', def: 0.7 }, { label: '-1 Oit.', def: 0.6 }, { label: '-2 Oit.', def: 0 }] },
  { id: 'pitch', name: 'Pitch', color: '#d2457a', post: false,
    desc: 'Muda a afinação: oitava acima/abaixo, quinta, terça… Mix no máximo = só o som transposto; no meio = harmonia',
    params: [
      { label: 'Intervalo', def: 1, fmt: (v) => fmtSemis(pitchSemis(v)) },
      { label: 'Fino', def: 0.5, fmt: (v) => `${Math.round((v - 0.5) * 100)} ct` },
      { label: 'Mix', def: 0.5 },
    ] },
  { id: 'harmony', name: 'Harmonizer', color: '#4fc3a1', post: false,
    desc: 'Segunda voz no intervalo escolhido, dentro da escala do tom (terça maior ou menor conforme a nota). Uma nota por vez',
    params: [
      { label: 'Tom', def: 0, fmt: (v) => KEY_NAMES[harmonyKey(v)] },
      { label: 'Intervalo', def: HARMONY_DEF, fmt: (v) => HARMONY_STEPS[harmonyStep(v)].name },
      { label: 'Voz', def: 0.6 },
    ],
    toggles: [{ labels: ['Maior', 'Menor'], titles: ['Escala maior', 'Escala menor natural'], def: 0 }] },
  { id: 'wah', name: 'Wah', color: '#9bd94a', post: false,
    desc: 'Pedal: o filtro fica parado na posição escolhida · Auto: abre sozinho com a força da palhetada',
    params: [{ label: 'Posição', def: 0.5 }, { label: 'Sensib.', def: 0.5 }, { label: 'Resson.', def: 0.5 }],
    toggles: [{ labels: ['Pedal', 'Auto'], titles: ['Wah parado na posição do botão (como o pedal meio aberto)', 'Auto-wah: a palhetada abre o filtro e ele fecha quando a nota cai'], def: 0 }] },
  { id: 'boost', name: 'Booster', color: '#e0b48a', post: false, params: [{ label: 'Ganho', def: 0.4 }, { label: 'Brilho', def: 0.3 }] },
  // Três overdrives com o comportamento de circuitos clássicos (os nomes na tela são genéricos de propósito):
  // Dourado ≈ Klon Centaur, Verde ≈ Ibanez TS808, Amarelo ≈ Boss SD-1.
  { id: 'odGold', name: 'Overdrive Dourado', color: '#d9b44a', post: false, desc: 'Transparente: mistura o limpo com o sujo, mantém os graves',
    params: [{ label: 'Ganho', def: 0.35 }, { label: 'Agudos', def: 0.5 }, { label: 'Nível', def: 0.55 }] },
  { id: 'odGreen', name: 'Overdrive Verde', color: '#5cc25a', post: false, desc: 'Médios na frente, grave enxuto, saturação macia',
    params: [{ label: 'Drive', def: 0.4 }, { label: 'Tom', def: 0.5 }, { label: 'Nível', def: 0.5 }] },
  { id: 'odYellow', name: 'Overdrive Amarelo', color: '#f2d33c', post: false, desc: 'Clipagem assimétrica: mais brilho e harmônicos pares',
    params: [{ label: 'Drive', def: 0.45 }, { label: 'Tom', def: 0.5 }, { label: 'Nível', def: 0.5 }] },
  { id: 'dist', name: 'Distorção', color: '#ff9a3c', post: false, params: [{ label: 'Drive', def: 0.5 }, { label: 'Tom', def: 0.5 }, { label: 'Nível', def: 0.5 }] },
  { id: 'fuzz', name: 'Fuzz', color: '#e8564a', post: false, params: [{ label: 'Fuzz', def: 0.6 }, { label: 'Tom', def: 0.5 }, { label: 'Nível', def: 0.5 }] },
  { id: 'chorus', name: 'Chorus', color: '#5fb4ff', post: true, params: [{ label: 'Velocidade', def: 0.3 }, { label: 'Profund.', def: 0.5 }, { label: 'Mix', def: 0.5 }] },
  { id: 'phaser', name: 'Phaser', color: '#b98cff', post: true, params: [{ label: 'Velocidade', def: 0.25 }, { label: 'Profund.', def: 0.6 }, { label: 'Intens.', def: 0.6 }] },
  { id: 'flanger', name: 'Flanger', color: '#7fd6e8', post: true, desc: 'O "avião a jato": eco curtíssimo que varre, com realimentação para ficar mais metálico',
    params: [{ label: 'Velocidade', def: 0.25 }, { label: 'Profund.', def: 0.6 }, { label: 'Realim.', def: 0.5 }] },
  { id: 'vibrato', name: 'Vibrato', color: '#e8a33c', post: true, desc: 'Ondula a afinação (não o volume, como o tremolo): só o sinal modulado, sem o direto',
    params: [{ label: 'Velocidade', def: 0.35 }, { label: 'Profund.', def: 0.35 }] },
  { id: 'tremolo', name: 'Tremolo', color: '#ff5fa2', post: true, params: [{ label: 'Velocidade', def: 0.4 }, { label: 'Profund.', def: 0.5 }] },
  { id: 'delay', name: 'Delay', color: '#a3b1c2', post: true, desc: 'Fita: repetições quentes que oscilam e escurecem · Digital: limpas e exatas · Estéreo: ping-pong',
    params: [{ label: 'Tempo', def: 0.35 }, { label: 'Ecos', def: 0.35 }, { label: 'Mix', def: 0.3 }],
    toggles: [
      { labels: ['Fita', 'Digital'], titles: ['Delay de fita', 'Delay digital'], def: 0 },
      { labels: ['Mono', 'Estéreo'], titles: ['Mono: repetições no centro', 'Estéreo: repetições alternando entre esquerda e direita'], def: 0 },
    ] },
  { id: 'reverb', name: 'Reverb', color: '#3f8fe0', post: true, desc: 'Mola: o "boing" metálico dos amps antigos · Sala: cauda lisa e escura',
    params: [{ label: 'Tempo', def: 0.4 }, { label: 'Tom', def: 0.5 }, { label: 'Mix', def: 0.35 }],
    toggles: [{ labels: ['Mola', 'Sala'], titles: ['Reverb de mola', 'Reverb sem mola: sala'], def: 0 }] },
];

type Curve = 'soft' | 'hard' | 'asym' | 'germ' | 'tape';

export { AMPS } from './ampCircuits';

interface CabSpec {
  id: string;
  name: string;
  hp: number;
  lp: number;
  lpOrder: number;
  peaks: [number, number, number][]; // [Hz, dB, Q]
  taps: [number, number][]; // reflexões dentro da caixa: [ms, ganho]
}

export const CABS: CabSpec[] = [
  { id: '1x12', name: '1x12 Aberta', hp: 85, lp: 5500, lpOrder: 2, peaks: [[115, 3, 1], [900, -2, 1], [2500, 4, 1.4]], taps: [[0.7, 0.25], [1.6, -0.15]] },
  { id: '2x12', name: '2x12 Combo', hp: 75, lp: 5000, lpOrder: 3, peaks: [[100, 4, 1.1], [1800, 3, 1.2], [3200, 2, 2]], taps: [[0.5, 0.3], [1.2, -0.2], [2.3, 0.1]] },
  { id: '4x12', name: '4x12 Fechada', hp: 70, lp: 4500, lpOrder: 4, peaks: [[90, 6, 1.2], [400, -3, 1], [3000, 5, 1.5]], taps: [[0.4, 0.35], [1.1, -0.25], [2.6, 0.15]] },
  { id: '1x8', name: '1x8 Pequena', hp: 220, lp: 3500, lpOrder: 3, peaks: [[1200, 6, 1], [2600, 3, 2]], taps: [[0.3, 0.3], [0.8, -0.2]] },
  { id: '4x10b', name: '4x10 Baixo', hp: 40, lp: 4000, lpOrder: 2, peaks: [[65, 4, 1], [800, 2, 1], [2500, 2, 1.5]], taps: [[0.6, 0.25], [1.5, -0.15]] },
  { id: '8x10b', name: '8x10 Baixo', hp: 35, lp: 3000, lpOrder: 3, peaks: [[80, 5, 1], [500, -2, 1]], taps: [[0.5, 0.3], [1.3, -0.2], [2.2, 0.12]] },
];

export function defaultRig(): AmpRig {
  return {
    on: true,
    pedals: Object.fromEntries(PEDALS.map((p) => [p.id, { on: false, p: pedalDefaults(p) }])),
    amp: 'clean',
    knobs: { gain: 0.3, bass: 0.5, mid: 0.5, treble: 0.5, presence: 0.5, master: 0.5 },
    cab: '2x12',
    cabMix: 1,
  };
}

/** Monta um timbre a partir do padrão: amp, botões, caixa e pedais ligados (com valores opcionais). */
function preset(amp: string, knobs: Partial<AmpRig['knobs']>, cab: string, pedals: Record<string, number[] | true> = {}): AmpRig {
  const r = defaultRig();
  r.amp = amp;
  r.knobs = { ...r.knobs, ...knobs };
  r.cab = cab;
  for (const [id, v] of Object.entries(pedals)) r.pedals[id] = { on: true, p: v === true ? r.pedals[id].p : v };
  return r;
}

export const RIG_PRESETS: { name: string; make: () => AmpRig }[] = [
  { name: 'Limpo Cristalino', make: () => preset('clean', { gain: 0.2, treble: 0.6 }, '2x12', { comp: [0.4, 0.5], chorus: [0.25, 0.4, 0.35], reverb: [0.5, 0.55, 0.3, 1] }) },
  { name: 'Funk', make: () => preset('clean', { gain: 0.15, bass: 0.4, mid: 0.45, treble: 0.7, presence: 0.65 }, '1x12', { comp: [0.75, 0.5] }) },
  { name: 'Reggae Skank', make: () => preset('clean', { gain: 0.15, bass: 0.3, mid: 0.6, treble: 0.65 }, '1x12', { delay: [0.4, 0.25, 0.2, 0, 0], reverb: [0.35, 0.5, 0.25, 0] }) },
  { name: 'Surf', make: () => preset('clean', { gain: 0.3, bass: 0.45, treble: 0.7 }, '2x12', { reverb: [0.65, 0.6, 0.6, 0], tremolo: [0.45, 0.3] }) },
  { name: 'Blues', make: () => preset('crunch', { gain: 0.35, mid: 0.6 }, '2x12', { odGreen: [0.3, 0.45, 0.6], reverb: [0.3, 0.45, 0.2, 0] }) },
  { name: 'Rock Clássico', make: () => preset('crunch', { gain: 0.6, mid: 0.55, treble: 0.55 }, '4x12') },
  { name: 'Hard Rock', make: () => preset('crunch', { gain: 0.8, bass: 0.55, mid: 0.6 }, '4x12', { gate: [0.45, 0.25], boost: [0.5, 0.2] }) },
  { name: 'Hardcore / Metal', make: () => preset('high', { gain: 0.7, bass: 0.6, mid: 0.4, treble: 0.6 }, '4x12', { gate: [0.55, 0.2], odGreen: [0, 0.6, 0.9] }) },
  { name: 'Fuzz Anos 60', make: () => preset('clean', { gain: 0.3 }, '2x12', { fuzz: [0.7, 0.45, 0.5] }) },
  { name: 'Lo-fi', make: () => preset('crunch', { gain: 0.4, bass: 0.3 }, '1x8', { tremolo: [0.35, 0.35] }) },
  { name: 'Baixo', make: () => preset('bass', { gain: 0.25, bass: 0.55 }, '8x10b', { comp: [0.5, 0.5] }) },
];

// ---------- Impulse responses das caixas (geradas: filtros aplicados a um impulso) ----------

function biquad(x: Float32Array, type: 'lowpass' | 'highpass' | 'peaking', f: number, sr: number, q = Math.SQRT1_2, db = 0) {
  const w = (2 * Math.PI * Math.min(f, sr * 0.45)) / sr;
  const cos = Math.cos(w), alpha = Math.sin(w) / (2 * q), A = 10 ** (db / 40);
  let b0, b1, b2, a0, a1, a2;
  if (type === 'lowpass') [b0, b1, b2, a0, a1, a2] = [(1 - cos) / 2, 1 - cos, (1 - cos) / 2, 1 + alpha, -2 * cos, 1 - alpha];
  else if (type === 'highpass') [b0, b1, b2, a0, a1, a2] = [(1 + cos) / 2, -(1 + cos), (1 + cos) / 2, 1 + alpha, -2 * cos, 1 - alpha];
  else [b0, b1, b2, a0, a1, a2] = [1 + alpha * A, -2 * cos, 1 - alpha * A, 1 + alpha / A, -2 * cos, 1 - alpha / A];
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const y = (b0 * x[i] + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2) / a0;
    x2 = x1; x1 = x[i]; y2 = y1; y1 = y;
    x[i] = y;
  }
}

const irCache = new WeakMap<BaseAudioContext, Map<string, AudioBuffer>>();

export function cabIR(ctx: BaseAudioContext, id: string): AudioBuffer | null {
  const spec = CABS.find((c) => c.id === id);
  if (!spec) return null;
  let cache = irCache.get(ctx);
  if (!cache) irCache.set(ctx, (cache = new Map()));
  const hit = cache.get(id);
  if (hit) return hit;

  const sr = ctx.sampleRate;
  const len = Math.floor(sr * 0.08);
  const d = new Float32Array(len);
  d[0] = 1;
  for (const [ms, g] of spec.taps) d[Math.round((ms / 1000) * sr)] += g;
  biquad(d, 'highpass', spec.hp, sr);
  for (const [f, db, q] of spec.peaks) biquad(d, 'peaking', f, sr, q, db);
  for (let i = 0; i < spec.lpOrder; i++) biquad(d, 'lowpass', spec.lp, sr, 0.6);
  for (let i = Math.floor(len * 0.6); i < len; i++) d[i] *= (len - i) / (len * 0.4); // fim suave
  const buf = ctx.createBuffer(1, len, sr);
  buf.getChannelData(0).set(d);
  cache.set(id, buf);
  return buf;
}

/** O ConvolverNode exige o IR na mesma taxa do contexto (a exportação roda a 44,1 kHz). */
function fitRate(ctx: BaseAudioContext, b: AudioBuffer): AudioBuffer {
  if (b.sampleRate === ctx.sampleRate) return b;
  const ratio = b.sampleRate / ctx.sampleRate;
  const len = Math.max(1, Math.floor(b.length / ratio));
  const out = ctx.createBuffer(b.numberOfChannels, len, ctx.sampleRate);
  for (let c = 0; c < b.numberOfChannels; c++) {
    const src = b.getChannelData(c), dst = out.getChannelData(c);
    for (let i = 0; i < len; i++) {
      const x = i * ratio, j = Math.floor(x), f = x - j;
      dst[i] = src[j] * (1 - f) + (src[j + 1] ?? 0) * f;
    }
  }
  return out;
}

// ---------- Blocos de áudio ----------

const curves = new Map<Curve, Float32Array<ArrayBuffer>>();
function curve(kind: Curve) {
  let c = curves.get(kind);
  if (!c) {
    const n = 4096;
    c = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1)) * 2 - 1;
      c[i] =
        kind === 'soft' ? Math.tanh(2.5 * x) / Math.tanh(2.5)
        : kind === 'hard' ? (7 * x) / (1 + 6 * Math.abs(x))
        // fita: ganho 1 nos sinais baixos (não realimenta o laço do delay), comprime só os picos
        : kind === 'tape' ? Math.tanh(1.5 * x) / 1.5
        : kind === 'germ' ? Math.tanh(1.4 * x) / Math.tanh(1.4) // diodo de germânio: joelho baixo e bem macio
        : x >= 0 ? Math.tanh(3 * x) / Math.tanh(3) : (-0.7 * Math.tanh(-6 * x)) / Math.tanh(6);
    }
    curves.set(kind, c);
  }
  return c;
}

/** Um efeito: caminho processado de `in` até `out`; `set` recebe os botões (0..1). */
interface Fx {
  in: AudioNode;
  out: AudioNode;
  set(p: number[]): void;
  oscs?: AudioScheduledSourceNode[];
}

type Put = (param: AudioParam, v: number) => void;

function filter(ctx: BaseAudioContext, type: BiquadFilterType, f: number, q = Math.SQRT1_2, db = 0) {
  const n = ctx.createBiquadFilter();
  n.type = type;
  n.frequency.value = f;
  n.Q.value = q;
  n.gain.value = db;
  return n;
}

function shaper(ctx: BaseAudioContext, kind: Curve) {
  const s = ctx.createWaveShaper();
  s.curve = curve(kind);
  s.oversample = '4x';
  return s;
}

function lfo(ctx: BaseAudioContext) {
  const o = ctx.createOscillator();
  const depth = ctx.createGain();
  o.connect(depth);
  o.start(0);
  return { o, depth };
}

const expMap = (v: number, a: number, b: number) => a * (b / a) ** v;

function drivePedal(ctx: BaseAudioContext, put: Put, hp: number, range: number, kind: Curve, toneA: number, toneB: number, outScale: number): Fx {
  const h = filter(ctx, 'highpass', hp);
  const pre = ctx.createGain();
  const sh = shaper(ctx, kind);
  const dc = filter(ctx, 'highpass', 25);
  const tone = filter(ctx, 'lowpass', 3000);
  const out = ctx.createGain();
  h.connect(pre).connect(sh).connect(dc).connect(tone).connect(out);
  return {
    in: h,
    out,
    set: ([drive, t, level]) => {
      put(pre.gain, 1 + drive * range);
      put(tone.frequency, expMap(t, toneA, toneB));
      put(out.gain, outScale * level * 2);
    },
  };
}

/**
 * Noise gate com nós nativos (funciona igual ao vivo e na exportação):
 * sinal → ganho (põe o limiar em ~0,4) → retificador |x| → passa-baixas (envelope) → curva de abertura.
 * A abertura segue por dois caminhos: um rápido (ataque, ~3,5 ms medido em simulação) e um lento (release). A soma, limitada
 * em 1, se comporta como o maior dos dois: abre na hora da palhetada e fecha devagar quando a nota morre.
 */
function noiseGate(ctx: BaseAudioContext, put: Put): Fx {
  const inp = ctx.createGain();
  const vca = ctx.createGain();
  vca.gain.value = 0;
  const pre = ctx.createGain();
  const rect = ctx.createWaveShaper();
  rect.curve = gateCurve('rect');
  const env = filter(ctx, 'lowpass', 150);
  const open = ctx.createWaveShaper();
  open.curve = gateCurve('open');
  const fast = filter(ctx, 'lowpass', 1 / (2 * Math.PI * 0.001));
  const rel = filter(ctx, 'lowpass', 5);
  const sum = ctx.createGain();
  const clamp = ctx.createWaveShaper();
  clamp.curve = gateCurve('clamp');
  inp.connect(vca);
  inp.connect(pre).connect(rect).connect(env).connect(open);
  open.connect(fast).connect(sum);
  open.connect(rel).connect(sum);
  sum.connect(clamp).connect(vca.gain);
  return {
    in: inp,
    out: vca,
    set: ([thr, release]) => {
      const db = -80 + thr * 50; // -80 dB a -30 dB
      put(pre.gain, 0.4 / 10 ** (db / 20));
      put(rel.frequency, 1 / (2 * Math.PI * (0.02 + release * 0.38))); // release de 20 ms a 400 ms
    },
  };
}

const gateCurves = new Map<string, Float32Array<ArrayBuffer>>();
function gateCurve(kind: 'rect' | 'open' | 'clamp') {
  let c = gateCurves.get(kind);
  if (!c) {
    const n = 2048;
    c = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1)) * 2 - 1;
      if (kind === 'rect') c[i] = Math.abs(x);
      // entradas acima de 1 ficam no último ponto da curva (1): é o limite da soma dos caminhos
      else if (kind === 'clamp') c[i] = Math.max(0, x);
      else {
        // fechado abaixo de 0,15, aberto acima de 0,35, transição suave no meio
        const t = Math.min(1, Math.max(0, (x - 0.15) / 0.2));
        c[i] = t * t * (3 - 2 * t);
      }
    }
    gateCurves.set(kind, c);
  }
  return c;
}

/** Passa-altas de 1ª ordem (um capacitor + um resistor): gira bem menos a fase que o biquad de 2ª ordem. */
function highpass1(ctx: BaseAudioContext, fc: number) {
  const k = Math.tan((Math.PI * fc) / ctx.sampleRate);
  return ctx.createIIRFilter([1 / (1 + k), -1 / (1 + k)], [1, (k - 1) / (1 + k)]);
}

/**
 * Overdrive com os diodos na realimentação do amplificador operacional (estilo TS808 / SD-1):
 * a saída é o sinal limpo + a parte clipada. Antes de clipar, um passa-altas em ~720 Hz tira os graves
 * só do caminho sujo, o que dá o "calombo" de médios e deixa o grave limpo e firme.
 */
function feedbackDrive(
  ctx: BaseAudioContext,
  put: Put,
  o: { min: number; range: number; curve: Curve; bassCut: number; hump: [number, number]; toneA: number; toneB: number; out: number },
): Fx {
  const inp = ctx.createGain();
  const sum = ctx.createGain();
  const hp = highpass1(ctx, 720);
  const pre = ctx.createGain();
  const sh = shaper(ctx, o.curve);
  const clipLevel = ctx.createGain();
  clipLevel.gain.value = 0.5; // os diodos limitam a parte suja a ~0,5 do sinal cheio
  inp.connect(sum); // caminho limpo
  inp.connect(hp).connect(pre).connect(sh).connect(clipLevel).connect(sum);
  const dc = filter(ctx, 'highpass', 30);
  const bass = filter(ctx, 'lowshelf', 250, 0.7, -o.bassCut); // grave enxuto na saída
  const hump = filter(ctx, 'peaking', o.hump[0], 0.7, o.hump[1]);
  const tone = filter(ctx, 'lowpass', 3000, 0.6);
  const out = ctx.createGain();
  sum.connect(dc).connect(bass).connect(hump).connect(tone).connect(out);
  return {
    in: inp,
    out,
    set: ([drive, t, level]) => {
      put(pre.gain, o.min + drive * o.range);
      put(tone.frequency, expMap(t, o.toneA, o.toneB));
      put(out.gain, o.out * level * 2);
    },
  };
}

/**
 * Overdrive transparente (estilo Klon Centaur): o botão de ganho é duplo, baixa o caminho limpo
 * (banda cheia, graves intactos) enquanto sobe o caminho sujo (diodos de germânio, bem macios).
 * Com pouco ganho funciona quase como um boost limpo.
 */
function transparentDrive(ctx: BaseAudioContext, put: Put): Fx {
  const inp = ctx.createGain();
  const clean = ctx.createGain();
  const hp = highpass1(ctx, 250);
  const pre = ctx.createGain();
  const sh = shaper(ctx, 'germ');
  const lp = filter(ctx, 'lowpass', 6500);
  const dirty = ctx.createGain();
  const sum = ctx.createGain();
  inp.connect(clean).connect(sum);
  inp.connect(hp).connect(pre).connect(sh).connect(lp).connect(dirty).connect(sum);
  const mid = filter(ctx, 'peaking', 1000, 0.8, 0.5);
  const treble = filter(ctx, 'highshelf', 1500);
  const dc = filter(ctx, 'highpass', 30);
  const out = ctx.createGain();
  sum.connect(mid).connect(treble).connect(dc).connect(out);
  return {
    in: inp,
    out,
    set: ([gain, tr, level]) => {
      put(clean.gain, 1 - gain * 0.5);
      put(pre.gain, 1 + gain * 50);
      put(dirty.gain, 0.1 + gain * 0.35);
      put(treble.gain, (tr - 0.5) * 20);
      put(out.gain, 0.5 * level * 2);
    },
  };
}

/** Estado de um pedal no rack; projetos salvos antes da troca do overdrive genérico usam o Verde no lugar dele. */
export function pedalOf(rig: AmpRig, d: PedalDef) {
  return rig.pedals[d.id] ?? (d.id === 'odGreen' ? rig.pedals.od : undefined) ?? { on: false, p: pedalDefaults(d) };
}

// ---------- Reverb: respostas ao impulso de mola e de sala ----------

/**
 * Mola: o som vai e volta numa mola de aço. A cada ida e volta ele passa por uma cascata de filtros
 * passa-tudo, que atrasam mais os graves que os agudos (dispersão): é isso que produz o "boing" metálico.
 * Duas molas de comprimentos diferentes por canal, como nos tanques reais de 2 e 3 molas.
 */
function springIR(sr: number, seconds: number): Float32Array[] {
  const len = Math.ceil(sr * (seconds + 0.2));
  const springs = [
    { T: 0.0333, a: 0.62 },
    { T: 0.0417, a: 0.58 },
    { T: 0.0291, a: 0.66 },
  ];
  const chans = [[0, 1], [1, 2]].map((ids) => {
    const out = new Float32Array(len);
    for (const id of ids) {
      const { T, a } = springs[id];
      const g = 10 ** ((-3 * T) / seconds); // queda por ida e volta para chegar a -60 dB em `seconds`
      const S = Math.round(0.05 * sr);
      const chirp = new Float32Array(S);
      chirp[0] = 1;
      let amp = 1;
      for (let k = 0; ; k++) {
        // mais um trecho de mola: 24 passa-tudo de 1ª ordem em série
        for (let st = 0; st < 24; st++) {
          let x1 = 0, y1 = 0;
          for (let n = 0; n < S; n++) {
            const x = chirp[n];
            const y = -a * x + x1 + a * y1;
            x1 = x; y1 = y; chirp[n] = y;
          }
        }
        const off = Math.round((0.004 + k * T) * sr);
        if (off >= len || amp < 1e-3) break;
        const sign = k % 2 ? -1 : 1; // a reflexão na ponta da mola inverte a fase
        for (let n = 0; n < S && off + n < len; n++) out[off + n] += sign * amp * chirp[n];
        amp *= g;
      }
    }
    biquad(out, 'highpass', 220, sr);
    biquad(out, 'peaking', 1600, sr, 1.2, 4); // o "brilho" característico do tanque
    biquad(out, 'lowpass', 5200, sr);
    return out;
  });
  return chans;
}

/** Sala (sem mola): reflexões iniciais + cauda de ruído que escurece com o tempo, independente em cada canal. */
function hallIR(sr: number, seconds: number): Float32Array[] {
  const len = Math.ceil(sr * seconds);
  const pre = Math.round(0.014 * sr);
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
  return [0, 1].map((c) => {
    const bright = new Float32Array(len), dark = new Float32Array(len);
    for (let n = pre; n < len; n++) {
      const t = (n - pre) / sr;
      bright[n] = rnd() * Math.exp((-6.9 * t) / (seconds * 0.45));
      dark[n] = rnd() * Math.exp((-6.9 * t) / seconds);
    }
    biquad(dark, 'lowpass', 2200, sr);
    const out = new Float32Array(len);
    for (let n = 0; n < len; n++) out[n] = 0.6 * bright[n] + dark[n];
    // reflexões iniciais (paredes próximas), diferentes em cada canal
    for (const [ms, g] of c ? [[11, 0.5], [19, -0.35], [31, 0.28], [47, -0.2]] : [[9, 0.55], [23, -0.3], [37, 0.25], [53, 0.18]]) {
      out[Math.round(((pre / sr) + ms / 1000) * sr)] += g * 3;
    }
    biquad(out, 'highpass', 120, sr);
    return out;
  });
}

const reverbCache = new WeakMap<BaseAudioContext, Map<string, AudioBuffer>>();
/** IR do reverb (em cache): `spring` true = mola; `step` = tempo quantizado (0..15) para não recalcular a cada movimento. */
function reverbIR(ctx: BaseAudioContext, spring: boolean, step: number): AudioBuffer {
  let cache = reverbCache.get(ctx);
  if (!cache) reverbCache.set(ctx, (cache = new Map()));
  const key = `${spring}|${step}`;
  let buf = cache.get(key);
  if (!buf) {
    const t = step / 15;
    const seconds = spring ? 0.8 + t * 2.7 : 0.8 + t * 4.2; // mola 0,8–3,5 s · sala 0,8–5 s
    const chans = spring ? springIR(ctx.sampleRate, seconds) : hallIR(ctx.sampleRate, seconds);
    buf = ctx.createBuffer(2, chans[0].length, ctx.sampleRate);
    chans.forEach((d, c) => buf!.getChannelData(c).set(d));
    cache.set(key, buf);
  }
  return buf;
}

/** Pedal de reverb: troca de IR (tipo/tempo) com crossfade entre dois convolvers, sem estalo. */
function reverbPedal(ctx: BaseAudioContext, put: Put): Fx {
  const inp = ctx.createGain(), out = ctx.createGain(), wet = ctx.createGain();
  const hp = filter(ctx, 'highpass', 120);
  const tone = filter(ctx, 'lowpass', 5000);
  inp.connect(out); // sinal seco
  inp.connect(hp);
  tone.connect(wet).connect(out);
  let cur: { conv: ConvolverNode; g: GainNode } | null = null;
  let key = '';
  return {
    in: inp,
    out,
    set: ([time, t, mix, kind]) => {
      put(tone.frequency, expMap(t, 1500, 9000));
      put(wet.gain, mix * 1.2);
      const spring = (kind ?? 0) < 0.5;
      const step = Math.round(time * 15);
      const k = `${spring}|${step}`;
      if (k === key) return;
      key = k;
      const conv = ctx.createConvolver();
      conv.buffer = reverbIR(ctx, spring, step);
      const g = ctx.createGain();
      hp.connect(conv).connect(g).connect(tone);
      const old = cur;
      cur = { conv, g };
      if (!old) return;
      const now = ctx.currentTime;
      g.gain.setValueAtTime(0, now);
      g.gain.linearRampToValueAtTime(1, now + 0.08);
      old.g.gain.setValueAtTime(1, now);
      old.g.gain.linearRampToValueAtTime(0, now + 0.08);
      setTimeout(() => { old.conv.disconnect(); old.g.disconnect(); }, 200);
    },
  };
}

// ---------- Delay: fita ou digital, mono ou estéreo (ping-pong) ----------

interface DelayNet {
  input: GainNode;
  output: GainNode;
  oscs: OscillatorNode[];
  set(time: number, rep: number, put: Put): void;
}

/**
 * Uma rede de delay. Fita: repetições cada vez mais escuras e finas, saturação da fita no laço e
 * variação de velocidade (wow lento + flutter rápido). Digital: repetições limpas e iguais.
 * Estéreo: ping-pong, a 1ª repetição na esquerda, a seguinte na direita e assim por diante.
 */
function delayNet(ctx: BaseAudioContext, tape: boolean, stereo: boolean): DelayNet {
  const input = ctx.createGain(), output = ctx.createGain();
  const oscs: OscillatorNode[] = [];
  const line = () => {
    const d = ctx.createDelay(2.5);
    const hp = filter(ctx, 'highpass', tape ? 140 : 20);
    const lp = filter(ctx, 'lowpass', tape ? 2600 : 12000);
    const fb = ctx.createGain();
    let node: AudioNode = d.connect(hp).connect(lp);
    if (tape) node = node.connect(shaper(ctx, 'tape')); // a fita satura e comprime as repetições
    return { d, out: node, fb };
  };
  const lines = stereo ? [line(), line()] : [line()];
  if (stereo) {
    const [L, R] = lines;
    const merge = ctx.createChannelMerger(2);
    input.connect(L.d);
    L.out.connect(merge, 0, 0);
    R.out.connect(merge, 0, 1);
    L.out.connect(L.fb).connect(R.d); // esquerda → direita
    R.out.connect(R.fb).connect(L.d); // direita → esquerda
    merge.connect(output);
  } else {
    const [M] = lines;
    input.connect(M.d);
    M.out.connect(M.fb).connect(M.d);
    M.out.connect(output);
  }
  // fita: wow (0,5 Hz) e flutter (6 Hz) mexem no tempo do delay → leve oscilação de afinação
  const wowDepth = ctx.createGain(), flutDepth = ctx.createGain();
  if (tape) {
    for (const [f, g] of [[0.5, wowDepth], [6.2, flutDepth]] as const) {
      const o = ctx.createOscillator();
      o.frequency.value = f;
      o.connect(g);
      for (const l of lines) g.connect(l.d.delayTime);
      o.start(0);
      oscs.push(o);
    }
  }
  return {
    input, output, oscs,
    set: (time, rep, put) => {
      const t = 0.06 + time * 0.94;
      for (const l of lines) {
        put(l.d.delayTime, t);
        put(l.fb.gain, rep * (tape ? 0.95 : 0.85)); // a saturação da fita segura o laço, então dá para ir mais longe
      }
      if (tape) {
        put(wowDepth.gain, 0.0012 + t * 0.002);
        put(flutDepth.gain, 0.00015);
      }
    },
  };
}

/** Pedal de delay: troca de tipo/saída monta outra rede e faz crossfade com a anterior. */
function delayPedal(ctx: BaseAudioContext, put: Put): Fx {
  const inp = ctx.createGain(), out = ctx.createGain(), wet = ctx.createGain();
  inp.connect(out); // sinal seco
  wet.connect(out);
  let cur: { net: DelayNet; g: GainNode } | null = null;
  let key = '';
  const fx: Fx = {
    in: inp,
    out,
    oscs: [],
    set: ([time, rep, mix, kind, side]) => {
      put(wet.gain, mix);
      const tape = (kind ?? 0) < 0.5;
      const stereo = (side ?? 0) >= 0.5;
      const k = `${tape}|${stereo}`;
      if (k !== key) {
        key = k;
        const net = delayNet(ctx, tape, stereo);
        const g = ctx.createGain();
        inp.connect(net.input);
        net.output.connect(g).connect(wet);
        const old = cur;
        cur = { net, g };
        fx.oscs = net.oscs;
        if (old) {
          // as repetições antigas morrem aos poucos enquanto as novas entram
          const now = ctx.currentTime;
          inp.disconnect(old.net.input);
          g.gain.setValueAtTime(0, now);
          g.gain.linearRampToValueAtTime(1, now + 0.05);
          old.g.gain.setTargetAtTime(0, now + 0.05, 0.25);
          setTimeout(() => {
            old.g.disconnect();
            old.net.output.disconnect();
            for (const o of old.net.oscs) o.stop();
          }, 2500);
        }
      }
      cur!.net.set(time, rep, put);
    },
  };
  return fx;
}

// ---------- Pitch shifter ----------

const PITCH_WINDOW = 0.05; // s: janela de cada "grão" (latência ~25 ms; menor = mais metálico, maior = mais eco)
const rampCache = new WeakMap<BaseAudioContext, { saw: AudioBuffer; win: AudioBuffer }>();

/** Ciclo de dente de serra (0→1) e janela sin² (zero nas pontas), tocados em loop como moduladores. */
function pitchRamps(ctx: BaseAudioContext) {
  let r = rampCache.get(ctx);
  if (!r) {
    const n = 4096;
    const saw = ctx.createBuffer(1, n, ctx.sampleRate), win = ctx.createBuffer(1, n, ctx.sampleRate);
    const s = saw.getChannelData(0), w = win.getChannelData(0);
    for (let i = 0; i < n; i++) {
      s[i] = i / n;
      w[i] = Math.sin((Math.PI * i) / n) ** 2;
    }
    rampCache.set(ctx, (r = { saw, win }));
  }
  return r;
}

/**
 * Pitch shifter de linha de atraso (nós nativos: funciona ao vivo e na exportação). Duas vozes leem o
 * sinal com um atraso que cresce ou encolhe em rampa: atraso encolhendo = lê mais rápido = mais agudo.
 * Quando a rampa chega ao fim ela salta de volta; nesse instante a janela daquela voz está em zero e a
 * outra voz (meio ciclo defasada, janela no máximo) cobre o salto. sin² + cos² = 1: volume constante.
 */
function pitchPedal(ctx: BaseAudioContext, put: Put): Fx {
  const inp = ctx.createGain(), out = ctx.createGain(), dry = ctx.createGain(), wet = ctx.createGain();
  const tone = filter(ctx, 'lowpass', 7000); // o som transposto para cima fica áspero: arredonda
  inp.connect(dry).connect(out);
  tone.connect(wet).connect(out);
  const { saw, win } = pitchRamps(ctx);
  const base = ctx.createConstantSource();
  base.start(0);
  const loops: AudioBufferSourceNode[] = [];
  const depths: GainNode[] = [];
  const looped = (buf: AudioBuffer, offset: number) => {
    const s = ctx.createBufferSource();
    s.buffer = buf;
    s.loop = true;
    s.start(0, offset * buf.duration);
    loops.push(s);
    return s;
  };
  for (const phase of [0, 0.5]) {
    const d = ctx.createDelay(PITCH_WINDOW * 2 + 0.02);
    d.delayTime.value = 0;
    const depth = ctx.createGain();
    looped(saw, phase).connect(depth).connect(d.delayTime);
    base.connect(d.delayTime);
    depths.push(depth);
    const vca = ctx.createGain();
    vca.gain.value = 0;
    looped(win, phase).connect(vca.gain);
    inp.connect(d).connect(vca).connect(tone);
  }
  return {
    in: inp,
    out,
    oscs: [base, ...loops],
    set: ([interval, fine, mix]) => {
      const ratio = 2 ** ((pitchSemis(interval ?? 1) + ((fine ?? 0.5) - 0.5)) / 12);
      // velocidade da rampa: o atraso muda (1 - ratio) segundos por segundo
      const rate = (saw.duration * Math.abs(1 - ratio)) / PITCH_WINDOW;
      for (const s of loops) put(s.playbackRate, rate);
      // acima: atraso de W até 0 (encolhendo) · abaixo: de 0 até W (crescendo)
      const up = ratio > 1;
      put(base.offset, 0.002 + (up ? PITCH_WINDOW : 0));
      // sem transposição as rampas param: as duas vozes ficam no mesmo atraso (sem filtro de pente)
      const still = Math.abs(1 - ratio) < 1e-4;
      for (const g of depths) put(g.gain, still ? 0 : up ? -PITCH_WINDOW : PITCH_WINDOW);
      const m = mix ?? 0.5;
      put(dry.gain, Math.min(1, 2 * (1 - m)));
      put(wet.gain, Math.min(1, 2 * m));
    },
  };
}

// ---------- Wah ----------

/**
 * Wah: passa-banda ressonante que varre de ~350 Hz (pedal fechado, som "abafado") a ~2,4 kHz (aberto,
 * "quack"). No modo Auto um seguidor de envelope (retificador + passa-baixas, como no noise gate) soma
 * a força do sinal à frequência: a palhetada abre o filtro e ele fecha conforme a nota morre.
 */
/** Frequência do wah (Hz) para uma posição 0..1 do pedal; no modo Auto a posição é só o ponto de partida. */
const wahFreq = (pos: number, auto: boolean) => expMap(pos, 350, 2400) * (auto ? 0.6 : 1);

/** Posição do wah vinda da automação: número = posição fixa (parado no cursor); 'scheduled' = a automação agenda a curva. */
export type WahOverride = number | 'scheduled' | undefined;

interface WahFx extends Fx {
  /** parâmetro (Hz) que a automação agenda e a conversão posição → Hz no modo atual */
  freq: AudioParam;
  toHz(pos: number): number;
  override(v: WahOverride): void;
}

function wahPedal(ctx: BaseAudioContext, put: Put): WahFx {
  const inp = ctx.createGain(), out = ctx.createGain(), wet = ctx.createGain(), dry = ctx.createGain();
  const bp = filter(ctx, 'bandpass', 800, 4);
  bp.frequency.value = 0; // a frequência vem toda das fontes abaixo (base + envelope)
  const base = ctx.createConstantSource();
  base.start(0);
  base.connect(bp.frequency);
  const rect = ctx.createWaveShaper();
  rect.curve = gateCurve('rect');
  const env = filter(ctx, 'lowpass', 9); // abre em ~20 ms e fecha devagar como a nota
  const amount = ctx.createGain();
  inp.connect(rect).connect(env).connect(amount).connect(bp.frequency);
  inp.connect(bp).connect(wet).connect(out);
  inp.connect(dry).connect(out); // um pouco do sinal direto mantém o corpo da nota
  let last: number[] = [];
  let over: WahOverride;
  let autoMode = false;
  const fx: WahFx = {
    in: inp,
    out,
    oscs: [base],
    freq: base.offset,
    toHz: (pos) => wahFreq(pos, autoMode),
    override: (v) => {
      over = v;
      fx.set(last);
    },
    set: (p) => {
      last = p;
      const [pos, sens, res, mode] = p;
      const auto = (autoMode = (mode ?? 0) >= 0.5);
      // automação tocando: a curva agendada manda na frequência (um put aqui brigaria com ela)
      if (over !== 'scheduled') put(base.offset, wahFreq(typeof over === 'number' ? over : pos ?? 0.5, auto));
      put(amount.gain, auto ? (sens ?? 0.5) * 9000 : 0);
      const q = 2 + (res ?? 0.5) * 8;
      put(bp.Q, q);
      put(wet.gain, 0.9 + q * 0.18); // o passa-banda estreito tira volume: compensa
      put(dry.gain, 0.12);
    },
  };
  return fx;
}

// ---------- Harmonizer ----------

/** Harmonizador: a voz de harmonia sai do AudioWorklet 'mm-harmony'; o sinal direto passa por fora. */
function harmonyPedal(ctx: BaseAudioContext, put: Put): Fx {
  const inp = ctx.createGain(), out = ctx.createGain();
  inp.connect(out);
  const node = workletsReady(ctx)
    ? new AudioWorkletNode(ctx, 'mm-harmony', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] })
    : null;
  if (node) inp.connect(node).connect(out);
  let sent = '';
  return {
    in: inp,
    out,
    set: ([key, step, voice, minor]) => {
      if (!node) return;
      put(node.parameters.get('level')!, (voice ?? 0.6) * 1.5);
      const msg = { key: harmonyKey(key ?? 0), minor: (minor ?? 0) >= 0.5, offset: HARMONY_STEPS[harmonyStep(step ?? HARMONY_DEF)].deg };
      const k = JSON.stringify(msg);
      if (k !== sent) {
        sent = k;
        node.port.postMessage(msg);
      }
    },
  };
}

// ---------- Octaver ----------

/**
 * Octaver: as oitavas abaixo saem do AudioWorklet 'mm-octave' (flip-flops, ver master.worklet.ts) e o
 * sinal direto passa por fora. Se os worklets ainda não carregaram, só o direto passa; o mixer remonta o
 * rack quando eles ficam prontos (ver rigKey no mixer).
 */
function octavePedal(ctx: BaseAudioContext, put: Put): Fx {
  const inp = ctx.createGain(), out = ctx.createGain(), dry = ctx.createGain();
  inp.connect(dry).connect(out);
  const node = workletsReady(ctx)
    ? new AudioWorkletNode(ctx, 'mm-octave', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] })
    : null;
  if (node) inp.connect(node).connect(out);
  return {
    in: inp,
    out,
    set: ([direct, sub1, sub2]) => {
      put(dry.gain, (direct ?? 0.7) * 1.4);
      if (!node) return;
      put(node.parameters.get('sub1')!, (sub1 ?? 0.6) * 3);
      put(node.parameters.get('sub2')!, (sub2 ?? 0) * 3);
    },
  };
}

function makePedal(ctx: BaseAudioContext, id: string, put: Put): Fx {
  switch (id) {
    case 'pitch': return pitchPedal(ctx, put);
    case 'octave': return octavePedal(ctx, put);
    case 'harmony': return harmonyPedal(ctx, put);
    case 'reverb': return reverbPedal(ctx, put);
    case 'gate': return noiseGate(ctx, put);
    case 'comp': {
      const c = ctx.createDynamicsCompressor();
      c.knee.value = 6;
      c.attack.value = 0.004;
      c.release.value = 0.18;
      const g = ctx.createGain();
      c.connect(g);
      return {
        in: c,
        out: g,
        set: ([s, lvl]) => {
          put(c.threshold, -12 - s * 38);
          put(c.ratio, 3 + s * 9);
          put(g.gain, (0.5 + lvl) * (1 + s * 2.5));
        },
      };
    }
    case 'wah': return wahPedal(ctx, put);
    case 'boost': {
      const g = ctx.createGain();
      const hs = filter(ctx, 'highshelf', 2500);
      g.connect(hs);
      return { in: g, out: hs, set: ([gain, bright]) => { put(g.gain, 1 + gain * 7); put(hs.gain, bright * 10); } };
    }
    case 'odGreen':
      return feedbackDrive(ctx, put, { min: 12, range: 106, curve: 'soft', bassCut: 9, hump: [720, 4], toneA: 800, toneB: 5000, out: 0.37 });
    case 'odYellow':
      return feedbackDrive(ctx, put, { min: 10, range: 120, curve: 'asym', bassCut: 6, hump: [900, 2], toneA: 1500, toneB: 9000, out: 0.4 });
    case 'odGold':
      return transparentDrive(ctx, put);
    case 'dist': return drivePedal(ctx, put, 120, 250, 'hard', 1200, 9000, 0.25);
    case 'fuzz': return drivePedal(ctx, put, 60, 600, 'asym', 700, 6000, 0.25);
    case 'chorus': {
      const inp = ctx.createGain(), out = ctx.createGain(), wet = ctx.createGain();
      const d = ctx.createDelay(0.05);
      d.delayTime.value = 0.012;
      const l = lfo(ctx);
      l.depth.connect(d.delayTime);
      inp.connect(out);
      inp.connect(d).connect(wet).connect(out);
      return {
        in: inp, out, oscs: [l.o],
        set: ([rate, depth, mix]) => {
          put(l.o.frequency, 0.1 + rate * 4);
          put(l.depth.gain, 0.0003 + depth * 0.004);
          put(wet.gain, mix);
          put(out.gain, 1 / (1 + mix * 0.5));
        },
      };
    }
    case 'phaser': {
      const inp = ctx.createGain(), out = ctx.createGain(), wet = ctx.createGain();
      const l = lfo(ctx);
      let node: AudioNode = inp;
      for (let i = 0; i < 4; i++) {
        const ap = filter(ctx, 'allpass', 1000, 0.5);
        l.depth.connect(ap.frequency);
        node = node.connect(ap);
      }
      node.connect(wet).connect(out);
      inp.connect(out);
      return {
        in: inp, out, oscs: [l.o],
        set: ([rate, depth, amt]) => {
          put(l.o.frequency, 0.05 + rate * 3);
          put(l.depth.gain, 100 + depth * 800);
          put(wet.gain, amt);
          put(out.gain, 1 / (1 + amt * 0.5));
        },
      };
    }
    case 'flanger': {
      // eco de 3 a ~11 ms varrido por um LFO lento; a realimentação reforça os picos do filtro de pente.
      // (num laço o Web Audio não deixa o atraso abaixo de 128 amostras, ~2,7 ms: o piso fica logo acima)
      const inp = ctx.createGain(), out = ctx.createGain(), wet = ctx.createGain(), fb = ctx.createGain();
      const d = ctx.createDelay(0.02);
      const dc = filter(ctx, 'highpass', 30); // o laço de realimentação não acumula grave/DC
      const l = lfo(ctx);
      l.depth.connect(d.delayTime);
      inp.connect(out);
      inp.connect(d);
      d.connect(wet).connect(out);
      d.connect(dc).connect(fb).connect(d);
      return {
        in: inp, out, oscs: [l.o],
        set: ([rate, depth, regen]) => {
          const sweep = 0.0005 + depth * 0.0035; // meia excursão do atraso
          put(l.o.frequency, 0.05 + rate * 2);
          put(d.delayTime, 0.003 + sweep);
          put(l.depth.gain, sweep);
          put(fb.gain, regen * 0.85);
          put(wet.gain, 0.8);
          put(out.gain, 0.75 * (1 - regen * 0.3)); // segura o volume quando a realimentação sobe
        },
      };
    }
    case 'vibrato': {
      // atraso varrido por um LFO, 100% molhado: a afinação sobe e desce. A profundidade fixa o desvio
      // de afinação (até ~±1 semitom); o quanto o atraso varia depende da velocidade (desvio = 2π·f·A).
      const d = ctx.createDelay(0.06);
      const l = lfo(ctx);
      l.depth.connect(d.delayTime);
      return {
        in: d, out: d, oscs: [l.o],
        set: ([rate, depth]) => {
          const f = expMap(rate, 0.5, 10);
          const amp = ((depth * 0.06) / (2 * Math.PI * f)); // segundos
          put(l.o.frequency, f);
          put(l.depth.gain, amp);
          put(d.delayTime, 0.001 + amp);
        },
      };
    }
    case 'tremolo': {
      const vca = ctx.createGain();
      const l = lfo(ctx);
      l.depth.connect(vca.gain);
      return {
        in: vca, out: vca, oscs: [l.o],
        set: ([rate, depth]) => {
          put(l.o.frequency, 1 + rate * 11);
          put(vca.gain, 1 - depth / 2);
          put(l.depth.gain, depth / 2);
        },
      };
    }
    default: return delayPedal(ctx, put);
  }
}

/** Curvas das válvulas (pré e potência), amostradas uma vez. */
const tubeCurves = new Map<string, Float32Array<ArrayBuffer>>();
function tubeShaper(ctx: BaseAudioContext, kind: 'triode' | 'power') {
  let c = tubeCurves.get(kind);
  if (!c) {
    const n = 4096, fn = kind === 'triode' ? triode : powerTube;
    c = new Float32Array(n);
    for (let i = 0; i < n; i++) c[i] = fn((i / (n - 1)) * 2 - 1);
    tubeCurves.set(kind, c);
  }
  const s = ctx.createWaveShaper();
  s.curve = c;
  s.oversample = '4x';
  return s;
}

/**
 * Tone stack passivo como filtro IIR de 3ª ordem. O IIRFilterNode não aceita trocar os coeficientes,
 * então cada mudança de botão cria um filtro novo e faz um crossfade curto com o anterior.
 */
class ToneStack {
  input: GainNode;
  output: GainNode;
  private cur: { f: IIRFilterNode; g: GainNode } | null = null;
  private last = '';
  private makeup: number;
  constructor(private ctx: BaseAudioContext, private parts: ToneStackParts) {
    this.input = ctx.createGain();
    this.output = ctx.createGain();
    // com os botões no meio, 1 kHz passa com ganho 1 (o circuito passivo real perde uns 20 dB)
    const z = toneStackZ(parts, 0.5, 0.5, 0.5, ctx.sampleRate);
    this.makeup = 1 / magnitude(z.b, z.a, 1000, ctx.sampleRate);
    this.output.gain.value = this.makeup;
  }
  set(bass: number, mid: number, treble: number) {
    const key = `${bass}|${mid}|${treble}`;
    if (key === this.last) return;
    this.last = key;
    const z = toneStackZ(this.parts, bass, mid, treble, this.ctx.sampleRate);
    const f = this.ctx.createIIRFilter(z.b, z.a);
    const g = this.ctx.createGain();
    this.input.connect(f).connect(g).connect(this.output);
    const old = this.cur;
    this.cur = { f, g };
    if (!old) return;
    const now = this.ctx.currentTime;
    g.gain.setValueAtTime(0, now);
    g.gain.linearRampToValueAtTime(1, now + 0.03);
    old.g.gain.setValueAtTime(1, now);
    old.g.gain.linearRampToValueAtTime(0, now + 0.03);
    setTimeout(() => { old.f.disconnect(); old.g.disconnect(); }, 100);
  }
}

/** Um triodo de pré: ganho → curva da válvula → capacitor de acoplamento → corte de agudos (Miller). */
function triodeStage(ctx: BaseAudioContext, m: AmpModel, gain: number) {
  const g = ctx.createGain();
  g.gain.value = gain;
  const sh = tubeShaper(ctx, 'triode');
  const hp = highpass1(ctx, m.stageHp);
  const lp = filter(ctx, 'lowpass', m.stageLp);
  g.connect(sh).connect(hp).connect(lp);
  return { in: g, out: lp };
}

/**
 * Amplificador: entrada → 1º triodo → [tone stack, se for "early"] → pot de ganho (+ capacitor bright)
 * → demais triodos → [tone stack, se for "late"] → potência push-pull (master) → presença → saída.
 */
function makeAmp(ctx: BaseAudioContext, m: AmpModel, put: Put) {
  const inHp = highpass1(ctx, m.inHp);
  const v1 = triodeStage(ctx, m, m.v1);
  inHp.connect(v1.in);
  let node: AudioNode = v1.out;
  const stack = new ToneStack(ctx, m.stack);
  if (m.stackPos === 'early') {
    node.connect(stack.input);
    node = stack.output;
  }
  const pot = ctx.createGain();
  const bright = filter(ctx, 'highshelf', 2500);
  node = node.connect(pot).connect(bright);
  for (const g of m.stages) {
    const st = triodeStage(ctx, m, g);
    node.connect(st.in);
    node = st.out;
  }
  if (m.stackPos === 'late') {
    node.connect(stack.input);
    node = stack.output;
  }
  const drive = ctx.createGain();
  const power = tubeShaper(ctx, 'power');
  const presence = filter(ctx, 'highshelf', 3500);
  const out = ctx.createGain();
  node = node.connect(drive).connect(power).connect(presence);
  if (m.postLp) node = node.connect(filter(ctx, 'lowpass', m.postLp));
  node.connect(out);
  return {
    in: inHp,
    out,
    set: (k: AmpRig['knobs']) => {
      stack.set(k.bass, k.mid, k.treble);
      put(pot.gain, gainPot(k.gain));
      put(bright.gain, m.bright * (1 - k.gain));
      put(drive.gain, powerDrive(m, k.master));
      put(presence.gain, (k.presence - 0.5) * 12);
      put(out.gain, outGain(m, k.gain));
    },
  };
}

/** Pedal com chave liga/desliga (true bypass com crossfade curto para não estalar). */
class Slot {
  input: GainNode;
  output: GainNode;
  private dry: GainNode;
  private wet: GainNode;
  constructor(ctx: BaseAudioContext, public fx: Fx) {
    this.input = ctx.createGain();
    this.output = ctx.createGain();
    this.dry = ctx.createGain();
    this.wet = ctx.createGain();
    this.input.connect(this.dry).connect(this.output);
    this.input.connect(fx.in);
    fx.out.connect(this.wet).connect(this.output);
  }
  set(on: boolean, p: number[], put: Put) {
    put(this.dry.gain, on ? 0 : 1);
    put(this.wet.gain, on ? 1 : 0);
    this.fx.set(p);
  }
}

/** Identifica a estrutura do rack: se mudar, o rack é remontado; o resto só ajusta parâmetros. */
export const rigKey = (r: AmpRig, hasIr: boolean) => `${r.amp}|${r.cab}|${r.cab === 'user' ? `${r.irId}:${hasIr}` : ''}`;

export class Rig {
  input: GainNode;
  output: GainNode;
  private slots = new Map<string, Slot>();
  private amp: ReturnType<typeof makeAmp> | null = null;
  private cabDry: GainNode | null = null;
  private cabWet: GainNode | null = null;
  private first = true;
  /** pedal de wah (a posição dele pode ser automatizada) */
  wah: WahFx;
  private put: Put = (p, v) => {
    if (this.first) p.value = v;
    else p.setTargetAtTime(v, this.ctx.currentTime, 0.015);
  };

  constructor(private ctx: BaseAudioContext, public key: string, rig: AmpRig, userIr?: AudioBuffer) {
    this.input = ctx.createGain();
    this.output = ctx.createGain();
    for (const p of PEDALS) this.slots.set(p.id, new Slot(ctx, makePedal(ctx, p.id, this.put)));
    this.wah = this.slots.get('wah')!.fx as WahFx;

    let node: AudioNode = this.input;
    for (const p of PEDALS.filter((x) => !x.post)) {
      const s = this.slots.get(p.id)!;
      node.connect(s.input);
      node = s.output;
    }

    const model = AMPS.find((a) => a.id === rig.amp);
    if (model) {
      this.amp = makeAmp(ctx, model, this.put);
      node.connect(this.amp.in);
      node = this.amp.out;
    }

    const ir = rig.cab === 'user' ? userIr && fitRate(ctx, userIr) : cabIR(ctx, rig.cab);
    if (ir) {
      const conv = ctx.createConvolver();
      conv.buffer = ir;
      const sum = ctx.createGain();
      this.cabDry = ctx.createGain();
      this.cabWet = ctx.createGain();
      node.connect(this.cabDry).connect(sum);
      node.connect(conv).connect(this.cabWet).connect(sum);
      node = sum;
    }

    for (const p of PEDALS.filter((x) => x.post)) {
      const s = this.slots.get(p.id)!;
      node.connect(s.input);
      node = s.output;
    }
    node.connect(this.output);
    this.update(rig);
    this.first = false;
  }

  update(rig: AmpRig) {
    for (const p of PEDALS) {
      const st = pedalOf(rig, p);
      this.slots.get(p.id)!.set(st.on, st.p, this.put);
    }
    this.amp?.set(rig.knobs);
    if (this.cabDry && this.cabWet) {
      this.put(this.cabDry.gain, 1 - rig.cabMix);
      this.put(this.cabWet.gain, rig.cabMix);
    }
  }

  dispose() {
    this.input.disconnect();
    this.output.disconnect();
    for (const s of this.slots.values()) for (const o of s.fx.oscs ?? []) o.stop();
  }
}
