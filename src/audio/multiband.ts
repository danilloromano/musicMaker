// Master: compressor multibanda (3 bandas, divisores Linkwitz-Riley) e imagem estéreo (largura e graves
// em mono), com nós nativos — funcionam igual ao vivo e na exportação.
import type { MasterSettings } from '../types';

type Multiband = NonNullable<MasterSettings['multiband']>;
type Stereo = NonNullable<MasterSettings['stereo']>;

/** Q de Butterworth (o Web Audio mede o Q dos passa-baixas/altas em dB). */
const BUTTER_Q = 20 * Math.log10(Math.SQRT1_2);

/** Filtro Linkwitz-Riley de 4ª ordem (dois Butterworth iguais em série): as bandas somam plano. */
function lr4(ctx: BaseAudioContext, type: 'lowpass' | 'highpass', freq: number): [BiquadFilterNode, BiquadFilterNode] {
  const mk = () => {
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    f.Q.value = BUTTER_Q;
    return f;
  };
  const a = mk(), b = mk();
  a.connect(b);
  return [a, b];
}

/**
 * Compressor multibanda: divide em graves, médios e agudos, comprime cada um separadamente e soma.
 * Os graves passam também por um "passa-tudo" no segundo divisor (passa-baixas + passa-altas somados),
 * para chegarem com a mesma fase que os médios e agudos e a soma continuar plana.
 */
export class MultibandComp {
  readonly input: GainNode;
  readonly output: GainNode;
  readonly comps: DynamicsCompressorNode[];
  private gains: GainNode[];
  private xLow: BiquadFilterNode[] = [];
  private xHigh: BiquadFilterNode[] = [];
  private on = false;

  constructor(private ctx: BaseAudioContext) {
    this.input = ctx.createGain();
    this.output = ctx.createGain();
    this.comps = [0, 1, 2].map((i) => {
      const c = ctx.createDynamicsCompressor();
      c.knee.value = 6;
      c.attack.value = [0.03, 0.015, 0.005][i];
      c.release.value = [0.25, 0.15, 0.1][i];
      return c;
    });
    this.gains = [0, 1, 2].map(() => ctx.createGain());
    this.comps.forEach((c, i) => c.connect(this.gains[i]).connect(this.output));

    const [lpA, lpB] = lr4(ctx, 'lowpass', 150);
    const [hpA, hpB] = lr4(ctx, 'highpass', 150);
    const [apLpA, apLpB] = lr4(ctx, 'lowpass', 3000);
    const [apHpA, apHpB] = lr4(ctx, 'highpass', 3000);
    const [midLpA, midLpB] = lr4(ctx, 'lowpass', 3000);
    const [hiHpA, hiHpB] = lr4(ctx, 'highpass', 3000);
    // graves: passa-baixas no 1º divisor + passa-tudo do 2º
    lpB.connect(apLpA);
    lpB.connect(apHpA);
    apLpB.connect(this.comps[0]);
    apHpB.connect(this.comps[0]);
    // médios e agudos: passa-altas no 1º divisor, depois o 2º divisor
    hpB.connect(midLpA);
    hpB.connect(hiHpA);
    midLpB.connect(this.comps[1]);
    hiHpB.connect(this.comps[2]);
    this.xLow = [lpA, lpB, hpA, hpB];
    this.xHigh = [apLpA, apLpB, apHpA, apHpB, midLpA, midLpB, hiHpA, hiHpB];
    this.entry = [lpA, hpA];
    this.input.connect(this.output); // desligado até update()
  }
  private entry: BiquadFilterNode[];

  update(m: Multiband) {
    const now = this.ctx.currentTime;
    if (m.on !== this.on) {
      this.input.disconnect();
      if (m.on) this.entry.forEach((n) => this.input.connect(n));
      else this.input.connect(this.output);
      this.on = m.on;
    }
    for (const f of this.xLow) f.frequency.setTargetAtTime(m.lowFreq, now, 0.02);
    for (const f of this.xHigh) f.frequency.setTargetAtTime(m.highFreq, now, 0.02);
    m.bands.forEach((b, i) => {
      this.comps[i].threshold.value = b.threshold;
      this.comps[i].ratio.value = b.ratio;
      this.gains[i].gain.setTargetAtTime(10 ** (b.gain / 20), now, 0.02);
    });
  }

  /** Redução de ganho de cada banda (dB, ≤ 0); zero quando desligado. */
  reductions(): number[] {
    return this.comps.map((c) => (this.on ? c.reduction : 0));
  }
}

/**
 * Imagem estéreo por meio/lados: M = (E+D)/2, L = (E−D)/2; a largura multiplica L (0 = mono, 1 = original,
 * 2 = bem aberto) e, com "graves em mono", L passa por um passa-altas — abaixo do corte só fica o meio.
 */
export class StereoImager {
  readonly input: GainNode;
  readonly output: ChannelMergerNode;
  private width: GainNode;
  private hp: BiquadFilterNode[];

  constructor(private ctx: BaseAudioContext) {
    this.input = ctx.createGain();
    this.input.channelCount = 2;
    this.input.channelCountMode = 'explicit';
    const split = ctx.createChannelSplitter(2);
    const mid = ctx.createGain();
    const side = ctx.createGain();
    const half = (g: number) => {
      const n = ctx.createGain();
      n.gain.value = g;
      return n;
    };
    const lm = half(0.5), rm = half(0.5), ls = half(0.5), rs = half(-0.5);
    this.input.connect(split);
    split.connect(lm, 0).connect(mid);
    split.connect(rm, 1).connect(mid);
    split.connect(ls, 0).connect(side);
    split.connect(rs, 1).connect(side);
    const [a, b] = lr4(ctx, 'highpass', 10);
    this.hp = [a, b];
    this.width = ctx.createGain();
    side.connect(a);
    b.connect(this.width);
    const inv = half(-1);
    this.output = ctx.createChannelMerger(2);
    mid.connect(this.output, 0, 0);
    mid.connect(this.output, 0, 1);
    this.width.connect(this.output, 0, 0);
    this.width.connect(inv).connect(this.output, 0, 1);
  }

  update(s: Stereo) {
    const now = this.ctx.currentTime;
    this.width.gain.setTargetAtTime(s.width, now, 0.02);
    for (const f of this.hp) f.frequency.setTargetAtTime(s.monoBass ? s.monoFreq : 10, now, 0.02);
  }
}
