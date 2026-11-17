// Afinador: acha a frequência da nota tocada (YIN) e diz qual nota é e quantos cents está fora.

export const NOTE_NAMES = ['Dó', 'Dó#', 'Ré', 'Ré#', 'Mi', 'Fá', 'Fá#', 'Sol', 'Sol#', 'Lá', 'Lá#', 'Si'];
/** Letras (como nas tarraxas e nos afinadores de pedal). */
export const NOTE_LETTERS = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

/** Botão "Referência" (0–1) → frequência do Lá central, de 430 a 450 Hz (meio = 440). */
export const tunerRef = (v: number) => Math.round(430 + v * 20);

const MIN_F = 27; // abaixo do Si grave do baixo de 5 cordas (30,9 Hz)
const MAX_F = 1400;

/**
 * YIN num sinal reduzido para metade da taxa (barato o bastante para rodar ~20× por segundo) e depois
 * refinado na taxa cheia em volta do período achado, para a precisão de cents. Devolve Hz ou 0 (sem nota).
 */
export function detectPitch(buf: Float32Array, sr: number): number {
  const half = Math.floor(buf.length / 2);
  const d = new Float32Array(half);
  for (let i = 0; i < half; i++) d[i] = 0.5 * (buf[2 * i] + buf[2 * i + 1]);
  const sr2 = sr / 2;
  const maxT = Math.min(Math.ceil(sr2 / MIN_F), Math.floor(half / 2));
  const minT = Math.max(2, Math.floor(sr2 / MAX_F));
  const N = half - maxT - 2;
  if (N < 64) return 0;

  let energy = 0;
  for (let k = 0; k < N; k++) energy += d[k] * d[k];
  if (energy / N < 2e-6) return 0; // silêncio (≈ -57 dBFS)

  const cmnd = new Float32Array(maxT + 2);
  cmnd[0] = 1;
  let run = 0;
  for (let t = 1; t <= maxT + 1; t++) {
    let s = 0;
    for (let k = 0; k < N; k++) {
      const v = d[k] - d[k + t];
      s += v * v;
    }
    run += s;
    cmnd[t] = run > 0 ? (s * t) / run : 1;
  }
  let best = 0;
  for (let t = minT; t <= maxT; t++) {
    if (cmnd[t] < 0.12) {
      while (t + 1 <= maxT && cmnd[t + 1] < cmnd[t]) t++; // desce até o fundo do vale
      best = t;
      break;
    }
  }
  if (!best) return 0;

  // refino na taxa cheia: diferença ao quadrado em volta de 2×best e interpolação parabólica
  const center = best * 2;
  const M = buf.length - center - 4;
  if (M < 64) return sr2 / best;
  const diff = (t: number) => {
    let s = 0;
    for (let k = 0; k < M; k++) {
      const v = buf[k] - buf[k + t];
      s += v * v;
    }
    return s;
  };
  let bt = center;
  let bv = diff(center);
  for (const t of [center - 2, center - 1, center + 1, center + 2]) {
    const v = diff(t);
    if (v < bv) {
      bv = v;
      bt = t;
    }
  }
  const a = diff(bt - 1), c = diff(bt + 1);
  const den = a - 2 * bv + c;
  const period = den > 0 ? bt + (0.5 * (a - c)) / den : bt;
  return sr / period;
}

export interface TunerReading {
  /** 0–11 (Dó = 0) */
  note: number;
  octave: number;
  /** -50 a +50 */
  cents: number;
  hz: number;
}

/** Frequência → nota mais próxima e o desvio em cents, com o Lá de referência dado. */
export function readNote(hz: number, ref = 440): TunerReading {
  const midi = 69 + 12 * Math.log2(hz / ref);
  const n = Math.round(midi);
  return { note: ((n % 12) + 12) % 12, octave: Math.floor(n / 12) - 1, cents: (midi - n) * 100, hz };
}
