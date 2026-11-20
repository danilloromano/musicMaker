// Trilha de acordes: a progressão da música (C – Am – F – G…) e os loops que a seguem.
//
// Cada loop melódico guarda a harmonia sobre a qual foi escrito (`Region.harmony`). Ao tocar, cada nota é
// levada do acorde de origem para o acorde da trilha naquele momento mantendo a função dela: a fundamental
// continua fundamental, a terça vira a terça do acorde novo (maior ou menor), a sétima vira a sétima…
// Notas de passagem da melodia andam pela escala do acorde. As notas guardadas não mudam: trocar os acordes
// depois muda o que toca.
import type { Note } from '../types';

export type ChordQ = 'maj' | 'min' | '7' | 'maj7' | 'm7' | 'm7b5' | 'dim' | 'aug' | 'sus2' | 'sus4' | '5' | '6' | 'm6' | '9' | 'm9' | 'add9';

/** Um acorde da trilha: começa em `beat` e vale até o próximo. `bass` = baixo invertido (F/A). */
export interface ChordEvent {
  id: string;
  beat: number;
  root: number;
  q: ChordQ;
  bass?: number;
  /** escreve com bemol (Bb em vez de A#) */
  flat?: boolean;
}

/** Harmonia de origem de um loop: acordes em tempos dentro de um ciclo de `period` tempos. */
export interface Harmony {
  period: number;
  /** deslocamento no ciclo (a parte da direita de uma região cortada começa no meio dele) */
  offset?: number;
  chords: { at: number; root: number; q: ChordQ }[];
}

// ---------- nomes ----------

const SHARP = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const FLAT = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];
/** Sufixos como nas cifras brasileiras (7M, °, m7(b5)). */
const SUFFIX: Record<ChordQ, string> = {
  maj: '', min: 'm', '7': '7', maj7: '7M', m7: 'm7', m7b5: 'm7(b5)', dim: '°', aug: '+', sus2: 'sus2', sus4: 'sus4', '5': '5', '6': '6', m6: 'm6', '9': '9', m9: 'm9', add9: 'add9',
};

export const noteName = (pc: number, flat = false) => (flat ? FLAT : SHARP)[((pc % 12) + 12) % 12];

export function chordName(c: Pick<ChordEvent, 'root' | 'q' | 'bass' | 'flat'>): string {
  const base = noteName(c.root, c.flat) + SUFFIX[c.q];
  return c.bass !== undefined && c.bass !== c.root ? `${base}/${noteName(c.bass, c.flat)}` : base;
}

