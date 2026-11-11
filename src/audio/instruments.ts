// Instrumentos virtuais: sintetizadores subtrativos e bateria sintetizada.
// Tudo recebe um BaseAudioContext para funcionar igual em tempo real e na exportação offline.

export interface SynthPreset {
  name: string;
  oscs: { type: OscillatorType; octave: number; detune: number; gain: number }[];
  a: number; // ataque (s)
  d: number; // decaimento (s)
  s: number; // sustentação (0..1)
  r: number; // relaxamento (s)
  cutoff: number; // Hz (em C4; acompanha a altura da nota)
  q: number;
  envAmt: number; // Hz somados ao cutoff no ataque
  fDecay: number; // s
  gain: number;
}

export const PRESETS: Record<string, SynthPreset> = {
  epiano: {
    name: 'Piano Elétrico',
    oscs: [
      { type: 'triangle', octave: 0, detune: 0, gain: 0.8 },
      { type: 'sine', octave: 1, detune: 3, gain: 0.25 },
    ],
    a: 0.004, d: 1.4, s: 0.12, r: 0.35, cutoff: 1800, q: 0.5, envAmt: 3000, fDecay: 0.4, gain: 0.5,
  },
  organ: {
    name: 'Órgão',
    oscs: [
      { type: 'sine', octave: 0, detune: 0, gain: 0.6 },
      { type: 'sine', octave: 1, detune: 0, gain: 0.35 },
      { type: 'sine', octave: 2, detune: 0, gain: 0.15 },
    ],
    a: 0.01, d: 0.1, s: 0.9, r: 0.08, cutoff: 6000, q: 0.3, envAmt: 0, fDecay: 0.1, gain: 0.4,
  },
  lead: {
    name: 'Synth Lead',
    oscs: [
      { type: 'sawtooth', octave: 0, detune: -6, gain: 0.5 },
      { type: 'square', octave: 0, detune: 6, gain: 0.3 },
    ],
    a: 0.01, d: 0.2, s: 0.7, r: 0.15, cutoff: 1400, q: 4, envAmt: 2500, fDecay: 0.3, gain: 0.32,
  },
  pad: {
    name: 'Pad Suave',
    oscs: [
      { type: 'sawtooth', octave: 0, detune: -8, gain: 0.4 },
      { type: 'sawtooth', octave: 0, detune: 8, gain: 0.4 },
      { type: 'triangle', octave: -1, detune: 0, gain: 0.3 },
    ],
    a: 0.5, d: 0.8, s: 0.8, r: 1.2, cutoff: 900, q: 1, envAmt: 600, fDecay: 1.5, gain: 0.25,
  },
  strings: {
    name: 'Cordas',
    oscs: [
      { type: 'sawtooth', octave: 0, detune: -10, gain: 0.4 },
      { type: 'sawtooth', octave: 0, detune: 10, gain: 0.4 },
      { type: 'sawtooth', octave: 1, detune: 4, gain: 0.15 },
    ],
    a: 0.15, d: 0.4, s: 0.85, r: 0.5, cutoff: 2200, q: 0.7, envAmt: 800, fDecay: 0.6, gain: 0.22,
  },
  bass: {
    name: 'Baixo Synth',
    oscs: [
      { type: 'sawtooth', octave: 0, detune: 0, gain: 0.6 },
      { type: 'square', octave: -1, detune: 0, gain: 0.4 },
    ],
    a: 0.005, d: 0.25, s: 0.6, r: 0.1, cutoff: 1400, q: 3, envAmt: 2400, fDecay: 0.18, gain: 0.5,
  },
  pluck: {
    name: 'Pluck',
    oscs: [
      { type: 'sawtooth', octave: 0, detune: 0, gain: 0.6 },
      { type: 'sawtooth', octave: 1, detune: 5, gain: 0.2 },
    ],
    a: 0.002, d: 0.3, s: 0, r: 0.2, cutoff: 600, q: 2, envAmt: 5000, fDecay: 0.15, gain: 0.45,
  },
  bell: {
    name: 'Sino',
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
  const freq = 440 * 2 ** ((pitch - 69) / 12);
  const peak = p.gain * (vel / 127) ** 1.5;

  const vca = ctx.createGain();
  vca.gain.setValueAtTime(0, t);
  vca.gain.linearRampToValueAtTime(peak, t + p.a);
  vca.gain.setTargetAtTime(peak * p.s, t + p.a, Math.max(0.01, p.d / 3));

  const flt = ctx.createBiquadFilter();
  flt.type = 'lowpass';
  flt.Q.value = p.q;
  const base = Math.min(18000, p.cutoff * 2 ** ((pitch - 60) / 24));
  flt.frequency.setValueAtTime(Math.min(18000, base + p.envAmt), t);
  flt.frequency.setTargetAtTime(base, t, Math.max(0.01, p.fDecay / 3));

  const oscs = p.oscs.map((o) => {
    const osc = ctx.createOscillator();
    osc.type = o.type;
    osc.frequency.value = freq * 2 ** o.octave;
    osc.detune.value = o.detune;
    const g = ctx.createGain();
    g.gain.value = o.gain;
    osc.connect(g).connect(flt);
    osc.start(t);
    return osc;
  });
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

function decay(g: AudioParam, t: number, peak: number, time: number) {
  g.setValueAtTime(peak, t);
  g.exponentialRampToValueAtTime(0.001, t + time);
}

function noiseHit(
  ctx: BaseAudioContext,
  dest: AudioNode,
  t: number,
  peak: number,
  time: number,
  type: BiquadFilterType,
  freq: number,
  q = 0.7,
): GainNode {
  const src = ctx.createBufferSource();
  src.buffer = noiseBuffer(ctx);
  src.loop = true;
  const f = ctx.createBiquadFilter();
  f.type = type;
  f.frequency.value = freq;
  f.Q.value = q;
  const g = ctx.createGain();
  decay(g.gain, t, peak, time);
  src.connect(f).connect(g).connect(dest);
  src.start(t, Math.random());
  src.stop(t + time + 0.05);
  return g;
}

function tone(
  ctx: BaseAudioContext,
  dest: AudioNode,
  t: number,
  type: OscillatorType,
  f0: number,
  f1: number,
  sweep: number,
  peak: number,
  time: number,
) {
  const osc = ctx.createOscillator();
  osc.type = type;
  osc.frequency.setValueAtTime(f0, t);
  osc.frequency.exponentialRampToValueAtTime(f1, t + sweep);
  const g = ctx.createGain();
  decay(g.gain, t, peak, time);
  osc.connect(g).connect(dest);
  osc.start(t);
  osc.stop(t + time + 0.05);
}

export function playDrum(ctx: BaseAudioContext, dest: AudioNode, pitch: number, t: number, vel: number) {
  const v = (vel / 127) ** 1.3;
  switch (pitch) {
    case 36: // bumbo
      tone(ctx, dest, t, 'sine', 160, 42, 0.11, v * 1.0, 0.42);
      noiseHit(ctx, dest, t, v * 0.15, 0.02, 'highpass', 2000);
      break;
    case 38: // caixa
      tone(ctx, dest, t, 'triangle', 220, 140, 0.06, v * 0.5, 0.13);
      noiseHit(ctx, dest, t, v * 0.6, 0.2, 'highpass', 1400);
      break;
    case 39: { // palmas
      const g = noiseHit(ctx, dest, t, v * 0.6, 0.22, 'bandpass', 1300, 1.2);
      g.gain.cancelScheduledValues(t);
      [0, 0.012, 0.024].forEach((o) => {
        g.gain.setValueAtTime(v * 0.6, t + o);
        g.gain.exponentialRampToValueAtTime(v * 0.1, t + o + 0.01);
      });
      g.gain.setValueAtTime(v * 0.6, t + 0.036);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.22);
      break;
    }
    case 42: // chimbal fechado
      noiseHit(ctx, dest, t, v * 0.35, 0.05, 'highpass', 7500);
      break;
    case 46: // chimbal aberto
      noiseHit(ctx, dest, t, v * 0.32, 0.32, 'highpass', 7000);
      break;
    case 49: // prato
      noiseHit(ctx, dest, t, v * 0.35, 1.3, 'highpass', 5200);
      noiseHit(ctx, dest, t, v * 0.2, 0.5, 'bandpass', 9000, 2);
      break;
    case 45:
      tone(ctx, dest, t, 'sine', 130, 75, 0.2, v * 0.8, 0.4);
      break;
    case 48:
      tone(ctx, dest, t, 'sine', 180, 105, 0.18, v * 0.8, 0.35);
      break;
    case 50:
      tone(ctx, dest, t, 'sine', 240, 150, 0.15, v * 0.8, 0.3);
      break;
    case 56: // cowbell
      tone(ctx, dest, t, 'square', 800, 800, 0.1, v * 0.18, 0.18);
      tone(ctx, dest, t, 'square', 540, 540, 0.1, v * 0.18, 0.18);
      break;
    default:
      noiseHit(ctx, dest, t, v * 0.3, 0.08, 'bandpass', 3000, 2);
  }
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
