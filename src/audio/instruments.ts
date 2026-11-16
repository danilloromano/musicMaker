// Instrumentos virtuais: sintetizadores subtrativos e bateria sintetizada.
// Tudo recebe um BaseAudioContext para funcionar igual em tempo real e na exportação offline.
import { playKitPiece } from './drumKit';
import { SampleOpts, startSampleVoice } from './sampler';

export interface SynthPreset {
  name: string;
  oscs: {
    type: OscillatorType;
    octave: number;
    detune: number;
    gain: number;
    /** receita de harmônicos (amplitude do 1º, 2º, 3º...): quando presente, substitui `type` */
    partials?: number[];
    /** este oscilador some sozinho em ~`decay` s (o resto da nota segue o envelope geral) */
    decay?: number;
  }[];
  a: number; // ataque (s)
  d: number; // decaimento (s)
  s: number; // sustentação (0..1)
  r: number; // relaxamento (s)
  cutoff: number; // Hz (em C4; acompanha a altura da nota)
  q: number;
  envAmt: number; // Hz somados ao cutoff no ataque
  fDecay: number; // s
  gain: number;
  /** grupo no seletor de instrumentos */
  group?: string;
  /** tocar mais forte deixa o som mais brilhante (abre o filtro) */
  velBright?: boolean;
  /** notas agudas decaem mais rápido (como as cordas de um piano) */
  keyDecay?: boolean;
  /** volume do "toc" do martelo no ataque (0 = sem) */
  hammer?: number;
  /** toca as gravações de um instrumento real (o resto do preset é o sintetizado de reserva, até elas carregarem) */
  sample?: SampleOpts;
}

// Harmônicos medidos/aproximados de cada instrumento (amplitude do 1º, 2º, 3º... harmônico)
const GRAND = [1, 0.62, 0.38, 0.32, 0.22, 0.16, 0.13, 0.11, 0.09, 0.075, 0.065, 0.06, 0.05, 0.045, 0.04, 0.035, 0.03, 0.025, 0.02, 0.016];
const UPRIGHT = [1, 0.7, 0.5, 0.45, 0.3, 0.25, 0.18, 0.12, 0.08, 0.06, 0.05, 0.045, 0.04, 0.032, 0.026, 0.02, 0.016, 0.012];
const FELT = [1, 0.35, 0.12, 0.06, 0.03];
const REED = [1, 0.25, 0.45, 0.15, 0.25, 0.08, 0.12, 0.05, 0.08, 0.03, 0.05, 0.02, 0.03]; // ímpares em destaque: o "rosnado" de palheta
const CLAV = [1, 0.85, 0.7, 0.6, 0.5, 0.4, 0.35, 0.3, 0.25, 0.2, 0.15, 0.12, 0.1, 0.08, 0.07, 0.06, 0.05, 0.04];
const HARPSI = [1, 0.75, 0.7, 0.55, 0.5, 0.4, 0.35, 0.3, 0.25, 0.2, 0.18, 0.15];
const TINE = [0, 0, 0, 0, 0, 0, 1]; // o "plim" metálico perto do 7º harmônico

