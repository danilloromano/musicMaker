// Órgão de rodas fônicas (estilo Hammond), modelado. O som de um Hammond é uma soma de senoides — uma
// "roda" por harmônico, escolhidas pelas drawbars —, então dá para reproduzi-lo fielmente sem gravação.
// O que o deixa real são os detalhes: harmônicos temperados (não exatos), rodas girando sem parar (fase
// aleatória a cada tecla), os contatos da tecla fechando em momentos ligeiramente diferentes (o estalo),
// a percussão, a dobra das rodas mais agudas, a leve saturação do pré-amplificador e o Leslie — a caixa
// com corneta e tambor girando, que faz o som ondular (volume, posição e um leve vibrato por Doppler).
import type { Voice } from './instruments';

export interface TonewheelOpts {
  /** drawbars 16', 5⅓', 8', 4', 2⅔', 2', 1⅗', 1⅓', 1' (0 a 8) */
  drawbars: number[];
  /** percussão: harmônico (2 = 4', 3 = 2⅔'), decaimento (s) e volume */
  perc?: { harmonic: 2 | 3; decay: number; level: number };
  /** Leslie: rotação da corneta e do tambor (Hz) e profundidade (0 a 1) */
  leslie: { horn: number; drum: number; depth: number };
  /** saturação do pré-amplificador (0 a 1) */
  drive: number;
  /** volume do estalo dos contatos da tecla */
  click: number;
  gain: number;
}

// razão de frequência de cada drawbar em relação à nota: quintas e terças são temperadas, como nas rodas
const RATIOS = [0.5, 2 ** (7 / 12), 1, 2, 2 ** (19 / 12), 4, 2 ** (28 / 12), 2 ** (31 / 12), 8];
/** roda mais aguda (~F#7): acima disso a drawbar "dobra" uma oitava para baixo; abaixo da mais grave, sobe */
const TOP = 5900;
const BOTTOM = 32;

const sinesCache = new WeakMap<BaseAudioContext, PeriodicWave[]>();
/** Senoides com fase aleatória: a roda já estava girando quando a tecla foi apertada. */
function randomSine(ctx: BaseAudioContext): PeriodicWave {
  let list = sinesCache.get(ctx);
  if (!list) {
    list = Array.from({ length: 12 }, () => phasedSine(ctx, Math.random() * Math.PI * 2));
    sinesCache.set(ctx, list);
  }
  return list[Math.floor(Math.random() * list.length)];
}

/** sen(ωt + φ) como PeriodicWave (normalização desligada: amplitude 1). */
function phasedSine(ctx: BaseAudioContext, phase: number): PeriodicWave {
  return ctx.createPeriodicWave(new Float32Array([0, Math.sin(phase)]), new Float32Array([0, Math.cos(phase)]), {
    disableNormalization: true,
  });
}

const curveCache = new Map<number, Float32Array>();
function driveCurve(drive: number): Float32Array {
  const key = Math.round(drive * 100);
  let c = curveCache.get(key);
  if (!c) {
    const k = 1 + drive * 4;
    c = new Float32Array(1024);
    for (let i = 0; i < c.length; i++) {
      const x = (i / (c.length - 1)) * 2 - 1;
      c[i] = Math.tanh(k * x) / Math.tanh(k);
    }
    curveCache.set(key, c);
  }
  return c;
}

const noiseCache = new WeakMap<BaseAudioContext, AudioBuffer>();
function noise(ctx: BaseAudioContext): AudioBuffer {
  let b = noiseCache.get(ctx);
  if (!b) {
    b = ctx.createBuffer(1, ctx.sampleRate / 4, ctx.sampleRate);
    const d = b.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    noiseCache.set(ctx, b);
  }
  return b;
}

/** Estalo curto dos contatos da tecla (ao apertar e, mais fraco, ao soltar). */
function click(ctx: BaseAudioContext, dest: AudioNode, t: number, level: number) {
  if (level <= 0) return;
  const src = ctx.createBufferSource();
  src.buffer = noise(ctx);
  const bp = ctx.createBiquadFilter();
  bp.type = 'bandpass';
  bp.frequency.value = 1500 + Math.random() * 2500;
  bp.Q.value = 0.7;
  const g = ctx.createGain();
  g.gain.setValueAtTime(level * (0.6 + Math.random() * 0.4), t);
  g.gain.setTargetAtTime(0, t, 0.0015 + Math.random() * 0.0015);
  src.connect(bp).connect(g).connect(dest);
  src.start(t, Math.random() * 0.2);
  src.stop(t + 0.03);
}

/**
 * LFO de rotação sincronizado com o relógio do áudio: todas as notas "passam pela mesma caixa", então
 * a corneta e o tambor estão na mesma posição para todas (`offset` desloca a fase, ex.: π/2 para o pan).
 */
function rotor(ctx: BaseAudioContext, rate: number, t: number, offset = 0): OscillatorNode {
  const osc = ctx.createOscillator();
  osc.setPeriodicWave(phasedSine(ctx, (2 * Math.PI * rate * t + offset) % (2 * Math.PI)));
  osc.frequency.value = rate;
  osc.start(t);
  return osc;
}