const LETTER: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const QUALITY: [RegExp, ChordQ][] = [
  [/^(m7\(?b5\)?|ø7?|m7-5)$/, 'm7b5'],
  [/^(maj7|M7|7M|Δ7?|7\+)$/, 'maj7'],
  [/^(m7|min7|-7)$/, 'm7'],
  [/^(m9|min9|-9|m7\(9\))$/, 'm9'],
  [/^(m6|min6|-6)$/, 'm6'],
  [/^(m|min|-)$/, 'min'],
  [/^(°7?|dim7?|o7?)$/, 'dim'],
  [/^(\+|aug|5\+|\(#5\))$/, 'aug'],
  [/^(sus4?|4)$/, 'sus4'],
  [/^(sus2|2)$/, 'sus2'],
  [/^(add9|\(9\)|add2)$/, 'add9'],
  [/^7$/, '7'],
  [/^(9|7\(9\))$/, '9'],
  [/^6$/, '6'],
  [/^5$/, '5'],
  [/^(maj|M)?$/, 'maj'],
];

/** Lê uma cifra ("Am7", "F/A", "Bb", "G7M", "B°", "Dm7(b5)"). Devolve null se não entender. */
export function parseChord(text: string): Omit<ChordEvent, 'id' | 'beat'> | null {
  const m = text.trim().replace(/♭/g, 'b').replace(/♯/g, '#').match(/^([A-Ga-g])([#b]?)([^/]*)(?:\/([A-Ga-g])([#b]?))?$/);
  if (!m) return null;
  const pc = (l: string, acc: string) => (LETTER[l.toUpperCase()] + (acc === '#' ? 1 : acc === 'b' ? -1 : 0) + 12) % 12;
  const root = pc(m[1], m[2]);
  const q = QUALITY.find(([re]) => re.test(m[3].trim()))?.[1];
  if (!q) return null;
  const out: Omit<ChordEvent, 'id' | 'beat'> = { root, q };
  if (m[2] === 'b' || m[5] === 'b') out.flat = true;
  if (m[4]) out.bass = pc(m[4], m[5]);
  return out;
}

// ---------- escalas (para levar uma nota de um acorde ao outro) ----------

/** Escala de cada tipo de acorde: os 7 graus (1, 2, 3, 4, 5, 6, 7) em semitons sobre a fundamental. */
const SCALE: Record<ChordQ, number[]> = {
  maj: [0, 2, 4, 5, 7, 9, 11],
  '6': [0, 2, 4, 5, 7, 9, 11],
  maj7: [0, 2, 4, 5, 7, 9, 11],
  add9: [0, 2, 4, 5, 7, 9, 11],
  '5': [0, 2, 4, 5, 7, 9, 11],
  '7': [0, 2, 4, 5, 7, 9, 10],
  '9': [0, 2, 4, 5, 7, 9, 10],
  sus4: [0, 2, 5, 5, 7, 9, 10], // a "terça" vira a quarta
  sus2: [0, 2, 2, 5, 7, 9, 11], // a "terça" vira a segunda
  min: [0, 2, 3, 5, 7, 8, 10],
  m7: [0, 2, 3, 5, 7, 9, 10],
  m6: [0, 2, 3, 5, 7, 9, 10],
  m9: [0, 2, 3, 5, 7, 9, 10],
  m7b5: [0, 1, 3, 5, 6, 8, 10],
  dim: [0, 2, 3, 5, 6, 8, 9],
  aug: [0, 2, 4, 5, 8, 9, 11],
};

const mod = (a: number, n: number) => ((a % n) + n) % n;

/** Leva a nota `p` do acorde `from` para o acorde `to`, mantendo a função dela (grau da escala). */
export function moveNote(p: number, from: { root: number; q: ChordQ }, to: { root: number; q: ChordQ; bass?: number }): number {
  const i = mod(p - from.root, 12);
  const src = SCALE[from.q];
  let k = src.indexOf(i);
  let alt = 0;
  if (k < 0) {
    // fora da escala (cromatismo): o grau logo abaixo, mais a diferença
    k = 0;
    for (let j = 0; j < 7; j++) if (src[j] < i) k = j;
    alt = i - src[k];
  }
  const d = mod(to.root - from.root + 6, 12) - 6; // a fundamental anda o mínimo possível (−6…+5)
  let out = p - i + d + SCALE[to.q][k] + alt;
  // baixo invertido (F/A): a fundamental grave vira a nota do baixo
  if (to.bass !== undefined && k === 0 && alt === 0 && p < 52) out += mod(to.bass - out + 6, 12) - 6;
  return out;
}

/** Acorde da trilha num tempo (o último que começou até ali), ou null antes do primeiro. */
export function chordAt(chords: ChordEvent[], beat: number): ChordEvent | null {
  let c: ChordEvent | null = null;
  for (const x of chords) {
    if (x.beat <= beat + 1e-6) c = x;
    else break;
  }
  return c;
}

/** Acorde de origem de um loop num tempo da região. */
function harmonyAt(h: Harmony, t: number) {
  const x = mod(t + (h.offset ?? 0), h.period);
  let c = h.chords[h.chords.length - 1];
  for (const ch of h.chords) if (ch.at <= x + 1e-6) c = ch;
  return c;
}

/** As notas da região levadas para os acordes da trilha (`start` = começo da região na música). */
export function followChords(notes: Note[], h: Harmony, chords: ChordEvent[], start: number): Note[] {
  if (!chords.length || !h.chords.length) return notes;
  return notes.map((n) => {
    const to = chordAt(chords, start + n.start);
    if (!to) return n;
    const from = harmonyAt(h, n.start);
    let pitch = moveNote(n.pitch, from, to);
    while (pitch < 24) pitch += 12;
    while (pitch > 108) pitch -= 12;
    return pitch === n.pitch ? n : { ...n, pitch };
  });
}

// ---------- reconhecer os acordes de um loop ----------

const TEMPLATES: [ChordQ, number[]][] = [
  ['maj', [0, 4, 7]],
  ['min', [0, 3, 7]],
  ['7', [0, 4, 7, 10]],
  ['maj7', [0, 4, 7, 11]],
  ['m7', [0, 3, 7, 10]],
  ['m7b5', [0, 3, 6, 10]],
  ['dim', [0, 3, 6]],
  ['sus4', [0, 5, 7]],
  ['6', [0, 4, 7, 9]],
  ['9', [0, 2, 4, 7, 10]],
  ['m9', [0, 2, 3, 7, 10]],
  ['5', [0, 7]],
  ['aug', [0, 4, 8]],
];

/** O acorde que melhor explica as notas (peso por altura de nota, e a mais grave como dica da fundamental). */
export function guessChord(weights: number[], lowest: number | null): { root: number; q: ChordQ } | null {
  const total = weights.reduce((a, b) => a + b, 0);
  if (total <= 0) return null;
  let best: { root: number; q: ChordQ } | null = null;
  let bestS = -Infinity;
  for (let root = 0; root < 12; root++) {
    for (const [q, tpl] of TEMPLATES) {
      const set = new Set(tpl.map((x) => (root + x) % 12));
      let s = 0;
      for (let pc = 0; pc < 12; pc++) s += set.has(pc) ? weights[pc] : -weights[pc];
      for (const pc of set) if (weights[pc] <= 0) s -= total * 0.12; // nota do acorde que não aparece
      if (lowest !== null && lowest === root) s += total * 0.3; // a mais grave costuma ser a fundamental
      s -= tpl.length * total * 0.01; // empate: o acorde mais simples
      if (s > bestS) {
        bestS = s;
        best = { root, q };
      }
    }
  }
  return best;
}

/** Harmonia de um loop: um acorde por compasso (4 tempos), reconhecido nas notas dele. */
type N3 = Pick<Note, 'pitch' | 'start' | 'duration'>;

/**
 * Harmonia de um loop: um acorde por compasso (4 tempos), reconhecido nas notas dele. `bass` (opcional): a
 * linha de baixo que acompanha (`bassBars` compassos, repetida) — muitos acordes são tocados sem a
 * fundamental (jazz, bossa, blues), e a primeira nota grave do baixo no compasso diz qual é.
 */
export function inferHarmony(notes: N3[], bars: number, bass?: N3[], bassBars = bars): Harmony {
  const chords: Harmony['chords'] = [];
  for (let b = 0; b < bars; b++) {
    const a = b * 4, e = a + 4;
    const w = new Array(12).fill(0);
    let lowest: number | null = null, lowP = Infinity;
    for (const n of notes) {
      const s = Math.max(a, n.start), f = Math.min(e, n.start + n.duration);
      if (f <= s) continue;
      w[mod(n.pitch, 12)] += f - s;
      if (n.pitch < lowP) {
        lowP = n.pitch;
        lowest = mod(n.pitch, 12);
      }
    }
    if (bass?.length) {
      const ba = (b % bassBars) * 4;
      const inBar = bass.filter((n) => n.start >= ba && n.start < ba + 4);
      // a nota grave do começo do compasso (primeiro tempo) é quase sempre a fundamental; as outras notas
      // do baixo são de passagem e não contam (puxariam o acorde para C6, G6…)
      const first = inBar.filter((n) => n.start < ba + 1).sort((x, y) => x.pitch - y.pitch)[0];
      if (first) {
        lowest = mod(first.pitch, 12);
        w[lowest] += 1;
      }
    }
    const c = guessChord(w, lowest) ?? chords[chords.length - 1];
    if (!c) continue;
    const prev = chords[chords.length - 1];
    if (!prev || prev.root !== c.root || prev.q !== c.q) chords.push({ at: a, ...c });
  }
  return { period: bars * 4, chords };
}
