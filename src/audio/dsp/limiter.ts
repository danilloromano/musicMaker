// Limitador de pico real com antecipação (lookahead): olha alguns milissegundos à frente e começa a
// baixar o volume antes de o pico chegar, então nada passa do teto — nem os picos entre amostras.
// Código puro (sem Web Audio): roda no AudioWorklet do master e na exportação.
import { TRUE_PEAK_DELAY, TruePeak } from './loudness';

/**
 * Envelope de ganho do limitador. Para cada amostra recebe o ganho necessário (≤ 1) e devolve o ganho
 * a aplicar à amostra que entrou `delay` amostras antes:
 *  1. mínimo móvel numa janela de `A` + 3 amostras (segura o ganho baixo desde antes do pico; as 3 a
 *     mais cobrem a incerteza de posição do detector de pico real);
 *  2. recuperação exponencial (release) quando o ganho necessário volta a subir;
 *  3. média móvel de `A` amostras (suaviza o ataque).
 * Como cada valor que entra na média já é ≤ ao ganho necessário no pico, a média também é: o pico
 * nunca passa do teto.
 */
export class LimiterEnvelope {
  readonly delay: number;
  private readonly A: number;
  private dqVal: Float64Array;
  private dqIdx: Float64Array;
  private head = 0;
  private size = 0;
  private n = 0;
  private rel = 1;
  private relCoef: number;
  private box: Float64Array;
  private boxPos = 0;
  private sum: number;

  constructor(sr: number, lookahead = 0.005, release = 0.12) {
    this.A = Math.max(1, Math.round(lookahead * sr));
    this.delay = this.A;
    this.dqVal = new Float64Array(this.A + 5);
    this.dqIdx = new Float64Array(this.A + 5);
    this.box = new Float64Array(this.A).fill(1);
    this.sum = this.A;
    this.relCoef = Math.exp(-1 / (sr * release));
  }

  setRelease(sr: number, release: number) {
    this.relCoef = Math.exp(-1 / (sr * Math.max(0.001, release)));
  }

  next(req: number): number {
    const cap = this.dqVal.length;
    // fila monotônica: o mínimo da janela fica sempre na frente
    while (this.size > 0) {
      const back = (this.head + this.size - 1) % cap;
      if (this.dqVal[back] >= req) this.size--;
      else break;
    }
    const at = (this.head + this.size) % cap;
    this.dqVal[at] = req;
    this.dqIdx[at] = this.n;
    this.size++;
    while (this.dqIdx[this.head] <= this.n - (this.A + 3)) {
      this.head = (this.head + 1) % cap;
      this.size--;
    }
    const held = this.dqVal[this.head];
    this.rel = held < this.rel ? held : this.rel + (held - this.rel) * (1 - this.relCoef);
    this.sum += this.rel - this.box[this.boxPos];
    this.box[this.boxPos] = this.rel;
    this.boxPos = (this.boxPos + 1) % this.A;
    this.n++;
    return this.sum / this.A;
  }
}

export interface LimiterSettings {
  /** ganho de entrada (linear): empurra a música contra o teto (mais alto) */
  gain: number;
  /** teto de pico real (linear) */
  ceiling: number;
  /** recuperação (s) */
  release: number;
}

/**
 * Limitador estéreo em fluxo (para o AudioWorklet): processa amostra a amostra, com atraso fixo de
 * `latency` amostras (a antecipação + o atraso do detector de pico real).
 */
export class StereoLimiter {
  readonly latency: number;
  private env: LimiterEnvelope;
  private tpL = new TruePeak();
  private tpR = new TruePeak();
  private bufL: Float32Array;
  private bufR: Float32Array;
  private pos = 0;
  /** menor ganho aplicado desde a última leitura (para o medidor de redução) */
  minGain = 1;

  constructor(private sr: number, public s: LimiterSettings) {
    this.env = new LimiterEnvelope(sr, 0.005, s.release);
    this.latency = this.env.delay + TRUE_PEAK_DELAY;
    this.bufL = new Float32Array(this.latency);
    this.bufR = new Float32Array(this.latency);
  }

  update(s: LimiterSettings) {
    this.s = s;
    this.env.setRelease(this.sr, s.release);
  }

  /** Processa um bloco no lugar. `active` = false deixa passar (com o mesmo atraso, sem saltos). */
  process(l: Float32Array, r: Float32Array, active: boolean) {
    const { gain, ceiling } = this.s;
    const L = this.latency;
    for (let i = 0; i < l.length; i++) {
      const x = l[i] * gain;
      const y = r[i] * gain;
      const peak = Math.max(this.tpL.next(x), this.tpR.next(y));
      const g = this.env.next(peak > ceiling ? ceiling / peak : 1);
      const dl = this.bufL[this.pos];
      const dr = this.bufR[this.pos];
      this.bufL[this.pos] = active ? x : l[i];
      this.bufR[this.pos] = active ? y : r[i];
      this.pos = (this.pos + 1) % L;
      if (active) {
        l[i] = dl * g;
        r[i] = dr * g;
        if (g < this.minGain) this.minGain = g;
      } else {
        l[i] = dl;
        r[i] = dr;
      }
    }
  }
}

/** Picos reais (máximo entre os canais) de cada amostra de um áudio estéreo — calculado uma vez. */
export async function truePeaks(l: Float32Array, r: Float32Array, onProgress?: (p: number) => void): Promise<Float32Array> {
  const out = new Float32Array(l.length);
  const a = new TruePeak();
  const b = new TruePeak();
  const chunk = 1 << 17;
  for (let s = 0; s < l.length; s += chunk) {
    const e = Math.min(l.length, s + chunk);
    for (let i = s; i < e; i++) out[i] = Math.max(a.next(l[i]), b.next(r[i]));
    onProgress?.(e / l.length);
    await new Promise((ok) => setTimeout(ok, 0));
  }
  return out;
}

/**
 * Limita um áudio inteiro (exportação), reaproveitando os picos já calculados da entrada: com ganho
 * `gain`, o pico de cada amostra é simplesmente `gain × pico`. Devolve os canais limitados.
 */
export async function limitBuffer(
  l: Float32Array,
  r: Float32Array,
  peaks: Float32Array,
  sr: number,
  s: LimiterSettings,
): Promise<[Float32Array, Float32Array]> {
  const env = new LimiterEnvelope(sr, 0.005, s.release);
  const shift = env.delay + TRUE_PEAK_DELAY;
  const n = l.length;
  const ol = new Float32Array(n);
  const or = new Float32Array(n);
  const chunk = 1 << 17;
  for (let st = 0; st < n + shift; st += chunk) {
    const e = Math.min(n + shift, st + chunk);
    for (let i = st; i < e; i++) {
      const p = i < n ? peaks[i] * s.gain : 0;
      const g = env.next(p > s.ceiling ? s.ceiling / p : 1);
      const j = i - shift;
      if (j >= 0) {
        ol[j] = l[j] * s.gain * g;
        or[j] = r[j] * s.gain * g;
      }
    }
    await new Promise((ok) => setTimeout(ok, 0));
  }
  return [ol, or];
}