export function startTonewheelVoice(
  ctx: BaseAudioContext,
  dest: AudioNode,
  o: TonewheelOpts,
  pitch: number,
  t: number,
  vel: number,
): Voice {
  const f0 = 440 * 2 ** ((pitch - 69) / 12);
  // cada passo da drawbar vale ~3 dB
  const amps = o.drawbars.map((d) => (d > 0 ? 10 ** (((d - 8) * 3) / 20) : 0));
  const total = amps.reduce((a, b) => a + b, 0) || 1;

  const wheels = ctx.createGain();
  wheels.gain.value = 1 / Math.sqrt(total);
  const sources: AudioScheduledSourceNode[] = [];
  amps.forEach((a, i) => {
    if (!a) return;
    let f = f0 * RATIOS[i];
    while (f > TOP) f /= 2;
    while (f < BOTTOM) f *= 2;
    const osc = ctx.createOscillator();
    osc.setPeriodicWave(randomSine(ctx));
    osc.frequency.value = f;
    const g = ctx.createGain();
    // cada contato fecha numa hora ligeiramente diferente (0 a 4 ms)
    const on = t + Math.random() * 0.004;
    g.gain.setValueAtTime(0, t);
    g.gain.setValueAtTime(a, on);
    osc.connect(g).connect(wheels);
    osc.start(t);
    sources.push(osc);
  });

  // volume: o órgão quase não responde à força; a expressão varia um pouco
  const gate = ctx.createGain();
  // nível fixo na entrada do pré-amplificador (a saturação soa igual em qualquer volume); o volume vem depois
  const level = 0.5 * (0.75 + 0.25 * (vel / 127));
  gate.gain.setValueAtTime(0, t);
  gate.gain.linearRampToValueAtTime(level, t + 0.004);
  wheels.connect(gate);

  if (o.perc) {
    const p = ctx.createOscillator();
    p.setPeriodicWave(randomSine(ctx));
    let f = f0 * (o.perc.harmonic === 2 ? 2 : RATIOS[4]);
    while (f > TOP) f /= 2;
    p.frequency.value = f;
    const pg = ctx.createGain();
    pg.gain.setValueAtTime(o.perc.level, t);
    pg.gain.setTargetAtTime(0, t, o.perc.decay / 3);
    p.connect(pg).connect(gate);
    p.start(t);
    p.stop(t + o.perc.decay * 3);
  }

  // pré-amplificador
  const shaper = ctx.createWaveShaper();
  shaper.curve = driveCurve(o.drive) as Float32Array<ArrayBuffer>;
  shaper.oversample = '2x';
  gate.connect(shaper);
  click(ctx, shaper, t, o.click);

  // Leslie: graves no tambor, agudos na corneta, cada um girando no seu ritmo
  const { horn, drum, depth } = o.leslie;
  const lfos: OscillatorNode[] = [];
  const mod = (lfo: OscillatorNode, param: AudioParam, amount: number) => {
    const g = ctx.createGain();
    g.gain.value = amount;
    lfo.connect(g).connect(param);
  };
  const out = ctx.createGain();
  out.gain.value = o.gain;
  out.connect(dest);

  const hp = ctx.createBiquadFilter();
  hp.type = 'highpass';
  hp.frequency.value = 800;
  const delay = ctx.createDelay(0.01);
  delay.delayTime.value = 0.0015;
  const hornAm = ctx.createGain();
  hornAm.gain.value = 1 - 0.35 * depth;
  const hornPan = ctx.createStereoPanner();
  shaper.connect(hp).connect(delay).connect(hornAm).connect(hornPan).connect(out);
  const hornLfo = rotor(ctx, horn, t);
  const hornLfo90 = rotor(ctx, horn, t, Math.PI / 2);
  mod(hornLfo, delay.delayTime, 0.0004 * depth); // Doppler
  mod(hornLfo90, hornAm.gain, 0.35 * depth); // a boca da corneta passa na frente
  mod(hornLfo, hornPan.pan, 0.6 * depth);
  lfos.push(hornLfo, hornLfo90);

  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = 800;
  const drumAm = ctx.createGain();
  drumAm.gain.value = 1 - 0.15 * depth;
  const drumPan = ctx.createStereoPanner();
  shaper.connect(lp).connect(drumAm).connect(drumPan).connect(out);
  const drumLfo = rotor(ctx, drum, t, 1.3);
  mod(drumLfo, drumAm.gain, 0.15 * depth);
  mod(drumLfo, drumPan.pan, 0.25 * depth);
  lfos.push(drumLfo);

  return {
    release(rt: number) {
      const at = Math.max(rt, t + 0.005);
      if (gate.gain.cancelAndHoldAtTime) gate.gain.cancelAndHoldAtTime(at);
      else gate.gain.cancelScheduledValues(at);
      gate.gain.setTargetAtTime(0, at, 0.004);
      click(ctx, shaper, at, o.click * 0.4);
      const end = at + 0.06;
      for (const s of sources) s.stop(end);
      for (const l of lfos) l.stop(end);
    },
  };
}
