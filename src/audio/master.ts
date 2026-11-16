// Cadeia de master: EQ → compressor de "cola" → saturação → limitador de pico real (+ medidores).
// Ao vivo o limitador e os medidores rodam num AudioWorklet; na exportação o limitador roda depois da
// renderização (ver export.ts), para poder acertar o alvo de loudness.
import { driveCurve } from './fxutil';
import workletUrl from './dsp/master.worklet.ts?worker&url';
import type { MasterReading, MasterWorkletSettings } from './dsp/master.worklet';
import type { MasterSettings } from '../types';

export type { MasterReading };

export const DEFAULT_MASTER: MasterSettings = {
  eq: { low: 0, lowMid: 0, highMid: 0, high: 0 },
  comp: { on: false, threshold: -18, ratio: 2, attack: 30, release: 200, makeup: 0 },
  saturation: 0,
  limiter: { on: true, gain: 0, ceiling: -1, release: 120 },
  exportTarget: 'none',
  exportBits: 24,
};

/** Ajustes do master do projeto (projetos antigos não têm: usam o padrão). */
export const masterOf = (m?: MasterSettings): MasterSettings => m ?? DEFAULT_MASTER;

/** Alvos de loudness da exportação (LUFS integrado). */
export const EXPORT_TARGETS: { id: MasterSettings['exportTarget']; label: string; lufs: number | null }[] = [
  { id: 'none', label: 'Sem alvo (usa o ajuste do limitador)', lufs: null },
  { id: 'streaming', label: 'Spotify / YouTube / Deezer (-14 LUFS)', lufs: -14 },
  { id: 'apple', label: 'Apple Music (-16 LUFS)', lufs: -16 },
  { id: 'loud', label: 'Alto: CD, pista (-9 LUFS)', lufs: -9 },
];

type Preset = Omit<MasterSettings, 'exportTarget' | 'exportBits'>;
export const MASTER_PRESETS: { id: string; name: string; desc: string; s: Preset }[] = [
  {
    id: 'neutral', name: 'Neutro', desc: 'Só o limitador protegendo os picos',
    s: { eq: { low: 0, lowMid: 0, highMid: 0, high: 0 }, comp: { ...DEFAULT_MASTER.comp, on: false }, saturation: 0, limiter: { on: true, gain: 0, ceiling: -1, release: 120 } },
  },
  {
    id: 'pop', name: 'Pop alto', desc: 'Brilhante, encorpado e alto',
    s: {
      eq: { low: 1.5, lowMid: -1, highMid: 1, high: 2 },
      comp: { on: true, threshold: -18, ratio: 2, attack: 30, release: 200, makeup: 1 },
      saturation: 0.2,
      limiter: { on: true, gain: 3, ceiling: -1, release: 80 },
    },
  },
  {
    id: 'acoustic', name: 'Acústico', desc: 'Natural, com dinâmica preservada',
    s: {
      eq: { low: 0, lowMid: -0.5, highMid: 0.5, high: 1 },
      comp: { on: true, threshold: -20, ratio: 1.5, attack: 50, release: 300, makeup: 0.5 },
      saturation: 0,
      limiter: { on: true, gain: 0, ceiling: -1, release: 150 },
    },
  },
  {
    id: 'electronic', name: 'Eletrônico', desc: 'Grave forte, agudos abertos, bem alto',
    s: {
      eq: { low: 2.5, lowMid: -1.5, highMid: 0.5, high: 2.5 },
      comp: { on: true, threshold: -16, ratio: 3, attack: 10, release: 120, makeup: 2 },
      saturation: 0.3,
      limiter: { on: true, gain: 4, ceiling: -1, release: 50 },
    },
  },
  {
    id: 'lofi', name: 'Lo-fi', desc: 'Quente, abafado e saturado',
    s: {
      eq: { low: 2, lowMid: 1, highMid: -2, high: -6 },
      comp: { on: true, threshold: -22, ratio: 3, attack: 20, release: 250, makeup: 1.5 },
      saturation: 0.5,
      limiter: { on: true, gain: 1, ceiling: -1, release: 150 },
    },
  },
];

const db = (v: number) => 10 ** (v / 20);

/** Ajustes do limitador no formato do processador (lineares, em segundos). */
export function limiterParams(m: MasterSettings): MasterWorkletSettings {
  return { on: m.limiter.on, gain: db(m.limiter.gain), ceiling: db(m.limiter.ceiling), release: m.limiter.release / 1000 };
}

/** Compensação da saturação: a curva tanh(kx)/tanh(k) amplifica sinais pequenos em k/tanh(k). */
const satComp = (amount: number) => {
  const k = 1 + amount * 4;
  return Math.tanh(k) / k;
};

const loaded = new WeakMap<BaseAudioContext, Promise<void>>();

