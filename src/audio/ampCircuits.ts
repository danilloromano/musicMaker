// Matemática dos circuitos dos amplificadores, sem dependência do navegador
// (é a mesma que a simulação de testes usa).

// ---------- Tone stack passivo (Graves / Médios / Agudos) ----------
// Topologia "TMB" usada por Fender e Marshall: três potenciômetros e três capacitores que interagem
// (mexer nos graves muda os médios etc.). Função de transferência de 3ª ordem conforme D. T. Yeh e
// J. O. Smith, "Discretization of the '59 Fender Bassman Tone Stack" (DAFx 2006).

export interface ToneStackParts {
  R1: number; // resistor de "slope"
  R2: number; // potenciômetro de graves
  R3: number; // potenciômetro de médios
  R4: number; // potenciômetro de agudos
  C1: number; // capacitor de agudos
  C2: number; // capacitor de graves
  C3: number; // capacitor de médios
}

/** Valores de componentes dos esquemas publicados. */
export const STACKS = {
  // Fender "blackface" AB763 (Twin Reverb)
  blackface: { R1: 100e3, R2: 250e3, R3: 10e3, R4: 250e3, C1: 250e-12, C2: 100e-9, C3: 47e-9 },
  // Fender 5F6-A Bassman (1959)
  bassman: { R1: 56e3, R2: 1e6, R3: 25e3, R4: 250e3, C1: 250e-12, C2: 20e-9, C3: 20e-9 },
  // Marshall JCM800 2203
  jcm800: { R1: 33e3, R2: 1e6, R3: 25e3, R4: 220e3, C1: 470e-12, C2: 22e-9, C3: 22e-9 },
} satisfies Record<string, ToneStackParts>;

/** Potenciômetro logarítmico (curva de áudio), como os de graves e médios dos amps. */
export const potLog = (v: number) => Math.exp((v - 1) * 3.4);

/** Coeficientes analógicos H(s) = (b1 s + b2 s² + b3 s³) / (1 + a1 s + a2 s² + a3 s³). t, m, l = posição dos pots (0..1). */
export function toneStackS({ R1, R2, R3, R4, C1, C2, C3 }: ToneStackParts, t: number, m: number, l: number) {
  const b1 = t * C1 * R1 + m * C3 * R3 + l * (C1 * R2 + C2 * R2) + (C1 * R3 + C2 * R3);
  const b2 =
    t * (C1 * C2 * R1 * R4 + C1 * C3 * R1 * R4) -
    m * m * (C1 * C3 * R3 * R3 + C2 * C3 * R3 * R3) +
    m * (C1 * C3 * R1 * R3 + C1 * C3 * R3 * R3 + C2 * C3 * R3 * R3) +
    l * (C1 * C2 * R1 * R2 + C1 * C2 * R2 * R4 + C1 * C3 * R2 * R4) +
    l * m * (C1 * C3 * R2 * R3 + C2 * C3 * R2 * R3) +
    (C1 * C2 * R1 * R3 + C1 * C2 * R3 * R4 + C1 * C3 * R3 * R4);
  const b3 =
    l * m * (C1 * C2 * C3 * R1 * R2 * R3 + C1 * C2 * C3 * R2 * R3 * R4) -
    m * m * (C1 * C2 * C3 * R1 * R3 * R3 + C1 * C2 * C3 * R3 * R3 * R4) +
    m * (C1 * C2 * C3 * R1 * R3 * R3 + C1 * C2 * C3 * R3 * R3 * R4) +
    t * C1 * C2 * C3 * R1 * R3 * R4 -
    t * m * C1 * C2 * C3 * R1 * R3 * R4 +
    t * l * C1 * C2 * C3 * R1 * R2 * R4;
  const a1 = C1 * R1 + C1 * R3 + C2 * R3 + C2 * R4 + C3 * R4 + m * C3 * R3 + l * (C1 * R2 + C2 * R2);
  const a2 =
    m * (C1 * C3 * R1 * R3 - C2 * C3 * R3 * R4 + C1 * C3 * R3 * R3 + C2 * C3 * R3 * R3) +
    l * m * (C1 * C3 * R2 * R3 + C2 * C3 * R2 * R3) -
    m * m * (C1 * C3 * R3 * R3 + C2 * C3 * R3 * R3) +
    l * (C1 * C2 * R2 * R4 + C1 * C2 * R1 * R2 + C1 * C3 * R2 * R4 + C2 * C3 * R2 * R4) +
    (C1 * C2 * R1 * R4 + C1 * C3 * R1 * R4 + C1 * C2 * R3 * R4 + C1 * C2 * R1 * R3 + C1 * C3 * R3 * R4 + C2 * C3 * R3 * R4);
  const a3 =
    l * m * (C1 * C2 * C3 * R1 * R2 * R3 + C1 * C2 * C3 * R2 * R3 * R4) -
    m * m * (C1 * C2 * C3 * R1 * R3 * R3 + C1 * C2 * C3 * R3 * R3 * R4) +
    m * (C1 * C2 * C3 * R3 * R3 * R4 + C1 * C2 * C3 * R1 * R3 * R3 - C1 * C2 * C3 * R1 * R3 * R4) +
    l * C1 * C2 * C3 * R1 * R2 * R4 +
    C1 * C2 * C3 * R1 * R3 * R4;
  return { b: [0, b1, b2, b3], a: [1, a1, a2, a3] };
}

