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

// ---------- Afinações ----------

/** Nomes com bemol: nas afinações rebaixadas as cordas se chamam Mi♭, Lá♭… (e não Ré#, Sol#…). */
export const NOTE_NAMES_FLAT = ['Dó', 'Ré♭', 'Ré', 'Mi♭', 'Mi', 'Fá', 'Sol♭', 'Sol', 'Lá♭', 'Lá', 'Si♭', 'Si'];
export const NOTE_LETTERS_FLAT = ['C', 'D♭', 'D', 'E♭', 'E', 'F', 'G♭', 'G', 'A♭', 'A', 'B♭', 'B'];

export interface Tuning {
  id: string;
  name: string;
  group: string;
  /** cordas da mais grave para a mais aguda (notas MIDI) */
  strings: number[];
  flats?: boolean;
}

const GTR = [40, 45, 50, 55, 59, 64]; // Mi Lá Ré Sol Si Mi
const BASS = [28, 33, 38, 43]; // Mi Lá Ré Sol
const down = (s: number[], n: number) => s.map((x) => x - n);

/** Afinações prontas. A primeira ("Cromático") não tem cordas: mostra qualquer nota. */
export const TUNINGS: Tuning[] = [
  { id: 'chromatic', name: 'Cromático (qualquer nota)', group: 'Livre', strings: [] },
  { id: 'gtr', name: 'Padrão (E A D G B E)', group: 'Guitarra / violão', strings: GTR },
  { id: 'gtr-1', name: 'Meio tom abaixo (E♭)', group: 'Guitarra / violão', strings: down(GTR, 1), flats: true },
  { id: 'gtr-2', name: '1 tom abaixo (D)', group: 'Guitarra / violão', strings: down(GTR, 2) },
  { id: 'gtr-3', name: '1 tom e meio abaixo (C#)', group: 'Guitarra / violão', strings: down(GTR, 3), flats: true },
  { id: 'gtr-4', name: '2 tons abaixo (C)', group: 'Guitarra / violão', strings: down(GTR, 4) },
  { id: 'gtr-5', name: '2 tons e meio abaixo (B)', group: 'Guitarra / violão', strings: down(GTR, 5) },
  { id: 'dropd', name: 'Drop D (D A D G B E)', group: 'Guitarra / violão', strings: [38, 45, 50, 55, 59, 64] },
  { id: 'dropcs', name: 'Drop C# (meio tom abaixo + drop)', group: 'Guitarra / violão', strings: [37, 44, 49, 54, 58, 63], flats: true },
  { id: 'dropc', name: 'Drop C (1 tom abaixo + drop)', group: 'Guitarra / violão', strings: [36, 43, 48, 53, 57, 62] },
  { id: 'dropb', name: 'Drop B', group: 'Guitarra / violão', strings: [35, 42, 47, 52, 56, 61], flats: true },
  { id: 'openg', name: 'Open G (D G D G B D)', group: 'Guitarra / violão', strings: [38, 43, 50, 55, 59, 62] },
  { id: 'opend', name: 'Open D (D A D F# A D)', group: 'Guitarra / violão', strings: [38, 45, 50, 54, 57, 62] },
  { id: 'opene', name: 'Open E (E B E G# B E)', group: 'Guitarra / violão', strings: [40, 47, 52, 56, 59, 64] },
  { id: 'dadgad', name: 'DADGAD', group: 'Guitarra / violão', strings: [38, 45, 50, 55, 57, 62] },
  { id: 'gtr7', name: '7 cordas (B E A D G B E)', group: 'Guitarra / violão', strings: [35, ...GTR] },
  { id: 'vl7', name: 'Violão 7 cordas (C E A D G B E)', group: 'Guitarra / violão', strings: [36, ...GTR] },
  { id: 'bass', name: 'Padrão (E A D G)', group: 'Baixo', strings: BASS },
  { id: 'bass-1', name: 'Meio tom abaixo (E♭)', group: 'Baixo', strings: down(BASS, 1), flats: true },
  { id: 'bass-2', name: '1 tom abaixo (D)', group: 'Baixo', strings: down(BASS, 2) },
  { id: 'bass-dropd', name: 'Drop D (D A D G)', group: 'Baixo', strings: [26, 33, 38, 43] },
  { id: 'bass-dropc', name: 'Drop C (C G C F)', group: 'Baixo', strings: [24, 31, 36, 41] },
  { id: 'bass5', name: '5 cordas (B E A D G)', group: 'Baixo', strings: [23, ...BASS] },
  { id: 'bass5-1', name: '5 cordas meio tom abaixo', group: 'Baixo', strings: down([23, ...BASS], 1), flats: true },
  { id: 'cavaco', name: 'Cavaquinho (D G B D)', group: 'Outros', strings: [62, 67, 71, 74] },
  { id: 'ukulele', name: 'Ukulele (G C E A)', group: 'Outros', strings: [67, 60, 64, 69] },
];

export const tuningOf = (id: string | null | undefined) => TUNINGS.find((t) => t.id === id) ?? TUNINGS[0];

/** Nome (letra e por extenso) de uma nota MIDI na grafia da afinação. */
export function stringName(midi: number, flats = false) {
  const pc = ((midi % 12) + 12) % 12;
  return { letter: (flats ? NOTE_LETTERS_FLAT : NOTE_LETTERS)[pc], name: (flats ? NOTE_NAMES_FLAT : NOTE_NAMES)[pc] };
}

/**
 * Qual corda da afinação está sendo tocada (a mais próxima da nota lida) e quantos cents falta para ela.
 * `index` segue a ordem de `strings`; cents positivos = acima (afrouxar), negativos = abaixo (apertar).
 */
export function readString(hz: number, t: Tuning, ref = 440): { index: number; cents: number } {
  const m = 69 + 12 * Math.log2(hz / ref);
  let index = 0;
  for (let i = 1; i < t.strings.length; i++) if (Math.abs(m - t.strings[i]) < Math.abs(m - t.strings[index])) index = i;
  return { index, cents: (m - t.strings[index]) * 100 };
}
