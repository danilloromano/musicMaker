// AudioWorklets: o do master (limitador de pico real + medidores: LUFS, pico real, correlação,
// redução de ganho), o seguidor de envelope do sidechain e o octaver, o harmonizador, o delay reverso, o phaser e o univibe da pedaleira. Rodam na thread de áudio.
import { StereoLimiter } from './limiter';
import { Correlation, Loudness, TruePeak, dbfs } from './loudness';
import { HarmonyCore, HarmonySettings, OctaveCore, PhaserCore, PitchCore, ReverseCore, UnivibeCore } from '../rt/cores';
import { BuildQueue, buildNow } from '../rt/dsp';
import { RtRigProcessor, warmupRig } from '../rt/rig';
import type { RtRig } from '../lowLatencyProtocol';

// tipos do escopo de AudioWorklet (não fazem parte da biblioteca DOM do TypeScript)
declare const sampleRate: number;
declare function registerProcessor(name: string, ctor: unknown): void;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
}

export interface MasterWorkletSettings {
  on: boolean;
  gain: number;
  ceiling: number;
  release: number;
}

/** Leitura enviada ~10 vezes por segundo. */
export interface MasterReading {
  momentary: number;
  shortTerm: number;
  integrated: number;
  /** maior pico real desde a última leitura (dBTP) */
  truePeak: number;
  correlation: number;
  /** redução de ganho do limitador (dB, ≤ 0) */
  reduction: number;
}

class MasterProcessor extends AudioWorkletProcessor {
  private limiter = new StereoLimiter(sampleRate, { gain: 1, ceiling: 10 ** (-1 / 20), release: 0.12 });
  private on = true;
  private loud = new Loudness(sampleRate);
  private corr = new Correlation(sampleRate);
  private tpL = new TruePeak();
  private tpR = new TruePeak();
  private peak = 0;
  private count = 0;
  private silenceL = new Float32Array(128);
  private silenceR = new Float32Array(128);

  constructor() {
    super();
    this.port.onmessage = (e: MessageEvent) => {
      const m = e.data;
      if (m.type === 'settings') {
        const s = m.settings as MasterWorkletSettings;
        this.on = s.on;
        this.limiter.update({ gain: s.gain, ceiling: s.ceiling, release: s.release });
      } else if (m.type === 'reset') {
        this.loud.reset();
      }
    };
  }

  process(inputs: Float32Array[][], outputs: Float32Array[][]) {
    const out = outputs[0];
    const n = out[0].length;
    const inp = inputs[0];
    const l = out[0];
    const r = out[1] ?? out[0];
    if (inp.length) {
      l.set(inp[0]);
      r.set(inp[1] ?? inp[0]);
    } else {
      l.set(this.silenceL.subarray(0, n));
      r.set(this.silenceR.subarray(0, n));
    }
    this.limiter.process(l, r, this.on);

    this.loud.push(l, r);
    this.corr.push(l, r);
    for (let i = 0; i < n; i++) {
      const p = Math.max(this.tpL.next(l[i]), this.tpR.next(r[i]));
      if (p > this.peak) this.peak = p;
    }
    this.count += n;
    if (this.count >= sampleRate / 10) {
      const reading: MasterReading = {
        momentary: this.loud.momentary(),
        shortTerm: this.loud.shortTerm(),
        integrated: this.loud.integrated(),
        truePeak: dbfs(this.peak),
        correlation: this.corr.value(),
        reduction: dbfs(this.limiter.minGain),
      };
      this.port.postMessage(reading);
      this.peak = 0;
      this.limiter.minGain = 1;
      this.count = 0;
    }
    return true;
  }
}

registerProcessor('mm-master', MasterProcessor);

/**
 * Sidechain: segue o envelope do sinal de outra trilha (ataque rápido, volta ajustável) e devolve o
 * ganho a aplicar nesta (1 = sem redução). A saída vai direto para o ganho "duck" do canal.
 */
class DuckProcessor extends AudioWorkletProcessor {
  private env = 0;
  private att: number;
  private rel: number;
  private depth: number;
  private k: number;
  constructor(options: { processorOptions: { depth: number; sens: number; release: number } }) {
    super();
    const o = options.processorOptions;
    this.att = Math.exp(-1 / (sampleRate * 0.003));
    this.rel = Math.exp(-1 / (sampleRate * Math.max(0.01, o.release / 1000)));
    this.depth = 1 - 10 ** (-o.depth / 20);
    this.k = 1 / Math.max(0.05, 1 - o.sens); // sensibilidade 60%: abaixa tudo com 40% de sinal
  }
  process(inputs: Float32Array[][], outputs: Float32Array[][]) {
    const out = outputs[0][0];
    const inp = inputs[0];
    for (let i = 0; i < out.length; i++) {
      let x = 0;
      for (const ch of inp) x = Math.max(x, Math.abs(ch[i]));
      this.env = x > this.env ? x + (this.env - x) * this.att : x + (this.env - x) * this.rel;
      out[i] = 1 - this.depth * Math.min(1, this.env * this.k);
    }
    return true;
  }
}

