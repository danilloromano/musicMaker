// Humanizar: tira o "jeito de máquina" das notas com pequenas variações de tempo, força e duração, do jeito
// que um músico de verdade varia (não um sorteio uniforme qualquer).
import { Note } from '../types';

export const HUMANIZE_LEVELS = [
  { id: 'leve', name: 'Leve', ms: 5, vel: 5, dur: 0.03, accent: 0.5 },
  { id: 'medio', name: 'Médio', ms: 10, vel: 9, dur: 0.06, accent: 1 },
  { id: 'forte', name: 'Forte', ms: 18, vel: 14, dur: 0.1, accent: 1.5 },
] as const;
export type HumanizeLevel = (typeof HUMANIZE_LEVELS)[number]['id'];

/** Normal com média 0 e desvio 1, cortada em ±2,5 (nada de nota "perdida" muito longe). */
function gauss(rand: () => number) {
  const u = 1 - rand(), v = rand();
  const g = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  return Math.max(-2.5, Math.min(2.5, g));
}

/** Notas que começam juntas (acordes, bumbo + prato) andam juntas: dentro disso (em tempos) são um grupo. */
const CHORD = 0.02;

/**
 * Devolve as notas humanizadas:
 * - tempo: cada grupo de notas simultâneas desloca junto (desvio de `ms` ms), com uma diferença mínima entre
 *   as notas do grupo (~1,5 ms, como dedos que não caem exatamente juntos);
 * - força: variação aleatória mais um acento de métrica (cabeça do compasso e do tempo mais fortes, as
 *   semicolcheias do contratempo mais fracas), que é o que dá o "balanço";
 * - duração (não na bateria): um pouco mais curta ou mais longa.
 * As notas não saem da região (`length`).
 */
export function humanize(
  notes: Note[],
  opts: { level: HumanizeLevel; bpm: number; length: number; drums: boolean; rand?: () => number },
): Note[] {
  const L = HUMANIZE_LEVELS.find((l) => l.id === opts.level) ?? HUMANIZE_LEVELS[1];
  const rand = opts.rand ?? Math.random;
  // bateria um pouco mais firme no tempo (é a referência da banda)
  const beatsPerMs = (opts.bpm / 60000) * (opts.drums ? 0.6 : 1);
  const sorted = [...notes].sort((a, b) => a.start - b.start);
  const shift = new Map<string, number>();
  let groupStart = -Infinity;
  let groupShift = 0;
  for (const n of sorted) {
    if (n.start - groupStart > CHORD) {
      groupStart = n.start;
      groupShift = gauss(rand) * L.ms;
    }
    shift.set(n.id, (groupShift + gauss(rand) * 1.5) * beatsPerMs);
  }

  return notes.map((n) => {
    const pos = ((n.start % 4) + 4) % 4;
    const near = (x: number, step: number) => Math.abs(x / step - Math.round(x / step)) * step < 0.03;
    const accent = near(pos, 4) ? 6 : near(pos, 1) ? 3 : near(pos, 0.5) ? 0 : near(pos, 0.25) ? -5 : 0;
    const velocity = Math.round(Math.max(1, Math.min(127, n.velocity + accent * L.accent + gauss(rand) * L.vel)));
    const start = Math.max(0, Math.min(opts.length - 0.01, n.start + (shift.get(n.id) ?? 0)));
    const duration = opts.drums ? n.duration : Math.max(0.03, n.duration * (1 + gauss(rand) * L.dur));
    return { ...n, start, duration, velocity };
  });
}
