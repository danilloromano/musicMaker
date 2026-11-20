// Curvas de saturação dos pedais e do noise gate, sem dependência do navegador: o rack do app (WaveShaperNode)
// e o motor de baixa latência (rt/rig.ts) amostram as mesmas fórmulas, então soam igual.

export type Curve = 'soft' | 'hard' | 'asym' | 'germ' | 'tape' | 'diode' | 'germAsym' | 'fet';

/** Curva de transferência de cada tipo de clipagem, para x em -1..1. */
export function curveFn(kind: Curve): (x: number) => number {
  switch (kind) {
    case 'soft': return (x) => Math.tanh(2.5 * x) / Math.tanh(2.5);
    case 'hard': return (x) => (7 * x) / (1 + 6 * Math.abs(x));
    // fita: ganho 1 nos sinais baixos (não realimenta o laço do delay), comprime só os picos
    case 'tape': return (x) => Math.tanh(1.5 * x) / 1.5;
    case 'germ': return (x) => Math.tanh(1.4 * x) / Math.tanh(1.4); // diodo de germânio: joelho baixo e bem macio
    // diodos de silício para a terra (op-amp com clipagem dura, mas com joelho arredondado)
    case 'diode': return (x) => (4 * x) / (1 + Math.abs(4 * x) ** 2.5) ** 0.4 / 0.988;
    // transistor de germânio polarizado: o lado negativo satura antes (assimetria → harmônicos pares)
    case 'germAsym': return (x) => (x >= 0 ? Math.tanh(1.2 * x) / Math.tanh(1.2) : (-0.8 * Math.tanh(-2.5 * x)) / Math.tanh(2.5));
    // JFET: lei quadrática (x + x²) → curva levemente torta, harmônicos pares; satura bem devagar
    case 'fet': return (x) => Math.tanh(1.4 * x + 0.35 * x * x) / Math.tanh(1.75);
    default: return (x) => (x >= 0 ? Math.tanh(3 * x) / Math.tanh(3) : (-0.7 * Math.tanh(-6 * x)) / Math.tanh(6));
  }
}

export type GateCurve = 'rect' | 'open' | 'clamp';

export function gateCurveFn(kind: GateCurve): (x: number) => number {
  if (kind === 'rect') return Math.abs;
  // entradas acima de 1 ficam no último ponto da curva (1): é o limite da soma dos caminhos
  if (kind === 'clamp') return (x) => Math.max(0, x);
  // fechado abaixo de 0,15, aberto acima de 0,35, transição suave no meio
  return (x) => {
    const t = Math.min(1, Math.max(0, (x - 0.15) / 0.2));
    return t * t * (3 - 2 * t);
  };
}

/** Amostra uma curva em n pontos de -1 a 1 (o formato do WaveShaperNode). */
export function sampleCurve(fn: (x: number) => number, n: number): Float32Array<ArrayBuffer> {
  const c = new Float32Array(n);
  for (let i = 0; i < n; i++) c[i] = fn((i / (n - 1)) * 2 - 1);
  return c;
}