/** Transformada bilinear de um filtro analógico (coeficientes em potências crescentes de s) para z⁻¹. */
export function bilinear(bs: number[], as: number[], sr: number) {
  const n = Math.max(bs.length, as.length) - 1;
  const c = 2 * sr;
  const mul = (p: number[], q: number[]) => {
    const r = new Array(p.length + q.length - 1).fill(0);
    p.forEach((x, i) => q.forEach((y, j) => (r[i + j] += x * y)));
    return r;
  };
  const term = (k: number) => {
    // s^k → c^k (1 - z⁻¹)^k (1 + z⁻¹)^(n-k)
    let p = [1];
    for (let i = 0; i < k; i++) p = mul(p, [1, -1]);
    for (let i = 0; i < n - k; i++) p = mul(p, [1, 1]);
    return p.map((x) => x * c ** k);
  };
  const b = new Array(n + 1).fill(0), a = new Array(n + 1).fill(0);
  for (let k = 0; k <= n; k++) {
    const t = term(k);
    for (let i = 0; i <= n; i++) {
      b[i] += (bs[k] ?? 0) * t[i];
      a[i] += (as[k] ?? 0) * t[i];
    }
  }
  return { b: b.map((x) => x / a[0]), a: a.map((x) => x / a[0]) };
}

/** Posição dos pots a partir dos botões do app (0..1): graves e médios são logarítmicos, agudos linear. */
export const stackPots = (bass: number, mid: number, treble: number) => ({ t: treble, m: potLog(mid), l: potLog(bass) });

export function toneStackZ(p: ToneStackParts, bass: number, mid: number, treble: number, sr: number) {
  const { t, m, l } = stackPots(bass, mid, treble);
  const s = toneStackS(p, t, m, l);
  return bilinear(s.b, s.a, sr);
}

/** Módulo da resposta de um filtro digital numa frequência. */
export function magnitude(b: number[], a: number[], f: number, sr: number) {
  const w = (2 * Math.PI * f) / sr;
  const ev = (c: number[]) => {
    let re = 0, im = 0;
    c.forEach((x, k) => { re += x * Math.cos(-w * k); im += x * Math.sin(-w * k); });
    return Math.hypot(re, im);
  };
  return ev(b) / ev(a);
}

// ---------- Válvulas ----------

/** Quanto do curso da curva é usado: o joelho da saturação fica em ~1/HEAD do sinal cheio. */
export const HEAD = 4;

/**
 * Estágio de pré (triodo 12AX7) normalizado com inclinação 1 no centro. Assimétrico como a válvula real:
 * do lado positivo a grade começa a conduzir e comprime cedo; do lado negativo a válvula corta mais tarde
 * e mais duro. A assimetria gera harmônicos pares, o "calor" do pré valvulado.
 */
export function triode(x: number) {
  const u = HEAD * x;
  const y = u >= 0 ? Math.tanh(u) : -1.4 * Math.tanh(-u / 1.4);
  return y / HEAD;
}

/** Estágio de potência push-pull: simétrico (os dois lados se cancelam), satura macio, harmônicos ímpares. */
export function powerTube(x: number) {
  return Math.tanh(HEAD * x) / HEAD;
}

