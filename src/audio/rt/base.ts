// Base dos efeitos do motor de baixa latência: parâmetros suavizados, tabelas das curvas e utilitários de bloco.
import { powerTube, triode } from '../ampCircuits';
import { Curve, GateCurve, curveFn, gateCurveFn, sampleCurve } from './curves';
import { Biquad, BiquadType, Param, Shaper, VarBiquad } from './dsp';

/** Constante de tempo da suavização dos botões (a mesma do `put` do rack do app). */
export const SMOOTH = 0.015;

/**
 * Valor de um parâmetro como o AudioParam do app o entrega a um AudioWorklet: em float32. Importa onde o núcleo
 * arredonda (ex.: o tamanho do trecho do delay reverso pode mudar 1 amostra).
 */
export const f32 = (p: Param) => Math.fround(p.value);

export const num = (v: number | undefined, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

// ---------- Tabelas das curvas (as mesmas do WaveShaperNode do app) ----------

const tables = new Map<string, Float32Array>();
export const table = (key: string, make: () => Float32Array) => {
  let t = tables.get(key);
  if (!t) tables.set(key, (t = make()));
  return t;
};
export const clipTable = (k: Curve) => table(k, () => sampleCurve(curveFn(k), 4096));
export const gateTable = (k: GateCurve) => table(`gate:${k}`, () => sampleCurve(gateCurveFn(k), 2048));
export const tubeTable = (k: 'triode' | 'power') => table(`tube:${k}`, () => sampleCurve(k === 'triode' ? triode : powerTube, 4096));

// ---------- Base ----------

/** Contexto da música que alguns pedais usam (andamento do delay sincronizado, tom do harmonizador). */
export interface RigEnv {
  bpm: number;
  song: { root: number; minor: boolean } | null;
}

/** Um efeito: processa um bloco no lugar; `set` recebe os botões (0..1). */
export abstract class Fx {
  readonly params: Param[] = [];
  env: RigEnv = { bpm: 120, song: null };
  constructor(protected sr: number, protected B: number) {}
  p(v = 1) {
    const x = new Param(v);
    this.params.push(x);
    return x;
  }
  vb(type: BiquadType, f: number, q = Math.SQRT1_2, db = 0) {
    const v = new VarBiquad(this.sr, type, f, q, db);
    this.params.push(...v.params());
    return v;
  }
  bq(type: BiquadType, f: number, q = Math.SQRT1_2, db = 0) {
    return new Biquad(this.sr, type, f, q, db);
  }
  clip(k: Curve) {
    return new Shaper(clipTable(k), this.sr, true);
  }
  buf() {
    return new Float64Array(this.B);
  }
  tick(k: number) {
    for (const p of this.params) p.tick(k);
  }
  abstract run(b: Float64Array, n: number): void;
  abstract set(p: number[], snap: boolean): void;
}

export const copy = (src: Float64Array, dst: Float64Array, n: number) => {
  for (let i = 0; i < n; i++) dst[i] = src[i];
};
export const add = (dst: Float64Array, src: Float64Array, n: number) => {
  for (let i = 0; i < n; i++) dst[i] += src[i];
};
export const scale = (b: Float64Array, n: number, g: number) => {
  for (let i = 0; i < n; i++) b[i] *= g;
};

