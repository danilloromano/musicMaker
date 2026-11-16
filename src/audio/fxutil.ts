// Utilitários de síntese compartilhados (órgão, synths analógicos).

/** sen(ωt + φ) como PeriodicWave (normalização desligada: amplitude 1). */
export function phasedSine(ctx: BaseAudioContext, phase: number): PeriodicWave {
  return ctx.createPeriodicWave(new Float32Array([0, Math.sin(phase)]), new Float32Array([0, Math.cos(phase)]), {
    disableNormalization: true,
  });
}

/**
 * LFO sincronizado com o relógio do áudio: todas as notas compartilham a mesma fase (como um único
 * efeito aplicado à trilha), em vez de cada uma começar a oscilar do zero. `offset` desloca a fase.
 */
export function syncedLfo(ctx: BaseAudioContext, rate: number, t: number, offset = 0): OscillatorNode {
  const osc = ctx.createOscillator();
  osc.setPeriodicWave(phasedSine(ctx, (2 * Math.PI * rate * t + offset) % (2 * Math.PI)));
  osc.frequency.value = rate;
  osc.start(t);
  return osc;
}

/** Liga um LFO a um parâmetro com uma profundidade. */
export function modulate(ctx: BaseAudioContext, lfo: AudioNode, param: AudioParam, amount: number) {
  const g = ctx.createGain();
  g.gain.value = amount;
  lfo.connect(g).connect(param);
}

const curveCache = new Map<number, Float32Array<ArrayBuffer>>();
/** Curva de saturação suave (tanh); `drive` de 0 a 1. */
export function driveCurve(drive: number): Float32Array<ArrayBuffer> {
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