// ---------- Modelos ----------

export interface AmpModel {
  id: string;
  name: string;
  desc: string;
  /** de que circuito vêm o tone stack e a ordem dos estágios */
  ref: string;
  stack: ToneStackParts;
  /** 'early' = tone stack logo depois do 1º triodo (Fender); 'late' = depois de toda a distorção (Marshall, Bassman) */
  stackPos: 'early' | 'late';
  inHp: number; // capacitor de entrada (Hz)
  v1: number; // ganho do 1º triodo, antes do botão de ganho
  stages: number[]; // ganhos dos triodos depois do botão de ganho
  stageHp: number; // corte de graves entre estágios (capacitor de catodo/acoplamento), em Hz
  stageLp: number; // corte de agudos de cada estágio (capacitância Miller), em Hz
  bright: number; // dB do capacitor "bright" no pot de ganho (some com o ganho no máximo)
  power: number; // quanto o master empurra as válvulas de potência
  postLp?: number; // corte final de agudos (Hz)
  /** quanto do volume perdido no pot de ganho é devolvido na saída (0 = nada, 1 = tudo): o Ganho mexe na sujeira, não só no volume */
  comp: number;
  out: number; // compensação de volume (ajustada na simulação)
}

export const AMPS: AmpModel[] = [
  {
    id: 'clean', name: 'Limpo Americano', desc: 'Limpo cristalino, médios cavados, muita folga',
    ref: 'Tone stack Fender AB763 "blackface" (Twin Reverb); EQ logo após o 1º triodo',
    stack: STACKS.blackface, stackPos: 'early', inHp: 40, v1: 0.5, stages: [3], stageHp: 20, stageLp: 12000, bright: 6, power: 0.8, comp: 0.8, out: 2.82,
  },
  {
    id: 'jazz', name: 'Jazz Limpo', desc: 'Redondo e quente, agudos domados',
    ref: 'Tone stack Fender AB763 "blackface", com corte de agudos na saída',
    stack: STACKS.blackface, stackPos: 'early', inHp: 40, v1: 0.5, stages: [2], stageHp: 20, stageLp: 9000, bright: 0, power: 0.6, postLp: 4500, comp: 0.8, out: 5.64,
  },
  {
    id: 'crunch', name: 'Crunch Britânico', desc: 'Médios na cara, sujeira de válvula',
    ref: 'Tone stack Marshall JCM800 2203; EQ depois dos estágios de ganho',
    stack: STACKS.jcm800, stackPos: 'late', inHp: 60, v1: 1.5, stages: [8, 4], stageHp: 100, stageLp: 9000, bright: 5, power: 1.2, comp: 0.15, out: 0.525,
  },
  {
    id: 'high', name: 'Alto Ganho', desc: 'Distorção pesada e grave apertado',
    ref: 'Marshall JCM800 "envenenado": um triodo a mais e graves cortados entre estágios',
    stack: STACKS.jcm800, stackPos: 'late', inHp: 120, v1: 1.5, stages: [12, 8, 4], stageHp: 180, stageLp: 7000, bright: 3, power: 1.2, comp: 0.1, out: 0.433,
  },
  {
    id: 'bass', name: 'Baixo Valvulado', desc: 'Grave cheio, quebra suave no talo',
    ref: 'Tone stack Fender 5F6-A Bassman; EQ depois do seguidor de catodo',
    stack: STACKS.bassman, stackPos: 'late', inHp: 20, v1: 1, stages: [2.5], stageHp: 15, stageLp: 10000, bright: 0, power: 1, comp: 0.6, out: 0.815,
  },
];

/** Pot de ganho com curva de áudio bem aberta (~ -48 dB no zero, como um pot log de 1 MΩ). */
export const gainPot = (g: number) => Math.exp((g - 1) * 5.5);
/** Ganho final de saída: compensação do modelo + parte do volume tirado pelo pot de ganho. */
export const outGain = (m: AmpModel, gain: number) => m.out * gainPot(gain) ** -m.comp;
/** Empurrão no estágio de potência conforme o master. */
export const powerDrive = (m: AmpModel, master: number) => m.power * (0.15 + master * 1.7);