export const PRESETS: Record<string, SynthPreset> = {
  // ---------- Pianos ----------
  grand: {
    name: 'Piano de Cauda', group: 'Pianos',
    // três cordas por nota, levemente desafinadas entre si: o brilho "vivo" do piano
    oscs: [
      { type: 'sine', octave: 0, detune: 0, gain: 0.5, partials: GRAND },
      { type: 'sine', octave: 0, detune: 2.5, gain: 0.3, partials: GRAND },
      { type: 'sine', octave: 0, detune: -2.5, gain: 0.3, partials: GRAND },
    ],
    a: 0.002, d: 3.6, s: 0, r: 0.55, cutoff: 650, q: 0.4, envAmt: 9000, fDecay: 0.8, gain: 0.42,
    velBright: true, keyDecay: true, hammer: 0.12,
    sample: { set: 'piano', gain: 0.63, release: 0.35, undampedFrom: 89 },
  },
  upright: {
    name: 'Piano de Armário', group: 'Pianos',
    oscs: [
      { type: 'sine', octave: 0, detune: 0, gain: 0.5, partials: UPRIGHT },
      { type: 'sine', octave: 0, detune: 4, gain: 0.32, partials: UPRIGHT },
      { type: 'sine', octave: 0, detune: -4, gain: 0.32, partials: UPRIGHT },
    ],
    a: 0.002, d: 2.4, s: 0, r: 0.4, cutoff: 800, q: 0.5, envAmt: 6000, fDecay: 0.6, gain: 0.56,
    velBright: true, keyDecay: true, hammer: 0.18,
    // o mesmo piano gravado, mais escuro e com abafador mais rápido
    sample: { set: 'piano', gain: 0.6, release: 0.25, undampedFrom: 89, cutoff: 2600, velBright: true },
  },
  honky: {
    name: 'Honky-tonk', group: 'Pianos',
    // cordas bem desafinadas entre si: o piano de bar de faroeste
    oscs: [
      { type: 'sine', octave: 0, detune: 0, gain: 0.45, partials: UPRIGHT },
      { type: 'sine', octave: 0, detune: 16, gain: 0.4, partials: UPRIGHT },
      { type: 'sine', octave: 0, detune: -14, gain: 0.3, partials: UPRIGHT },
    ],
    a: 0.002, d: 2.2, s: 0, r: 0.35, cutoff: 900, q: 0.6, envAmt: 6000, fDecay: 0.5, gain: 0.68,
    velBright: true, keyDecay: true, hammer: 0.2,
    // duas cópias do piano gravado desafinadas entre si
    sample: { set: 'piano', gain: 0.66, release: 0.3, undampedFrom: 89, cutoff: 5000, detune: [-13, 13] },
  },
  felt: {
    name: 'Piano Abafado', group: 'Pianos',
    // feltro entre o martelo e a corda: som macio e escuro, bom para lo-fi
    oscs: [
      { type: 'sine', octave: 0, detune: 0, gain: 0.6, partials: FELT },
      { type: 'sine', octave: 0, detune: 3, gain: 0.3, partials: FELT },
    ],
    a: 0.006, d: 2.8, s: 0, r: 0.6, cutoff: 420, q: 0.3, envAmt: 1400, fDecay: 0.5, gain: 0.37,
    velBright: true, keyDecay: true, hammer: 0.05,
    sample: { set: 'piano', gain: 0.58, release: 0.4, undampedFrom: 89, cutoff: 750, velBright: true },
  },
  epiano: {
    name: 'Piano Elétrico Suave', group: 'Pianos',
    oscs: [
      { type: 'triangle', octave: 0, detune: 0, gain: 0.8 },
      { type: 'sine', octave: 1, detune: 3, gain: 0.25 },
    ],
    a: 0.004, d: 1.4, s: 0.12, r: 0.35, cutoff: 1800, q: 0.5, envAmt: 3000, fDecay: 0.4, gain: 0.5,
  },
  tine: {
    name: 'Piano Elétrico de Lâmina', group: 'Pianos',
    // lâmina de metal: corpo redondo + um "plim" metálico que some logo
    oscs: [
      { type: 'sine', octave: 0, detune: 0, gain: 0.8 },
      { type: 'sine', octave: 1, detune: 0, gain: 0.12 },
      { type: 'sine', octave: 0, detune: 0, gain: 0.35, partials: TINE, decay: 0.25 },
    ],
    a: 0.002, d: 2.6, s: 0.15, r: 0.4, cutoff: 1100, q: 0.4, envAmt: 4500, fDecay: 0.5, gain: 0.36,
    velBright: true, keyDecay: true, hammer: 0.03,
  },
  reed: {
    name: 'Piano Elétrico de Palheta', group: 'Pianos',
    // palheta de metal: som anasalado que "rosna" quando se toca forte
    oscs: [{ type: 'sine', octave: 0, detune: 0, gain: 0.8, partials: REED }],
    a: 0.002, d: 1.8, s: 0.1, r: 0.25, cutoff: 700, q: 1.2, envAmt: 5500, fDecay: 0.35, gain: 0.47,
    velBright: true, keyDecay: true, hammer: 0.04,
  },
  clav: {
    name: 'Clavinete', group: 'Pianos',
    // corda batida e abafada logo: brilhante, curto e percussivo (funk)
    oscs: [{ type: 'sine', octave: 0, detune: 0, gain: 0.8, partials: CLAV }],
    a: 0.001, d: 0.8, s: 0.15, r: 0.04, cutoff: 900, q: 2.5, envAmt: 7000, fDecay: 0.2, gain: 0.92,
    velBright: true, hammer: 0.08,
  },
  harpsi: {
    name: 'Cravo', group: 'Pianos',
    // corda beliscada, com o registro de oitava acima ligado
    oscs: [
      { type: 'sine', octave: 0, detune: 0, gain: 0.6, partials: HARPSI },
      { type: 'sine', octave: 1, detune: 2, gain: 0.3, partials: HARPSI },
    ],
    a: 0.001, d: 1.8, s: 0, r: 0.3, cutoff: 6000, q: 0.5, envAmt: 2000, fDecay: 0.3, gain: 0.92,
    keyDecay: true, hammer: 0.12,
  },
  toy: {
    name: 'Piano de Brinquedo', group: 'Pianos',
    // barras de metal no lugar de cordas: agudo, desafinado e curto
    oscs: [
      { type: 'sine', octave: 0, detune: 0, gain: 0.7 },
      { type: 'sine', octave: 2, detune: 35, gain: 0.3, decay: 0.4 },
    ],
    a: 0.001, d: 1.2, s: 0, r: 0.15, cutoff: 7000, q: 0.3, envAmt: 0, fDecay: 0.1, gain: 0.55,
    keyDecay: true, hammer: 0.06,
  },

  // ---------- Teclados e synths ----------
  organ: {
    name: 'Órgão', group: 'Teclados e synths',
    oscs: [
      { type: 'sine', octave: 0, detune: 0, gain: 0.6 },
      { type: 'sine', octave: 1, detune: 0, gain: 0.35 },
      { type: 'sine', octave: 2, detune: 0, gain: 0.15 },
    ],
    a: 0.01, d: 0.1, s: 0.9, r: 0.08, cutoff: 6000, q: 0.3, envAmt: 0, fDecay: 0.1, gain: 0.4,
  },
  lead: {
    name: 'Synth Lead', group: 'Teclados e synths',
    oscs: [
      { type: 'sawtooth', octave: 0, detune: -6, gain: 0.5 },
      { type: 'square', octave: 0, detune: 6, gain: 0.3 },
    ],
    a: 0.01, d: 0.2, s: 0.7, r: 0.15, cutoff: 1400, q: 4, envAmt: 2500, fDecay: 0.3, gain: 0.32,
  },
  pad: {
    name: 'Pad Suave', group: 'Teclados e synths',
    oscs: [
      { type: 'sawtooth', octave: 0, detune: -8, gain: 0.4 },
      { type: 'sawtooth', octave: 0, detune: 8, gain: 0.4 },
      { type: 'triangle', octave: -1, detune: 0, gain: 0.3 },
    ],
    a: 0.5, d: 0.8, s: 0.8, r: 1.2, cutoff: 900, q: 1, envAmt: 600, fDecay: 1.5, gain: 0.25,
  },
  strings: {
    name: 'Cordas', group: 'Teclados e synths',
    oscs: [
      { type: 'sawtooth', octave: 0, detune: -10, gain: 0.4 },
      { type: 'sawtooth', octave: 0, detune: 10, gain: 0.4 },
      { type: 'sawtooth', octave: 1, detune: 4, gain: 0.15 },
    ],
    a: 0.15, d: 0.4, s: 0.85, r: 0.5, cutoff: 2200, q: 0.7, envAmt: 800, fDecay: 0.6, gain: 0.22,
  },
  // ---------- Baixos ----------
  ebass: {
    name: 'Baixo Elétrico', group: 'Baixos',
    oscs: [
      { type: 'sawtooth', octave: 0, detune: 0, gain: 0.5 },
      { type: 'sine', octave: 0, detune: 0, gain: 0.6 },
    ],
    a: 0.004, d: 0.6, s: 0.5, r: 0.08, cutoff: 700, q: 1, envAmt: 1500, fDecay: 0.15, gain: 0.55,
    sample: { set: 'bass', gain: 4.5, release: 0.08 },
  },
  bass: {
    name: 'Baixo Synth', group: 'Baixos',
    oscs: [
      { type: 'sawtooth', octave: 0, detune: 0, gain: 0.6 },
      { type: 'square', octave: -1, detune: 0, gain: 0.4 },
    ],
    a: 0.005, d: 0.25, s: 0.6, r: 0.1, cutoff: 1400, q: 3, envAmt: 2400, fDecay: 0.18, gain: 0.5,
  },
  pluck: {
    name: 'Pluck', group: 'Teclados e synths',
    oscs: [
      { type: 'sawtooth', octave: 0, detune: 0, gain: 0.6 },
      { type: 'sawtooth', octave: 1, detune: 5, gain: 0.2 },
    ],
    a: 0.002, d: 0.3, s: 0, r: 0.2, cutoff: 600, q: 2, envAmt: 5000, fDecay: 0.15, gain: 0.45,
  },
  bell: {
    name: 'Sino', group: 'Teclados e synths',
    oscs: [
      { type: 'sine', octave: 0, detune: 0, gain: 0.7 },
      { type: 'sine', octave: 2, detune: 14, gain: 0.25 },
      { type: 'sine', octave: 3, detune: -20, gain: 0.1 },
    ],
    a: 0.002, d: 1.8, s: 0, r: 0.8, cutoff: 8000, q: 0.3, envAmt: 0, fDecay: 0.1, gain: 0.4,
  },
};

