import { Track } from '../types';
import { Rig, rigKey } from './amp';
import { MasterChain } from './master';
import { applyComp, applyEq, compOf, createEqNodes, eqOf } from './trackfx';

export interface Strip {
  input: GainNode;
  /** EQ paramétrico em série (ver trackfx.ts: createEqNodes) */
  eq: BiquadFilterNode[];
  comp: DynamicsCompressorNode;
  makeup: GainNode;
  gain: GainNode;
  pan: StereoPannerNode;
  revSend: GainNode;
  dlySend: GainNode;
  analyser: AnalyserNode;
  rig?: Rig;
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
  /** entrada do master (todas as trilhas e efeitos somam aqui) */
  master: GainNode;
  /** cadeia de master (EQ, compressor, saturação, limitador, medidores) */
  chain: MasterChain;
  analyser: AnalyserNode;
  strips = new Map<string, Strip>();
  private reverb: ConvolverNode;
  private delay: DelayNode;

  constructor(
    public ctx: BaseAudioContext,
    dest: AudioNode,
    private getBuffer: (id: string) => AudioBuffer | undefined = () => undefined,
    /** ao vivo (limitador e medidores no AudioWorklet) ou exportação (limitador aplicado depois) */
    live = true,
  ) {
    this.chain = new MasterChain(ctx, dest, live);
    this.master = this.chain.input;
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 2048;
    this.analyser.smoothingTimeConstant = 0.78;
    this.chain.output.connect(this.analyser);

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
    const eq = createEqNodes(c);
    const comp = c.createDynamicsCompressor();
    const makeup = c.createGain();
    const gain = c.createGain();
    const pan = c.createStereoPanner();
    const revSend = c.createGain();
    const dlySend = c.createGain();
    const analyser = c.createAnalyser();
    analyser.fftSize = 2048; // resolução suficiente para o espectro nos graves
    analyser.smoothingTimeConstant = 0.78;
    input.connect(eq[0]);
    eq[eq.length - 1].connect(comp).connect(makeup).connect(gain).connect(pan).connect(this.master);
    pan.connect(revSend).connect(this.reverb);
    pan.connect(dlySend).connect(this.delay);
    pan.connect(analyser);
    return { input, eq, comp, makeup, gain, pan, revSend, dlySend, analyser };
  }

  /** Rack de amp/pedais entre a entrada do canal e o EQ: remonta só quando muda amp, caixa ou IR. */
  private syncRig(s: Strip, t: Track) {
    const want = t.amp?.on ? t.amp : null;
    const ir = want?.cab === 'user' && want.irId ? this.getBuffer(want.irId) : undefined;
    const key = want && rigKey(want, !!ir);
    if (s.rig && s.rig.key !== key) {
      s.input.disconnect();
      s.rig.dispose();
      s.rig = undefined;
      s.input.connect(s.eq[0]);
    }
    if (want && key && !s.rig) {
      s.rig = new Rig(this.ctx, key, want, ir);
      s.input.disconnect();
      s.input.connect(s.rig.input);
      s.rig.output.connect(s.eq[0]);
    } else if (want) s.rig?.update(want);
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
        s.rig?.dispose();
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
      applyEq(s.eq, eqOf(t.fx), true);
      applyComp(s.comp, s.makeup, compOf(t.fx), true);
      smooth(s.revSend.gain, t.fx.reverb);
      smooth(s.dlySend.gain, t.fx.delay);
      this.syncRig(s, t);
    }
  }
}
