// AudioWorklets: o do master (limitador de pico real + medidores: LUFS, pico real, correlação,
// redução de ganho), o seguidor de envelope do sidechain e o octaver, o harmonizador, o delay reverso, o phaser e o univibe da pedaleira. Rodam na thread de áudio.
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

/**
 * Delay reverso: grava o sinal em trechos do tamanho do tempo do delay e toca cada trecho de trás para
 * frente. Uma cabeça de leitura parte do instante atual e anda para trás (atraso = 2·t, de 0 a 2·tempo);
 * no fim do trecho ela recomeça. Duas cabeças meio trecho defasadas, cada uma com janela sin² (zero
 * nas pontas, onde ela salta), cobrem os saltos uma da outra. As repetições (realimentação) voltam
 * para a gravação, então cada eco também sai invertido de novo. Saída: só as repetições.
 */
class ReverseProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'time', defaultValue: 0.4, minValue: 0.05, maxValue: 3, automationRate: 'k-rate' },
      { name: 'feedback', defaultValue: 0, minValue: 0, maxValue: 0.95, automationRate: 'k-rate' },
    ];
  }
  private buf = new Float32Array(Math.ceil(sampleRate * 7));
  private n = 0;
  private heads = [
    { start: 0, len: 0 },
    { start: 0, len: 0 },
  ];
  private last = 0;
  process(inputs: Float32Array[][], outputs: Float32Array[][], params: Record<string, Float32Array>) {
    const inp = inputs[0];
    const out = outputs[0];
    const len = Math.max(64, Math.round(params.time[0] * sampleRate));
    const fb = params.feedback[0];
    const L = this.buf.length;
    for (const [k, h] of this.heads.entries()) {
      if (!h.len) {
        h.len = len;
        h.start = this.n - (k * len) / 2; // a 2ª cabeça começa meio trecho adiantada
      }
    }
    for (let i = 0; i < out[0].length; i++) {
      let x = 0;
      for (const ch of inp) x += ch[i];
      if (inp.length > 1) x /= inp.length;
      this.buf[this.n % L] = x + fb * this.last;
      let y = 0, ws = 0;
      for (const h of this.heads) {
        let t = this.n - h.start;
        if (t >= h.len) {
          // fim do trecho: recomeça daqui, já com o tempo atual
          h.start = this.n;
          h.len = len;
          t = 0;
        }
        const win = Math.sin((Math.PI * t) / h.len) ** 2;
        const idx = h.start - t; // anda para trás a partir do início do trecho
        y += win * (idx >= 0 ? this.buf[Math.floor(idx) % L] : 0);
        ws += win;
      }
      // as cabeças podem se desalinhar quando o tempo muda: normaliza pela soma das janelas
      const v = ws > 0.05 ? y / ws : y / 0.05;
      this.last = v;
      for (const ch of out) ch[i] = v;
      this.n++;
    }
    return true;
  }
}

registerProcessor('mm-reverse', ReverseProcessor);

/**
 * Phaser: cadeia de filtros passa-tudo de 1ª ordem (4 ou 8 estágios) cuja frequência é varrida por um
 * LFO numa escala logarítmica (cada oitava leva o mesmo tempo, como nos phasers analógicos), com
 * realimentação da saída para a entrada (os vales ficam mais fundos e os picos ressoam). No estéreo o
 * canal direito varre 90° defasado do esquerdo. Saída: só o sinal defasado (o direto é somado fora:
 * é a soma dos dois que cria os vales).
 */
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
  private phase = 0;
  // estado de cada estágio (x1, y1) por canal, e a última saída (realimentação)
  private st = [new Float64Array(24), new Float64Array(24)];
  private last = [0, 0];
  process(inputs: Float32Array[][], outputs: Float32Array[][], params: Record<string, Float32Array>) {
    const inp = inputs[0];
    const out = outputs[0];
    const n = out[0].length;
    const rate = params.rate[0], depth = params.depth[0], fb = params.feedback[0];
    const stages = Math.round(params.stages[0]);
    const stereo = params.stereo[0] >= 0.5;
    const fMin = 180, octaves = 0.5 + depth * 5; // varre de 180 Hz até 180·2^(0,5..5,5) (até ~8 kHz)
    for (let i = 0; i < n; i++) {
      this.phase = (this.phase + rate / sampleRate) % 1;
      let x = 0;
      for (const ch of inp) x += ch[i];
      if (inp.length > 1) x /= inp.length;
      for (let c = 0; c < out.length && c < 2; c++) {
        const ph = this.phase + (stereo && c === 1 ? 0.25 : 0);
        const lfo = 0.5 - 0.5 * Math.cos(2 * Math.PI * ph); // 0..1
        const f = fMin * 2 ** (lfo * octaves);
        const t = Math.tan((Math.PI * Math.min(f, sampleRate * 0.45)) / sampleRate);
        const a = (t - 1) / (t + 1);
        const st = this.st[c];
        let v = x + fb * this.last[c];
        for (let k = 0; k < stages; k++) {
          const x1 = st[2 * k], y1 = st[2 * k + 1];
          const y = a * v + x1 - a * y1;
          st[2 * k] = v;
          st[2 * k + 1] = y;
          v = y;
        }
        // limita a realimentação (com muita ressonância e sinal alto, não deixa disparar)
        this.last[c] = Math.max(-4, Math.min(4, v));
        out[c][i] = v;
      }
    }
    return true;
  }
}

