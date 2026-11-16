// AudioWorklets: o do master (limitador de pico real + medidores: LUFS, pico real, correlação,
// redução de ganho), o seguidor de envelope do sidechain e o octaver e o harmonizador da pedaleira. Rodam na thread de áudio.
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

/**
 * Octaver analógico (estilo dos pedais de oitava clássicos, monofônico). O sinal passa por um filtro
 * de rastreamento (só a fundamental fica forte) e por um detector com histerese que acha cada ciclo
 * da nota. Um flip-flop troca de estado a cada ciclo → onda quadrada na metade da frequência (-1
 * oitava); outro flip-flop sobre o primeiro → um quarto (-2 oitavas). A quadrada sai com o volume do
 * envelope da nota (segue a palhetada) e passa por um passa-baixas: o grave "gordo" dos octavers.
 * Saída: só as oitavas (o sinal direto é misturado fora, em nós nativos).
 */
class OctaveProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'sub1', defaultValue: 0, minValue: 0, maxValue: 4, automationRate: 'k-rate' },
      { name: 'sub2', defaultValue: 0, minValue: 0, maxValue: 4, automationRate: 'k-rate' },
    ];
  }
  private hpA: number;
  private lpA: number;
  private postA: number;
  private att: number;
  private rel: number;
  private hpX = 0;
  private hpY = 0;
  private lp1 = 0;
  private lp2 = 0;
  private env = 0;
  private high = false;
  private ff1 = 1;
  private ff2 = 1;
  private o1 = 0;
  private o2 = 0;
  constructor() {
    super();
    const a = (f: number) => Math.exp((-2 * Math.PI * f) / sampleRate);
    this.hpA = a(45); // tira grave inaudível/DC antes de detectar
    this.lpA = a(650); // rastreamento: deixa a fundamental dominar (notas de baixo e guitarra)
    this.postA = a(700); // arredonda as quinas da quadrada (grave redondo, sem zumbido)
    this.att = Math.exp(-1 / (sampleRate * 0.001));
    this.rel = Math.exp(-1 / (sampleRate * 0.06));
  }
  process(inputs: Float32Array[][], outputs: Float32Array[][], params: Record<string, Float32Array>) {
    const inp = inputs[0];
    const out = outputs[0];
    const n = out[0].length;
    const g1 = params.sub1[0], g2 = params.sub2[0];
    for (let i = 0; i < n; i++) {
      let x = 0;
      for (const ch of inp) x += ch[i];
      if (inp.length > 1) x /= inp.length;
      // passa-altas de 1ª ordem
      const hp = this.hpA * (this.hpY + x - this.hpX);
      this.hpX = x;
      this.hpY = hp;
      // passa-baixas de 2ª ordem (dois polos) = filtro de rastreamento
      this.lp1 = hp + (this.lp1 - hp) * this.lpA;
      this.lp2 = this.lp1 + (this.lp2 - this.lp1) * this.lpA;
      const t = this.lp2;
      const ax = Math.abs(t);
      this.env = ax > this.env ? ax + (this.env - ax) * this.att : ax + (this.env - ax) * this.rel;
      // histerese proporcional ao volume: ruído e harmônicos não disparam ciclos falsos
      const h = Math.max(2e-4, this.env * 0.2);
      if (!this.high && t > h) {
        this.high = true;
        this.ff1 = -this.ff1;
        if (this.ff1 > 0) this.ff2 = -this.ff2;
      } else if (this.high && t < -h) this.high = false;
      // abaixo de ~-66 dB não há nota: cala as oitavas (sem "ronco" do flip-flop no silêncio)
      const gate = this.env > 5e-4 ? 1 : 0;
      const a = this.env * gate;
      this.o1 = a * this.ff1 + (this.o1 - a * this.ff1) * this.postA;
      this.o2 = a * this.ff2 + (this.o2 - a * this.ff2) * this.postA;
      const y = g1 * this.o1 + g2 * this.o2;
      for (const ch of out) ch[i] = y;
    }
    return true;
  }
}

registerProcessor('mm-octave', OctaveProcessor);

/** Escalas do harmonizador (semitons a partir da tônica). */
const SCALES = [
  [0, 2, 4, 5, 7, 9, 11], // maior
  [0, 2, 3, 5, 7, 8, 10], // menor natural
];

/** Semitons da voz de harmonia para a nota `note` (MIDI), `offset` graus acima/abaixo na escala do tom. */
function harmonySemis(note: number, key: number, minor: boolean, offset: number): number {
  const scale = SCALES[minor ? 1 : 0];
  const pc = (((note - key) % 12) + 12) % 12;
  // grau da escala da nota tocada (nota fora da escala: o grau mais próximo abaixo)
  let i = 6;
  while (scale[i] > pc) i--;
  const j = i + offset;
  const oct = Math.floor(j / 7);
  return scale[((j % 7) + 7) % 7] + 12 * oct - scale[i];
}

/**
 * Harmonizador: acha a nota tocada (YIN num sinal reduzido para 1/4 da taxa) e gera uma segunda voz
 * no intervalo pedido, dentro da escala do tom (ex.: terça acima vira terça maior ou menor conforme a
 * nota). A transposição é de linha de atraso com duas vozes, mas os "grãos" têm um número inteiro de
 * períodos da nota: no salto de cada grão a onda continua na mesma fase, sem o tremido de um pitch
 * shifter comum. Monofônico (uma nota por vez). Saída: só a voz de harmonia.
 */
class HarmonyProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [{ name: 'level', defaultValue: 0, minValue: 0, maxValue: 4, automationRate: 'k-rate' }];
  }
  private key = 0;
  private minor = false;
  private offset = 2;
  // sinal guardado para as vozes lerem com atraso
  private ring = new Float32Array(16384);
  private w = 0;
  // detecção (1/4 da taxa)
  private dec = new Float32Array(1024);
  private dw = 0;
  private acc = 0;
  private accN = 0;
  private sinceDetect = 0;
  private period = 0; // em amostras (taxa cheia); 0 = sem nota
  private ratio = 1;
  /** fase única das rampas: a voz 2 anda sempre exatamente meio ciclo atrás (se cada uma tivesse a
   *  própria fase, a defasagem derivaria e as vozes sairiam de fase uma com a outra) */
  private phase = 0;
  private voices = [
    { p: 0, W: 1440 },
    { p: 0.5, W: 1440 },
  ];
  private readonly minDelay = 32;
  /** volume da voz: sobe/desce em ~15 ms quando a nota aparece/some (sem estalo) */
  private gate = 0;
  private gateA = Math.exp(-1 / (sampleRate * 0.015));
  constructor() {
    super();
    this.port.onmessage = (e: MessageEvent) => {
      const m = e.data as { key: number; minor: boolean; offset: number };
      this.key = m.key;
      this.minor = m.minor;
      this.offset = m.offset;
      this.updateRatio();
    };
  }
  private updateRatio() {
    if (!this.period) return;
    const f = sampleRate / this.period;
    const note = Math.round(69 + 12 * Math.log2(f / 440));
    this.ratio = 2 ** (harmonySemis(note, this.key, this.minor, this.offset) / 12);
  }
  /** YIN sobre o sinal reduzido: devolve o período (amostras na taxa cheia) ou 0 se não há nota clara. */
  private detect(): number {
    const sr = sampleRate / 4, N = 384, d = this.dec, L = d.length;
    const minT = Math.floor(sr / 1000), maxT = Math.ceil(sr / 65);
    const start = (this.dw - N - maxT + L * 2) % L;
    const x = (k: number) => d[(start + k) % L];
    let energy = 0;
    for (let k = 0; k < N; k++) energy += x(k) * x(k);
    if (energy / N < 1e-6) return 0;
    let run = 0;
    let best = 0;
    const cmnd = new Float32Array(maxT + 2);
    cmnd[0] = 1;
    for (let t = 1; t <= maxT + 1; t++) {
      let s = 0;
      for (let k = 0; k < N; k++) {
        const v = x(k) - x(k + t);
        s += v * v;
      }
      run += s;
      cmnd[t] = run > 0 ? (s * t) / run : 1;
    }
    for (let t = minT; t <= maxT; t++) {
      if (cmnd[t] < 0.15 && cmnd[t] <= cmnd[t + 1]) {
        best = t;
        break;
      }
    }
    if (!best) return 0;
    // interpolação parabólica do mínimo
    const a = cmnd[best - 1], b = cmnd[best], c = cmnd[best + 1];
    const den = a - 2 * b + c;
    const t = den > 0 ? best + (0.5 * (a - c)) / den : best;
    return t * 4;
  }
  private read(delay: number): number {
    const L = this.ring.length;
    const pos = this.w - delay;
    const i = Math.floor(pos);
    const f = pos - i;
    const a = this.ring[(i + L * 4) % L], b = this.ring[(i + 1 + L * 4) % L];
    return a + (b - a) * f;
  }
  /**
   * Tamanho do grão: ~30 ms arredondado para um número PAR de períodos da nota. As duas vozes andam
   * meio grão defasadas; com isso a diferença de atraso entre elas é um número inteiro de períodos e
   * elas ficam em fase (somam sem cancelar).
   */
  private grain(): number {
    const base = 0.03 * sampleRate;
    if (!this.period) return base;
    return Math.max(1, Math.round(base / (2 * this.period))) * 2 * this.period;
  }
  process(inputs: Float32Array[][], outputs: Float32Array[][], params: Record<string, Float32Array>) {
    const inp = inputs[0];
    const out = outputs[0];
    const n = out[0].length;
    const level = params.level[0];
    const L = this.ring.length;
    for (let i = 0; i < n; i++) {
      let x = 0;
      for (const ch of inp) x += ch[i];
      if (inp.length > 1) x /= inp.length;
      this.ring[this.w % L] = x;
      this.w++;
      if (this.w >= L * 64) this.w -= L * 32; // mantém o índice pequeno (múltiplo de L: mesma posição)
      this.acc += x;
      if (++this.accN === 4) {
        this.dec[this.dw] = this.acc / 4;
        this.dw = (this.dw + 1) % this.dec.length;
        this.acc = 0;
        this.accN = 0;
      }
      // vozes: atraso em rampa (encolhendo = mais agudo); janela sin² zera no salto do grão
      const up = this.ratio > 1;
      let y = 0, wsum = 0;
      this.phase = (this.phase + Math.abs(1 - this.ratio) / this.voices[0].W) % 1;
      for (let k = 0; k < 2; k++) {
        const v = this.voices[k];
        const np = (this.phase + k * 0.5) % 1;
        // a voz deu a volta (salto do grão, com a janela em zero): só agora pega o grão novo
        if (np < v.p) v.W = this.grain();
        v.p = np;
        const dl = this.minDelay + (up ? 1 - v.p : v.p) * v.W;
        const win = Math.sin(Math.PI * v.p) ** 2;
        y += win * this.read(dl);
        wsum += win;
      }
      const yy = wsum > 1e-3 ? y / wsum : 0;
      const target = this.period ? 1 : 0;
      this.gate = target + (this.gate - target) * this.gateA;
      for (const ch of out) ch[i] = yy * level * this.gate;
    }
    this.sinceDetect += n;
    if (this.sinceDetect >= 256) {
      this.sinceDetect = 0;
      this.period = this.detect();
      this.updateRatio();
    }
    return true;
  }
}

registerProcessor('mm-harmony', HarmonyProcessor);
