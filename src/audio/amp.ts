// Rack de guitarra/baixo: pedais → amplificador → caixa (impulse response) → pedais de modulação e tempo.
// Tudo roda no canal da trilha, então a gravação continua seca e o timbre pode ser trocado depois (re-amp).
import { AmpRig } from '../types';

// ---------- Definições ----------

export interface PedalDef {
  id: string;
  name: string;
  color: string;
  /** true = entra depois do amp e da caixa (modulação/tempo), como no loop de efeitos */
  post: boolean;
  params: { label: string; def: number }[];
}

export const PEDALS: PedalDef[] = [
  { id: 'comp', name: 'Compressor', color: '#38d9c0', post: false, params: [{ label: 'Sustain', def: 0.5 }, { label: 'Nível', def: 0.5 }] },
  { id: 'boost', name: 'Booster', color: '#e0b48a', post: false, params: [{ label: 'Ganho', def: 0.4 }, { label: 'Brilho', def: 0.3 }] },
  { id: 'od', name: 'Overdrive', color: '#9be15d', post: false, params: [{ label: 'Drive', def: 0.4 }, { label: 'Tom', def: 0.5 }, { label: 'Nível', def: 0.5 }] },
  { id: 'dist', name: 'Distorção', color: '#ffcf3f', post: false, params: [{ label: 'Drive', def: 0.5 }, { label: 'Tom', def: 0.5 }, { label: 'Nível', def: 0.5 }] },
  { id: 'fuzz', name: 'Fuzz', color: '#ff7a45', post: false, params: [{ label: 'Fuzz', def: 0.6 }, { label: 'Tom', def: 0.5 }, { label: 'Nível', def: 0.5 }] },
  { id: 'chorus', name: 'Chorus', color: '#5fb4ff', post: true, params: [{ label: 'Velocidade', def: 0.3 }, { label: 'Profund.', def: 0.5 }, { label: 'Mix', def: 0.5 }] },
  { id: 'phaser', name: 'Phaser', color: '#b98cff', post: true, params: [{ label: 'Velocidade', def: 0.25 }, { label: 'Profund.', def: 0.6 }, { label: 'Intens.', def: 0.6 }] },
  { id: 'tremolo', name: 'Tremolo', color: '#ff5fa2', post: true, params: [{ label: 'Velocidade', def: 0.4 }, { label: 'Profund.', def: 0.5 }] },
  { id: 'delay', name: 'Delay', color: '#a3b1c2', post: true, params: [{ label: 'Tempo', def: 0.35 }, { label: 'Repetições', def: 0.35 }, { label: 'Mix', def: 0.3 }] },
];

type Curve = 'soft' | 'hard' | 'asym';

interface AmpModel {
  id: string;
  name: string;
  desc: string;
  hp: number; // corte de graves na entrada (Hz)
  range1: number; // ganho máximo do 1º estágio
  range2: number; // ganho máximo do 2º estágio (0 = só um estágio)
  curve: Curve;
  lp: number; // filtro entre estágios (Hz)
  voice: [number, number, number]; // timbre próprio do amp: graves, médios, agudos (dB)
  out: number;
}

export const AMPS: AmpModel[] = [
  { id: 'clean', name: 'Limpo Americano', desc: 'Limpo e brilhante, médios cavados', hp: 70, range1: 5, range2: 0, curve: 'soft', lp: 9000, voice: [1, -3, 2], out: 0.9 },
  { id: 'jazz', name: 'Jazz Limpo', desc: 'Redondo e quente, sem brilho', hp: 60, range1: 3, range2: 0, curve: 'soft', lp: 5000, voice: [2, 1, -4], out: 1 },
  { id: 'crunch', name: 'Crunch Britânico', desc: 'Médios na cara, sujeira de válvula', hp: 100, range1: 40, range2: 0, curve: 'soft', lp: 7000, voice: [0, 3, 1], out: 0.35 },
  { id: 'high', name: 'Alto Ganho', desc: 'Distorção pesada e grave apertado', hp: 140, range1: 30, range2: 25, curve: 'hard', lp: 5500, voice: [3, -4, 2], out: 0.25 },
  { id: 'bass', name: 'Baixo Valvulado', desc: 'Grave cheio para baixo elétrico', hp: 30, range1: 6, range2: 0, curve: 'soft', lp: 6000, voice: [4, 0, -2], out: 0.8 },
];

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
    pedals: Object.fromEntries(PEDALS.map((p) => [p.id, { on: false, p: p.params.map((x) => x.def) }])),
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
  { name: 'Limpo Cristalino', make: () => preset('clean', { gain: 0.2, treble: 0.6 }, '2x12', { comp: [0.4, 0.5], chorus: [0.25, 0.4, 0.35] }) },
  { name: 'Funk', make: () => preset('clean', { gain: 0.15, bass: 0.4, mid: 0.45, treble: 0.7, presence: 0.65 }, '1x12', { comp: [0.75, 0.5] }) },
  { name: 'Reggae Skank', make: () => preset('clean', { gain: 0.15, bass: 0.3, mid: 0.6, treble: 0.65 }, '1x12', { delay: [0.4, 0.25, 0.2] }) },
  { name: 'Blues', make: () => preset('crunch', { gain: 0.35, mid: 0.6 }, '2x12', { od: [0.3, 0.45, 0.6] }) },
  { name: 'Rock Clássico', make: () => preset('crunch', { gain: 0.6, mid: 0.55, treble: 0.55 }, '4x12') },
  { name: 'Hard Rock', make: () => preset('crunch', { gain: 0.8, bass: 0.55, mid: 0.6 }, '4x12', { boost: [0.5, 0.2] }) },
  { name: 'Hardcore / Metal', make: () => preset('high', { gain: 0.7, bass: 0.6, mid: 0.4, treble: 0.6 }, '4x12', { od: [0, 0.6, 0.9] }) },
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
  oscs?: OscillatorNode[];
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