export class MasterChain {
  /** entrada do master (o que antes era o "master" do mixer) */
  readonly input: GainNode;
  /** saída final (depois do limitador) */
  readonly output: GainNode;
  /** última leitura dos medidores (só ao vivo) */
  reading: MasterReading | null = null;
  /** maior pico real desde o último reset (dBTP) */
  maxTruePeak = -Infinity;
  private eq: BiquadFilterNode[];
  private comp: DynamicsCompressorNode;
  private makeup: GainNode;
  private shaper: WaveShaperNode;
  private satOut: GainNode;
  private fallback: DynamicsCompressorNode | null = null;
  private worklet: AudioWorkletNode | null = null;
  private settings: MasterSettings = DEFAULT_MASTER;

  /** `live`: carrega o limitador/medidores (AudioWorklet); na exportação o limitador é aplicado depois. */
  constructor(private ctx: BaseAudioContext, dest: AudioNode, live: boolean) {
    this.input = ctx.createGain();
    this.input.gain.value = 0.75; // folga para a soma das trilhas
    const mk = (type: BiquadFilterType, f: number, q = 0.8) => {
      const b = ctx.createBiquadFilter();
      b.type = type;
      b.frequency.value = f;
      b.Q.value = q;
      return b;
    };
    this.eq = [mk('lowshelf', 100), mk('peaking', 400), mk('peaking', 3000), mk('highshelf', 10000)];
    this.comp = ctx.createDynamicsCompressor();
    this.comp.knee.value = 6;
    this.makeup = ctx.createGain();
    this.shaper = ctx.createWaveShaper();
    this.shaper.oversample = '4x';
    this.satOut = ctx.createGain();
    this.output = ctx.createGain();
    this.input.connect(this.eq[0]).connect(this.eq[1]).connect(this.eq[2]).connect(this.eq[3]);
    this.eq[3].connect(this.comp).connect(this.makeup).connect(this.shaper).connect(this.satOut);
    this.output.connect(dest);

    if (!live) {
      this.satOut.connect(this.output);
      return;
    }
    // até o AudioWorklet carregar (ou se ele falhar), um limitador simples protege a saída
    this.fallback = ctx.createDynamicsCompressor();
    this.fallback.threshold.value = -3;
    this.fallback.knee.value = 0;
    this.fallback.ratio.value = 20;
    this.fallback.attack.value = 0.002;
    this.fallback.release.value = 0.1;
    this.satOut.connect(this.fallback).connect(this.output);
    void this.loadWorklet();
  }

  private async loadWorklet() {
    const ctx = this.ctx;
    try {
      if (!loaded.has(ctx)) loaded.set(ctx, ctx.audioWorklet.addModule(workletUrl));
      await loaded.get(ctx);
      const node = new AudioWorkletNode(ctx, 'mm-master', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [2],
        channelCount: 2,
        channelCountMode: 'explicit',
      });
      node.port.onmessage = (e: MessageEvent<MasterReading>) => {
        this.reading = e.data;
        if (e.data.truePeak > this.maxTruePeak) this.maxTruePeak = e.data.truePeak;
      };
      node.port.postMessage({ type: 'settings', settings: limiterParams(this.settings) });
      this.satOut.disconnect();
      this.fallback?.disconnect();
      this.fallback = null;
      this.satOut.connect(node).connect(this.output);
      this.worklet = node;
    } catch (e) {
      console.warn('Limitador/medidores do master indisponíveis; usando o limitador simples.', e);
    }
  }

  /** Zera o LUFS integrado e o pico máximo (ao começar a tocar). */
  reset() {
    this.worklet?.port.postMessage({ type: 'reset' });
    this.maxTruePeak = -Infinity;
    this.reading = null;
  }

  /** Redução de ganho do compressor de cola (dB, ≤ 0). */
  compReduction() {
    return this.settings.comp.on ? this.comp.reduction : 0;
  }

  update(m: MasterSettings) {
    this.settings = m;
    const now = this.ctx.currentTime;
    const smooth = (p: AudioParam, v: number) => p.setTargetAtTime(v, now, 0.02);
    const { low, lowMid, highMid, high } = m.eq;
    [low, lowMid, highMid, high].forEach((g, i) => smooth(this.eq[i].gain, g));
    const c = m.comp;
    this.comp.threshold.value = c.on ? c.threshold : 0;
    this.comp.ratio.value = c.on ? c.ratio : 1;
    this.comp.attack.value = c.attack / 1000;
    this.comp.release.value = c.release / 1000;
    smooth(this.makeup.gain, c.on ? db(c.makeup) : 1);
    this.shaper.curve = m.saturation > 0 ? driveCurve(m.saturation) : null;
    smooth(this.satOut.gain, m.saturation > 0 ? satComp(m.saturation) : 1);
    this.worklet?.port.postMessage({ type: 'settings', settings: limiterParams(m) });
  }
}