registerProcessor('mm-phaser', PhaserProcessor);

/**
 * Univibe: quatro estágios passa-tudo como um phaser, mas cada um numa frequência diferente (no circuito
 * original os capacitores de cada estágio são de valores bem diferentes), o que espalha os vales de um
 * jeito irregular e "líquido". A varredura vem de uma lâmpada iluminando fotocélulas: o brilho da lâmpada
 * segue o quadrado da onda do oscilador e a fotocélula reage rápido quando a luz sobe e devagar quando
 * desce, então o pulso "lateja" de forma assimétrica. Saída: só o sinal defasado (o modo Chorus soma o
 * direto fora, o modo Vibrato usa só este: a afinação ondula).
 */
class UnivibeProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'rate', defaultValue: 2, minValue: 0.1, maxValue: 15, automationRate: 'k-rate' },
      { name: 'depth', defaultValue: 0.7, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
    ];
  }
  /** frequência de cada estágio com a lâmpada apagada (Hz) */
  private readonly base = [55, 210, 680, 2400];
  private phase = 0;
  private lamp = 0;
  private readonly up = Math.exp(-1 / (sampleRate * 0.012)); // fotocélula: responde em ~12 ms à luz
  private readonly down = Math.exp(-1 / (sampleRate * 0.07)); // e demora ~70 ms para "esquecer"
  private st = new Float64Array(8);
  process(inputs: Float32Array[][], outputs: Float32Array[][], params: Record<string, Float32Array>) {
    const inp = inputs[0];
    const out = outputs[0];
    const n = out[0].length;
    const rate = params.rate[0], depth = params.depth[0];
    const octaves = 0.4 + depth * 2.6;
    for (let i = 0; i < n; i++) {
      this.phase = (this.phase + rate / sampleRate) % 1;
      const osc = 0.5 + 0.5 * Math.sin(2 * Math.PI * this.phase);
      const bright = osc * osc; // brilho da lâmpada
      this.lamp = bright > this.lamp ? bright + (this.lamp - bright) * this.up : bright + (this.lamp - bright) * this.down;
      const mult = 2 ** (this.lamp * octaves);
      let x = 0;
      for (const ch of inp) x += ch[i];
      if (inp.length > 1) x /= inp.length;
      let v = x;
      for (let k = 0; k < 4; k++) {
        const t = Math.tan((Math.PI * Math.min(this.base[k] * mult, sampleRate * 0.45)) / sampleRate);
        const a = (t - 1) / (t + 1);
        const x1 = this.st[2 * k], y1 = this.st[2 * k + 1];
        const y = a * v + x1 - a * y1;
        this.st[2 * k] = v;
        this.st[2 * k + 1] = y;
        v = y;
      }
      for (const ch of out) ch[i] = v;
    }
    return true;
  }
}

registerProcessor('mm-univibe', UnivibeProcessor);

/**
 * Pitch shifter WSOLA (funciona com acordes, não precisa achar a nota). Duas vozes leem o sinal gravado
 * na velocidade da transposição (mais rápido = mais agudo) e se revezam em janelas sin² (meio ciclo
 * defasadas: a soma das janelas é sempre 1). Quando uma voz recomeça, em vez de saltar para um ponto
 * fixo, ela procura (±16 ms em volta) o ponto em que a forma de onda mais se parece com a que a outra
 * voz está tocando (correlação normalizada, ±16 ms). Assim as emendas caem em fase e o "tremido" de um pitch
 * shifter comum some. A busca é feita numa cópia do sinal reduzida a 1/4 da taxa e refinada na taxa
 * cheia. Saída: só o som transposto.
 */
class PitchProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [{ name: 'ratio', defaultValue: 2, minValue: 0.25, maxValue: 4, automationRate: 'k-rate' }];
  }
  private readonly ring = new Float32Array(1 << 16);
  private readonly dec = new Float32Array(1 << 14);
  private w = 0;
  private acc = 0;
  private phase = 0;
  private prev = [0, 0.5];
  private pos = [0, 0];
  private started = false;
  // ajustados por medição (pureza da nota transposta x atraso): grão de 50 ms e busca de ±16 ms
  private readonly W = 0.05 * sampleRate; // quanto o atraso varia num ciclo de cada voz
  private readonly S = Math.round(0.016 * sampleRate); // alcance da busca da emenda
  private readonly minD = 64; // atraso mínimo (a leitura nunca alcança a gravação)
  private readonly N = 96; // amostras (reduzidas) comparadas na busca
  /** ciclo de cada voz (amostras) e atraso de partida para a razão `r` */
  private cycle(r: number) {
    const d = Math.abs(1 - r);
    const P = Math.min(0.3 * sampleRate, Math.max(0.03 * sampleRate, d > 1e-6 ? this.W / d : Infinity));
    const start = this.minD + this.S + (r > 1 ? (r - 1) * P : 0);
    return { P, start };
  }
  private read(p: number): number {
    if (p < 0) return 0;
    const i = Math.floor(p), f = p - i, M = this.ring.length - 1;
    const a = this.ring[i & M], b = this.ring[(i + 1) & M];
    return a + (b - a) * f;
  }
  private readDec(p: number): number {
    const i = Math.floor(p / 4);
    return i < 0 ? 0 : this.dec[i & (this.dec.length - 1)];
  }
  /** correlação normalizada entre os trechos que terminam em `a` e em `b`, lidos para trás na velocidade `r` */
  private corr(a: number, b: number, r: number, fine: boolean): number {
    let ab = 0, aa = 0, bb = 0;
    const step = 4 * r;
    for (let j = 0; j < this.N; j++) {
      const x = fine ? this.read(a - j * step) : this.readDec(a - j * step);
      const y = fine ? this.read(b - j * step) : this.readDec(b - j * step);
      ab += x * y;
      aa += x * x;
      bb += y * y;
    }
    return aa > 1e-12 && bb > 1e-12 ? ab / Math.sqrt(aa * bb) : 0;
  }
  /** recomeça a voz k: perto do atraso de partida, no ponto mais parecido com o que a outra voz toca */
  private restart(k: number, r: number) {
    const target = this.w - this.cycle(r).start;
    const other = this.pos[1 - k];
    let best = 0, bestC = -2;
    for (let d = -this.S; d <= this.S; d += 4) {
      const c = this.corr(target + d, other, r, false);
      if (c > bestC) {
        bestC = c;
        best = d;
      }
    }
    // refino na taxa cheia em volta do melhor ponto
    let fineBest = best;
    for (let d = best - 3; d <= best + 3; d++) {
      const c = this.corr(target + d, other, r, true);
      if (c > bestC) {
        bestC = c;
        fineBest = d;
      }
    }
    this.pos[k] = target + fineBest;
  }
  process(inputs: Float32Array[][], outputs: Float32Array[][], params: Record<string, Float32Array>) {
    const inp = inputs[0];
    const out = outputs[0];
    const n = out[0].length;
    const r = params.ratio[0];
    const { P, start } = this.cycle(r);
    const M = this.ring.length - 1;
    for (let i = 0; i < n; i++) {
      let x = 0;
      for (const ch of inp) x += ch[i];
      if (inp.length > 1) x /= inp.length;
      this.ring[this.w & M] = x;
      this.acc += x;
      if ((this.w & 3) === 3) {
        this.dec[(this.w >> 2) & (this.dec.length - 1)] = this.acc / 4;
        this.acc = 0;
      }
      this.w++;
      if (!this.started) {
        // vozes já na metade de ciclo uma da outra
        this.pos[0] = this.w - start;
        this.pos[1] = this.w - (start + (r > 1 ? -1 : 1) * Math.abs(1 - r) * P * 0.5);
        this.started = true;
      }
      this.phase = (this.phase + 1 / P) % 1;
      let y = 0;
      for (let k = 0; k < 2; k++) {
        const pk = (this.phase + k * 0.5) % 1;
        if (pk < this.prev[k]) this.restart(k, r);
        this.prev[k] = pk;
        // segurança: se a razão mudou no meio do ciclo, não deixa a leitura passar da gravação
        if (this.w - this.pos[k] < this.minD) this.pos[k] = this.w - this.minD;
        const win = Math.sin(Math.PI * pk) ** 2;
        y += win * this.read(this.pos[k]);
        this.pos[k] += r;
      }
      for (const ch of out) ch[i] = y;
    }
    return true;
  }
}

registerProcessor('mm-pitch', PitchProcessor);
