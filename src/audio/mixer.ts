import { Track } from '../types';

export interface Strip {
  input: GainNode;
  low: BiquadFilterNode;
  mid: BiquadFilterNode;
  high: BiquadFilterNode;
  comp: DynamicsCompressorNode;
  gain: GainNode;
  pan: StereoPannerNode;
  revSend: GainNode;
  dlySend: GainNode;
  analyser: AnalyserNode;
}

function impulse(ctx: BaseAudioContext, seconds: number): AudioBuffer {
  const len = Math.floor(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let c = 0; c < 2; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len) ** 3;
  }
  return buf;
}

/** Mesa de som: um canal por trilha (EQ → compressor → volume → pan) + envios de reverb e delay. */
export class Mixer {
  master: GainNode;
  analyser: AnalyserNode;
  strips = new Map<string, Strip>();
  private reverb: ConvolverNode;
  private delay: DelayNode;

  constructor(public ctx: BaseAudioContext, dest: AudioNode) {
    this.master = ctx.createGain();
    this.master.gain.value = 0.75;
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -3;
    limiter.knee.value = 0;
    limiter.ratio.value = 20;
    limiter.attack.value = 0.002;
    limiter.release.value = 0.1;
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 2048;
    this.analyser.smoothingTimeConstant = 0.78;
    this.master.connect(limiter).connect(dest);
    limiter.connect(this.analyser);

    this.reverb = ctx.createConvolver();
    this.reverb.buffer = impulse(ctx, 2.4);
    this.reverb.connect(this.master);

    this.delay = ctx.createDelay(2);
    const fb = ctx.createGain();
    fb.gain.value = 0.35;
    const damp = ctx.createBiquadFilter();
    damp.type = 'lowpass';
    damp.frequency.value = 3500;
    this.delay.connect(damp).connect(fb).connect(this.delay);
    damp.connect(this.master);
  }

  private createStrip(): Strip {
    const c = this.ctx;
    const input = c.createGain();
    const low = c.createBiquadFilter();
    low.type = 'lowshelf';
    low.frequency.value = 200;
    const mid = c.createBiquadFilter();
    mid.type = 'peaking';
    mid.frequency.value = 1000;
    mid.Q.value = 0.8;
    const high = c.createBiquadFilter();
    high.type = 'highshelf';
    high.frequency.value = 5000;
    const comp = c.createDynamicsCompressor();
    const gain = c.createGain();
    const pan = c.createStereoPanner();
    const revSend = c.createGain();
    const dlySend = c.createGain();
    const analyser = c.createAnalyser();
    analyser.fftSize = 2048; // resolução suficiente para o espectro nos graves
    analyser.smoothingTimeConstant = 0.78;
    input.connect(low).connect(mid).connect(high).connect(comp).connect(gain).connect(pan).connect(this.master);
    pan.connect(revSend).connect(this.reverb);
    pan.connect(dlySend).connect(this.delay);
    pan.connect(analyser);
    return { input, low, mid, high, comp, gain, pan, revSend, dlySend, analyser };
  }

  /** Cria/remove/atualiza os canais para refletir as trilhas do projeto. */
  sync(tracks: Track[], bpm: number) {
    const now = this.ctx.currentTime;
    const smooth = (p: AudioParam, v: number) => p.setTargetAtTime(v, now, 0.012);
    this.delay.delayTime.value = Math.min(1.9, (60 / bpm) * 0.75); // colcheia pontuada

    for (const [id, s] of this.strips) {
      if (!tracks.some((t) => t.id === id)) {
        s.pan.disconnect();
        s.input.disconnect();
        this.strips.delete(id);
      }
    }
    const anySolo = tracks.some((t) => t.solo);
    for (const t of tracks) {
      let s = this.strips.get(t.id);
      if (!s) {
        s = this.createStrip();
        this.strips.set(t.id, s);
      }
      const audible = !t.mute && (!anySolo || t.solo);
      smooth(s.gain.gain, audible ? t.volume ** 2 * 1.4 : 0);
      smooth(s.pan.pan, t.pan);
      s.low.gain.value = t.fx.low;
      s.mid.gain.value = t.fx.mid;
      s.high.gain.value = t.fx.high;
      s.comp.threshold.value = t.fx.comp ? -24 : 0;
      s.comp.ratio.value = t.fx.comp ? 4 : 1;
      smooth(s.revSend.gain, t.fx.reverb);
      smooth(s.dlySend.gain, t.fx.delay);
    }
  }
}
