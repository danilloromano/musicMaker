// AudioWorklets: o do master (limitador de pico real + medidores: LUFS, pico real, correlação,
// redução de ganho) e o seguidor de envelope do sidechain. Rodam na thread de áudio.
import { StereoLimiter } from './limiter';
import { Correlation, Loudness, TruePeak, dbfs } from './loudness';

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