export const DRUM_MAP = [
  { pitch: 49, name: 'Prato' },
  { pitch: 46, name: 'Chimbal aberto' },
  { pitch: 42, name: 'Chimbal fechado' },
  { pitch: 56, name: 'Cowbell' },
  { pitch: 50, name: 'Tom agudo' },
  { pitch: 48, name: 'Tom médio' },
  { pitch: 45, name: 'Tom grave' },
  { pitch: 39, name: 'Palmas' },
  { pitch: 38, name: 'Caixa' },
  { pitch: 36, name: 'Bumbo' },
];

export interface Voice {
  release(time: number): void;
}

const cancelHold = (p: AudioParam, t: number) => {
  if (p.cancelAndHoldAtTime) p.cancelAndHoldAtTime(t);
  else p.cancelScheduledValues(t);
};

export function startVoice(
  ctx: BaseAudioContext,
  dest: AudioNode,
  p: SynthPreset,
  pitch: number,
  t: number,
  vel: number,
): Voice {
  if (p.sample) {
    const sv = startSampleVoice(ctx, dest, p.sample, pitch, t, vel);
    if (sv) return sv;
  }
  const freq = 440 * 2 ** ((pitch - 69) / 12);
  const peak = p.gain * (vel / 127) ** 1.5;
  // piano: as notas agudas morrem mais depressa que as graves
  const d = p.keyDecay ? Math.max(0.15, p.d * 2 ** (-(pitch - 60) / 18)) : p.d;

  const vca = ctx.createGain();
  vca.gain.setValueAtTime(0, t);
  vca.gain.linearRampToValueAtTime(peak, t + p.a);
  vca.gain.setTargetAtTime(peak * p.s, t + p.a, Math.max(0.01, d / 3));

  const flt = ctx.createBiquadFilter();
  flt.type = 'lowpass';
  flt.Q.value = p.q;
  // tocar mais forte abre o filtro (som mais brilhante), como num piano de verdade: muda o ponto de
  // partida e o pico do ataque (fraco = abafado, forte = cheio de harmônicos agudos)
  const v = vel / 127;
  const base = Math.min(18000, p.cutoff * 2 ** ((pitch - 60) / 24) * (p.velBright ? 0.35 + 1.6 * v ** 1.5 : 1));
  const env = p.velBright ? p.envAmt * (0.1 + 0.9 * v ** 1.6) : p.envAmt;
  flt.frequency.setValueAtTime(Math.min(18000, base + env), t);
  flt.frequency.setTargetAtTime(base, t, Math.max(0.01, p.fDecay / 3));

  const oscs: AudioScheduledSourceNode[] = p.oscs.map((o) => {
    const osc = ctx.createOscillator();
    if (o.partials) osc.setPeriodicWave(periodicWave(ctx, o.partials));
    else osc.type = o.type;
    osc.frequency.value = freq * 2 ** o.octave;
    osc.detune.value = o.detune;
    const g = ctx.createGain();
    g.gain.value = o.gain;
    // decaimento próprio deste oscilador (ex.: o "plim" metálico do piano elétrico some antes do corpo)
    if (o.decay) g.gain.setTargetAtTime(o.gain * 0.02, t, o.decay / 3);
    osc.connect(g).connect(flt);
    osc.start(t);
    return osc;
  });

  // martelo: um "toc" curto de ruído filtrado no começo da nota
  if (p.hammer) {
    const n = ctx.createBufferSource();
    n.buffer = noiseBuffer(ctx);
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = Math.min(9000, 1800 * 2 ** ((pitch - 60) / 24));
    bp.Q.value = 0.8;
    const hg = ctx.createGain();
    const hpeak = p.hammer * (vel / 127) ** 2;
    hg.gain.setValueAtTime(hpeak, t);
    hg.gain.setTargetAtTime(0, t, 0.012);
    n.connect(bp).connect(hg).connect(vca);
    n.start(t);
    n.stop(t + 0.15);
  }
  flt.connect(vca).connect(dest);

  return {
    release(rt: number) {
      cancelHold(vca.gain, rt);
      vca.gain.setTargetAtTime(0, rt, Math.max(0.005, p.r / 4));
      const end = rt + p.r * 1.5 + 0.05;
      oscs.forEach((o) => o.stop(end));
    },
  };
}