function makePedal(ctx: BaseAudioContext, id: string, put: Put): Fx {
  switch (id) {
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
    case 'boost': {
      const g = ctx.createGain();
      const hs = filter(ctx, 'highshelf', 2500);
      g.connect(hs);
      return { in: g, out: hs, set: ([gain, bright]) => { put(g.gain, 1 + gain * 7); put(hs.gain, bright * 10); } };
    }
    case 'od': return drivePedal(ctx, put, 280, 60, 'soft', 900, 7000, 0.35);
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
    default: {
      // delay
      const inp = ctx.createGain(), out = ctx.createGain(), wet = ctx.createGain(), fb = ctx.createGain();
      const d = ctx.createDelay(2);
      const damp = filter(ctx, 'lowpass', 2800);
      inp.connect(out);
      inp.connect(d).connect(damp).connect(fb).connect(d);
      damp.connect(wet).connect(out);
      return {
        in: inp, out,
        set: ([time, rep, mix]) => {
          put(d.delayTime, 0.06 + time * 0.94);
          put(fb.gain, rep * 0.85);
          put(wet.gain, mix);
        },
      };
    }
  }
}

function makeAmp(ctx: BaseAudioContext, m: AmpModel, put: Put) {
  const h = filter(ctx, 'highpass', m.hp);
  const pre1 = ctx.createGain();
  const sh1 = shaper(ctx, m.curve);
  const lp = filter(ctx, 'lowpass', m.lp);
  let node: AudioNode = h.connect(pre1).connect(sh1).connect(lp);
  let pre2: GainNode | null = null;
  if (m.range2) {
    pre2 = ctx.createGain();
    node = node.connect(pre2).connect(shaper(ctx, m.curve)).connect(filter(ctx, 'highpass', 30));
  }
  const bass = filter(ctx, 'lowshelf', 120);
  const mid = filter(ctx, 'peaking', 650, 0.7);
  const treble = filter(ctx, 'highshelf', 3000);
  const presence = filter(ctx, 'peaking', 5000, 0.9);
  const master = ctx.createGain();
  node.connect(bass).connect(mid).connect(treble).connect(presence).connect(master);
  const db = (v: number) => (v - 0.5) * 24;
  return {
    in: h,
    out: master,
    set: (k: AmpRig['knobs']) => {
      put(pre1.gain, 1 + k.gain * m.range1);
      if (pre2) put(pre2.gain, 1 + k.gain * m.range2);
      put(bass.gain, db(k.bass) + m.voice[0]);
      put(mid.gain, db(k.mid) + m.voice[1]);
      put(treble.gain, db(k.treble) + m.voice[2]);
      put(presence.gain, db(k.presence) / 2);
      put(master.gain, k.master * 2 * m.out);
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
  private put: Put = (p, v) => {
    if (this.first) p.value = v;
    else p.setTargetAtTime(v, this.ctx.currentTime, 0.015);
  };

  constructor(private ctx: BaseAudioContext, public key: string, rig: AmpRig, userIr?: AudioBuffer) {
    this.input = ctx.createGain();
    this.output = ctx.createGain();
    for (const p of PEDALS) this.slots.set(p.id, new Slot(ctx, makePedal(ctx, p.id, this.put)));

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
      const st = rig.pedals[p.id];
      this.slots.get(p.id)!.set(!!st?.on, st?.p ?? p.params.map((x) => x.def), this.put);
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
