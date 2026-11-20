// Rack de amp/pedais do app num AudioWorklet ('mm-rig'): o mesmo código da monitoração de baixa latência
// (rt/rig.ts), então gravação, reprodução, exportação e monitoração soam igual.
//
// Comparado ao rack de nós do Web Audio (Rig em amp.ts), não tem o atraso do oversampling do WaveShaperNode
// (192 amostras por saturação, ~20–30 ms num amp de alto ganho): a trilha com amp toca no tempo certo.
import type { AmpRig, MusicKey } from '../types';
import type { RigLike, SpeedOverride, WahOverride } from './amp';
import type { RigWorkletMessage, RigWorkletOptions } from './dsp/master.worklet';
import type { RtRig } from './lowLatencyProtocol';
import { wahFreq } from './rt/pedalMath';
import { cabIrs, reverbIrData, reverbKeyOf, toRtRig } from './rtBridge';

export class WorkletRig implements RigLike {
  input: GainNode;
  output: GainNode;
  private node: AudioWorkletNode;
  private sent = '';
  private reverbKey: string | null = null;
  private auto = false;
  private wahOver: WahOverride;
  private rotOver: SpeedOverride;
  private getBuffer: (id: string) => AudioBuffer | undefined;
  wah: RigLike['wah'];
  rotary: RigLike['rotary'];

  constructor(
    private ctx: BaseAudioContext,
    public key: string,
    rig: AmpRig,
    userIr?: AudioBuffer,
    bpm = 120,
    song?: MusicKey,
    userIrB?: AudioBuffer,
  ) {
    // os IRs do usuário chegam como AudioBuffer (o mixer já achou pelo id)
    this.getBuffer = (id) => (id === rig.irId ? userIr : id === rig.irB ? userIrB : undefined);
    const rate = ctx.sampleRate;
    const rt = this.rtOf(rig, bpm, song);
    const offline = ctx instanceof OfflineAudioContext;
    const irs = rt.cab ? cabIrs(rig, rate, this.getBuffer) : null;
    this.reverbKey = reverbKeyOf(rt, rate);
    const options: RigWorkletOptions = {
      rig: rt,
      cab: rt.cab && irs ? { key: rt.cab.irKey, a: irs.a, b: irs.b } : null,
      reverb: this.reverbKey ? reverbIrData(this.reverbKey) : null,
      offline,
    };
    this.sent = JSON.stringify(rt);
    this.auto = this.wahAuto(rt);
    this.input = ctx.createGain();
    this.output = ctx.createGain();
    this.node = new AudioWorkletNode(ctx, 'mm-rig', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [2],
      processorOptions: options,
    });
    this.input.connect(this.node).connect(this.output);
    const wahParam = this.node.parameters.get('wah')!;
    const rotParam = this.node.parameters.get('rotary')!;
    this.wah = {
      freq: wahParam,
      toHz: (pos) => wahFreq(pos, this.auto),
      override: (v) => {
        this.wahOver = v;
        if (typeof v === 'number') {
          wahParam.cancelScheduledValues(0);
          wahParam.value = wahFreq(v, this.auto);
        }
        this.sendExt();
      },
    };
    this.rotary = {
      override: (v) => {
        this.rotOver = v;
        if (typeof v === 'number') {
          rotParam.cancelScheduledValues(0);
          rotParam.value = v >= 0.5 ? 1 : 0;
        }
        this.sendExt();
      },
      schedule: (startFast, at, changes) => {
        rotParam.cancelScheduledValues(at);
        rotParam.setValueAtTime(startFast ? 1 : 0, at);
        for (const c of changes) rotParam.setValueAtTime(c.fast ? 1 : 0, c.time);
      },
      // os rotores do processador já têm inércia: segurar = parar de agendar trocas a partir de agora
      hold: (now) => rotParam.cancelScheduledValues(now),
    };
  }

  private rtOf(rig: AmpRig, bpm: number, song?: MusicKey): RtRig {
    return toRtRig(rig, this.ctx.sampleRate, bpm, song, this.getBuffer);
  }
  private wahAuto(rt: RtRig) {
    const w = rt.pedals.find((p) => p.id === 'wah');
    return (w?.p[3] ?? 0) >= 0.5;
  }
  private post(m: RigWorkletMessage) {
    this.node.port.postMessage(m);
  }
  private sendExt() {
    this.node.parameters.get('wahExt')!.value = this.wahOver !== undefined ? 1 : 0;
    this.node.parameters.get('rotaryExt')!.value = this.rotOver !== undefined ? 1 : 0;
  }

  update(rig: AmpRig, bpm = 120, song?: MusicKey) {
    const rt = this.rtOf(rig, bpm, song);
    this.auto = this.wahAuto(rt);
    // posição fixa do wah vinda da automação: o modo (normal/auto) muda a conversão para Hz
    if (typeof this.wahOver === 'number') this.wah.override(this.wahOver);
    const s = JSON.stringify(rt);
    if (s !== this.sent) {
      this.sent = s;
      this.post({ type: 'rig', rig: rt });
    }
    const rk = reverbKeyOf(rt, this.ctx.sampleRate);
    if (rk && rk !== this.reverbKey) {
      this.reverbKey = rk;
      const ir = reverbIrData(rk);
      this.node.port.postMessage({ type: 'reverb', ...ir } satisfies RigWorkletMessage, [ir.l.buffer, ir.r.buffer]);
    }
  }

  dispose() {
    this.post({ type: 'dispose' });
    this.input.disconnect();
    this.node.disconnect();
    this.output.disconnect();
  }
}