/** Onda periódica com a receita de harmônicos dada (amplitude do 1º, 2º, 3º... harmônico), em cache. */
const waveCache = new WeakMap<BaseAudioContext, Map<string, PeriodicWave>>();
function periodicWave(ctx: BaseAudioContext, partials: number[]): PeriodicWave {
  let cache = waveCache.get(ctx);
  if (!cache) waveCache.set(ctx, (cache = new Map()));
  const key = partials.join(',');
  let w = cache.get(key);
  if (!w) {
    const imag = new Float32Array(partials.length + 1);
    partials.forEach((a, i) => (imag[i + 1] = a));
    w = ctx.createPeriodicWave(new Float32Array(partials.length + 1), imag);
    cache.set(key, w);
  }
  return w;
}

// ---------- Bateria ----------

const noiseCache = new WeakMap<BaseAudioContext, AudioBuffer>();
function noiseBuffer(ctx: BaseAudioContext): AudioBuffer {
  let b = noiseCache.get(ctx);
  if (!b) {
    b = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const d = b.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    noiseCache.set(ctx, b);
  }
  return b;
}

/** Bateria: kit acústico modelado (ver drumKit.ts); notas fora do kit dão um toque curto de ruído. */
export function playDrum(ctx: BaseAudioContext, dest: AudioNode, pitch: number, t: number, vel: number) {
  if (playKitPiece(ctx, dest, pitch, t, vel)) return;
  const src = ctx.createBufferSource();
  src.buffer = noiseBuffer(ctx);
  const f = ctx.createBiquadFilter();
  f.type = 'bandpass';
  f.frequency.value = 3000;
  f.Q.value = 2;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.3 * (vel / 127) ** 1.3, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + 0.08);
  src.connect(f).connect(g).connect(dest);
  src.start(t, Math.random());
  src.stop(t + 0.13);
}

/** Dispara uma nota com duração conhecida (reprodução e exportação). */
export function triggerNote(
  ctx: BaseAudioContext,
  dest: AudioNode,
  kind: string,
  instrument: string,
  pitch: number,
  t: number,
  dur: number,
  vel: number,
) {
  if (kind === 'drums') playDrum(ctx, dest, pitch, t, vel);
  else startVoice(ctx, dest, PRESETS[instrument] ?? PRESETS.epiano, pitch, t, vel).release(t + dur);
}

/** Instrumentos agrupados para os seletores, na ordem em que aparecem. */
export function presetGroups(): { group: string; items: [string, SynthPreset][] }[] {
  const groups = new Map<string, [string, SynthPreset][]>();
  for (const [id, p] of Object.entries(PRESETS)) {
    const g = p.group ?? 'Outros';
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g)!.push([id, p]);
  }
  return [...groups].map(([group, items]) => ({ group, items }));
}