registerProcessor('mm-duck', DuckProcessor);

// ---------- Pedais (o DSP fica em rt/cores.ts, compartilhado com o motor de baixa latência) ----------

const zeros = new Float32Array(128);
let mixBuf = new Float32Array(128);
/** Entrada mono: o único canal, a média dos canais, ou silêncio sem nada ligado. */
function mono(inp: Float32Array[], n: number): Float32Array {
  if (inp.length === 1) return inp[0];
  if (!inp.length) return zeros;
  if (mixBuf.length < n) mixBuf = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let x = 0;
    for (const ch of inp) x += ch[i];
    mixBuf[i] = x / inp.length;
  }
  return mixBuf;
}

class OctaveProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'sub1', defaultValue: 0, minValue: 0, maxValue: 4, automationRate: 'k-rate' },
      { name: 'sub2', defaultValue: 0, minValue: 0, maxValue: 4, automationRate: 'k-rate' },
    ];
  }
  private core = new OctaveCore(sampleRate);
  process(inputs: Float32Array[][], outputs: Float32Array[][], params: Record<string, Float32Array>) {
    const n = outputs[0][0].length;
    this.core.process(mono(inputs[0], n), outputs[0], n, params.sub1[0], params.sub2[0]);
    return true;
  }
}
registerProcessor('mm-octave', OctaveProcessor);

class HarmonyProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [{ name: 'level', defaultValue: 0, minValue: 0, maxValue: 4, automationRate: 'k-rate' }];
  }
  private core = new HarmonyCore(sampleRate);
  constructor() {
    super();
    this.port.onmessage = (e: MessageEvent) => this.core.setKey(e.data as HarmonySettings);
  }
  process(inputs: Float32Array[][], outputs: Float32Array[][], params: Record<string, Float32Array>) {
    const n = outputs[0][0].length;
    this.core.process(mono(inputs[0], n), outputs[0], n, params.level[0]);
    return true;
  }
}
registerProcessor('mm-harmony', HarmonyProcessor);

class ReverseProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'time', defaultValue: 0.4, minValue: 0.05, maxValue: 3, automationRate: 'k-rate' },
      { name: 'feedback', defaultValue: 0, minValue: 0, maxValue: 0.95, automationRate: 'k-rate' },
    ];
  }
  private core = new ReverseCore(sampleRate);
  process(inputs: Float32Array[][], outputs: Float32Array[][], params: Record<string, Float32Array>) {
    const n = outputs[0][0].length;
    this.core.process(mono(inputs[0], n), outputs[0], n, params.time[0], params.feedback[0]);
    return true;
  }
}
registerProcessor('mm-reverse', ReverseProcessor);

class PhaserProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'rate', defaultValue: 0.5, minValue: 0.01, maxValue: 12, automationRate: 'k-rate' },
      { name: 'depth', defaultValue: 0.6, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      { name: 'feedback', defaultValue: 0, minValue: 0, maxValue: 0.95, automationRate: 'k-rate' },
      { name: 'stages', defaultValue: 4, minValue: 2, maxValue: 12, automationRate: 'k-rate' },
      { name: 'stereo', defaultValue: 1, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
    ];
  }
  private core = new PhaserCore(sampleRate);
  process(inputs: Float32Array[][], outputs: Float32Array[][], params: Record<string, Float32Array>) {
    const n = outputs[0][0].length;
    this.core.process(mono(inputs[0], n), outputs[0], n, params.rate[0], params.depth[0], params.feedback[0], params.stages[0], params.stereo[0]);
    return true;
  }
}
registerProcessor('mm-phaser', PhaserProcessor);

class UnivibeProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'rate', defaultValue: 2, minValue: 0.1, maxValue: 15, automationRate: 'k-rate' },
      { name: 'depth', defaultValue: 0.7, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
    ];
  }
  private core = new UnivibeCore(sampleRate);
  process(inputs: Float32Array[][], outputs: Float32Array[][], params: Record<string, Float32Array>) {
    const n = outputs[0][0].length;
    this.core.process(mono(inputs[0], n), outputs[0], n, params.rate[0], params.depth[0]);
    return true;
  }
}
registerProcessor('mm-univibe', UnivibeProcessor);

class PitchProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [{ name: 'ratio', defaultValue: 2, minValue: 0.25, maxValue: 4, automationRate: 'k-rate' }];
  }
  private core = new PitchCore(sampleRate);
  process(inputs: Float32Array[][], outputs: Float32Array[][], params: Record<string, Float32Array>) {
    const n = outputs[0][0].length;
    this.core.process(mono(inputs[0], n), outputs[0], n, params.ratio[0]);
    return true;
  }
}
registerProcessor('mm-pitch', PitchProcessor);

// ---------- Rack de guitarra (rt/rig.ts: o mesmo código da monitoração de baixa latência) ----------

/** Rack recebido na criação do nó (na exportação offline ele precisa estar completo antes do 1º bloco). */
export interface RigWorkletOptions {
  rig: RtRig | null;
  cab: { key: string; a: Float32Array[] | null; b: Float32Array[] | null } | null;
  reverb: { key: string; l: Float32Array; r: Float32Array } | null;
  /** exportação/congelamento: monta os IRs na hora (não há pressa de tempo real) */
  offline: boolean;
}

export type RigWorkletMessage =
  | { type: 'rig'; rig: RtRig | null }
  | { type: 'reverb'; key: string; l: Float32Array; r: Float32Array }
  | { type: 'dispose' };

const RIG_BLOCK = 128;
/** o JIT já compilou o código do rack nesta thread de áudio */
let rigWarm = false;

class RigProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'wah', defaultValue: 800, minValue: 1, maxValue: 24000, automationRate: 'k-rate' },
      { name: 'rotary', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      // automação ligada (1): o wah segue 'wah' (Hz) e o rotary segue 'rotary' (≥ 0,5 = rápido). São parâmetros
      // e não mensagens porque na exportação offline uma mensagem só chegaria depois do áudio já processado
      { name: 'wahExt', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      { name: 'rotaryExt', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
    ];
  }
  private queue = new BuildQueue();
  private proc: RtRigProcessor;
  private L = new Float64Array(RIG_BLOCK);
  private R = new Float64Array(RIG_BLOCK);
  private dead = false;
  constructor(options: { processorOptions: RigWorkletOptions }) {
    super();
    const o = options.processorOptions;
    // 1º rack desta thread (ao abrir o projeto): roda todos os circuitos em silêncio para o JIT compilar antes
    // de tocar (senão o 1º bloco de cada pedal sairia lento e estalaria)
    if (!rigWarm) {
      rigWarm = true;
      warmupRig(sampleRate, RIG_BLOCK, 8);
    }
    // ao vivo, o reverb (IR de até ~9 s) é montado aos poucos dentro do processamento (aqui não há setTimeout)
    this.proc = new RtRigProcessor(sampleRate, RIG_BLOCK, o.offline ? buildNow : this.queue.schedule);
    if (o.cab) this.proc.setIr(o.cab.key, o.cab.a, o.cab.b, true);
    this.proc.setRig(o.rig);
    if (o.reverb) this.proc.setReverbIr(o.reverb, o.offline);
    this.port.onmessage = (e: MessageEvent) => {
      const m = e.data as RigWorkletMessage;
      if (m.type === 'rig') this.proc.setRig(m.rig);
      else if (m.type === 'reverb') this.proc.setReverbIr(m);
      else this.dead = true;
    };
  }
  process(inputs: Float32Array[][], outputs: Float32Array[][], params: Record<string, Float32Array>) {
    if (this.dead) return false;
    const out = outputs[0];
    const n = out[0].length;
    const x = mono(inputs[0], n);
    if (n !== RIG_BLOCK) {
      for (const ch of out) ch.set(x.subarray(0, n));
      return true;
    }
    const L = this.L, R = this.R;
    for (let i = 0; i < n; i++) L[i] = x[i];
    this.proc.external(params.wahExt[0] >= 0.5 ? params.wah[0] : null, params.rotaryExt[0] >= 0.5 ? params.rotary[0] >= 0.5 : null);
    this.proc.process(L, R);
    out[0].set(L);
    if (out.length > 1) out[1].set(R);
    // montagens pendentes (IR do reverb): poucos passos por bloco, para não pesar
    this.queue.step(2);
    return true;
  }
}
registerProcessor('mm-rig', RigProcessor);
