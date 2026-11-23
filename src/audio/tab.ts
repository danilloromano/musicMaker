// Tablatura e cifra: as notas de uma trilha nas cordas (com a escolha de corda e casa mais tocável) e os
// desenhos de acorde para violão.
import type { ChordEvent, ChordQ } from './chords';
import { chordName } from './chords';

export interface PitchNote {
  start: number; // tempos desde o começo da música
  duration: number;
  pitch: number;
}

/** Uma nota posicionada: corda (0 = a mais grave) e casa. `shifted`: tocada uma oitava acima/abaixo (fora da extensão). */
export interface Fretted extends PitchNote {
  string: number;
  fret: number;
  shifted?: boolean;
}

const MAX_SPAN = 4; // abertura confortável da mão (casas)
const BEAM = 16; // quantos caminhos guardar entre um grupo de notas e o próximo

/**
 * Escolhe corda e casa de cada nota. Notas que começam juntas formam um grupo (acorde); cada grupo pode
 * ser tocado de vários jeitos, e o caminho escolhido é o de menor esforço: mão aberta no máximo 4 casas,
 * poucas mudanças de posição e, no empate, casas mais baixas. `strings`: afinação, da corda mais grave
 * para a mais aguda (MIDI).
 */
export function fingering(notes: PitchNote[], strings: number[], maxFret = 22): Fretted[] {
  if (!notes.length || !strings.length) return [];
  const lo = Math.min(...strings);
  const hi = Math.max(...strings) + maxFret;
  // fora da extensão: muda de oitava
  const fit = notes.map((n) => {
    let p = n.pitch;
    while (p < lo) p += 12;
    while (p > hi) p -= 12;
    return { ...n, pitch: p, shifted: p !== n.pitch };
  });
  // grupos de notas simultâneas (até o número de cordas; sobrando, ficam as mais agudas e a mais grave)
  const sorted = fit.sort((a, b) => a.start - b.start || a.pitch - b.pitch);
  const groups: (typeof sorted)[] = [];
  for (const n of sorted) {
    const g = groups[groups.length - 1];
    if (g && Math.abs(g[0].start - n.start) < 1 / 32) {
      if (!g.some((x) => x.pitch === n.pitch)) g.push(n);
    } else groups.push([n]);
  }
  for (const g of groups) {
    if (g.length > strings.length) {
      g.sort((a, b) => a.pitch - b.pitch);
      g.splice(1, g.length - strings.length);
    }
  }

  type Opt = { frets: number[]; strs: number[]; pos: number; cost: number };
  /** Jeitos de tocar um grupo: cada nota numa corda diferente, mão aberta até MAX_SPAN. */
  const options = (g: typeof sorted): Opt[] => {
    const out: Opt[] = [];
    const strs: number[] = [];
    const frets: number[] = [];
    const used = new Set<number>();
    const rec = (i: number) => {
      if (out.length > 400) return;
      if (i === g.length) {
        const fretted = frets.filter((f) => f > 0);
        const min = fretted.length ? Math.min(...fretted) : 0;
        const max = fretted.length ? Math.max(...fretted) : 0;
        if (max - min > MAX_SPAN) return;
        const pos = fretted.length ? (min + max) / 2 : -1; // -1 = só cordas soltas (a mão fica onde está)
        out.push({ frets: [...frets], strs: [...strs], pos, cost: (max - min) * 0.6 + max * 0.08 });
        return;
      }
      for (let s = 0; s < strings.length; s++) {
        if (used.has(s)) continue;
        const f = g[i].pitch - strings[s];
        if (f < 0 || f > maxFret) continue;
        used.add(s);
        strs.push(s);
        frets.push(f);
        rec(i + 1);
        used.delete(s);
        strs.pop();
        frets.pop();
      }
    };
    rec(0);
    return out;
  };

  // programação dinâmica com feixe: custo acumulado + mudanças de posição da mão
  type Path = { cost: number; pos: number; picks: Opt[] };
  let beam: Path[] = [{ cost: 0, pos: -1, picks: [] }];
  for (const g of groups) {
    const opts = options(g);
    if (!opts.length) {
      // não coube com a mão aberta: cada nota na corda em que fica mais baixa, sem limite de abertura
      const frets: number[] = [], strs: number[] = [];
      const used = new Set<number>();
      for (const n of [...g].sort((a, b) => b.pitch - a.pitch)) {
        let best = -1;
        for (let s = strings.length - 1; s >= 0; s--) if (!used.has(s) && n.pitch - strings[s] >= 0 && (best < 0 || n.pitch - strings[s] < n.pitch - strings[best])) best = s;
        if (best < 0) continue;
        used.add(best);
        strs.push(best);
        frets.push(n.pitch - strings[best]);
      }
      opts.push({ frets, strs, pos: -1, cost: 5 });
    }
    const next: Path[] = [];
    for (const path of beam) {
      for (const o of opts) {
        const move = o.pos < 0 || path.pos < 0 ? 0 : Math.abs(o.pos - path.pos);
        next.push({ cost: path.cost + o.cost + move * 0.5 + (move > 4 ? 2 : 0), pos: o.pos < 0 ? path.pos : o.pos, picks: [...path.picks, o] });
      }
    }
    next.sort((a, b) => a.cost - b.cost);
    beam = next.slice(0, BEAM);
  }
  const best = beam[0];
  const res: Fretted[] = [];
  groups.forEach((g, gi) => {
    const o = best.picks[gi];
    const order = g.length === o.frets.length ? g : [...g].sort((a, b) => b.pitch - a.pitch);
    order.forEach((n, k) => {
      if (k < o.frets.length) res.push({ start: n.start, duration: n.duration, pitch: n.pitch, string: o.strs[k], fret: o.frets[k], shifted: n.shifted || undefined });
    });
  });
  return res;
}

// ---------- tablatura em texto ----------

const STRING_LETTERS = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
export const stringLabel = (midi: number) => STRING_LETTERS[((midi % 12) + 12) % 12];

/** Uma nota na tablatura em texto: casa (-1 = x) e a marca da técnica logo depois (h, p, /, b…). */
export interface AsciiNote {
  start: number;
  string: number;
  fret: number;
  mark?: string;
}

/**
 * Tablatura em texto (para colar em qualquer lugar): `barsPerLine` compassos por linha, cada semicolcheia
 * vira uma célula (3 caracteres ou mais). `labels`: textos por cima (seções e cifras) por tempo.
 */
export function asciiTab(
  frets: AsciiNote[],
  strings: number[],
  barBeats: number,
  totalBars: number,
  barsPerLine = 4,
  labels: { beat: number; text: string }[] = [],
): string {
  // semicolcheias; com notas fora dessa grade (fusas), cada célula vira 1/32
  const STEP = frets.some((f) => Math.abs(f.start * 4 - Math.round(f.start * 4)) > 1e-6) ? 0.125 : 0.25;
  const txt = (f: AsciiNote) => (f.fret < 0 ? 'x' : String(f.fret)) + (f.mark ?? '');
  const CH = Math.max(3, ...frets.map((f) => txt(f).length + 1));
  const lines: string[] = [];
  for (let b0 = 0; b0 < totalBars; b0 += barsPerLine) {
    const b1 = Math.min(totalBars, b0 + barsPerLine);
    const rows = strings.map(() => '');
    let top = '';
    for (let bar = b0; bar < b1; bar++) {
      const slots = Math.round(barBeats / STEP);
      const cells = strings.map(() => Array(slots).fill('-'.repeat(CH)));
      const topCells = Array(slots).fill(' '.repeat(CH));
      for (const f of frets) {
        const rel = f.start - bar * barBeats;
        if (rel < -1e-6 || rel >= barBeats - 1e-6) continue;
        const i = Math.min(slots - 1, Math.round(rel / STEP));
        cells[f.string][i] = txt(f).padEnd(CH, '-');
      }
      for (const l of labels) {
        const rel = l.beat - bar * barBeats;
        if (rel < -1e-6 || rel >= barBeats - 1e-6) continue;
        const i = Math.min(slots - 1, Math.round(rel / STEP));
        topCells[i] = l.text;
      }
      // os rótulos podem ser mais longos que a célula: escrevem por cima das seguintes
      let lab = ' '.repeat(slots * CH + 1);
      topCells.forEach((c, i) => {
        if (!c.trim()) return;
        lab = lab.slice(0, 1 + i * CH) + c + lab.slice(1 + i * CH + c.length);
      });
      top += lab.slice(0, slots * CH + 1);
      cells.forEach((c, s) => (rows[s] += '|' + c.join('')));
    }
    lines.push(top.trimEnd());
    // corda mais aguda em cima (como se lê tablatura)
    for (let s = strings.length - 1; s >= 0; s--) lines.push(stringLabel(strings[s]).padEnd(2) + rows[s] + '|');
    lines.push('');
  }
  return lines.join('\n');
}

// ---------- desenhos de acorde (violão, afinação padrão) ----------

/** Casas da 6ª à 1ª corda (-1 = não toca). */
export type Shape = number[];

const OPEN: Record<string, Shape> = {
  C: [-1, 3, 2, 0, 1, 0], A: [-1, 0, 2, 2, 2, 0], G: [3, 2, 0, 0, 0, 3], E: [0, 2, 2, 1, 0, 0], D: [-1, -1, 0, 2, 3, 2],
  Am: [-1, 0, 2, 2, 1, 0], Em: [0, 2, 2, 0, 0, 0], Dm: [-1, -1, 0, 2, 3, 1],
  A7: [-1, 0, 2, 0, 2, 0], E7: [0, 2, 0, 1, 0, 0], D7: [-1, -1, 0, 2, 1, 2], G7: [3, 2, 0, 0, 0, 1], C7: [-1, 3, 2, 3, 1, 0], B7: [-1, 2, 1, 2, 0, 2],
  Am7: [-1, 0, 2, 0, 1, 0], Em7: [0, 2, 0, 0, 0, 0], Dm7: [-1, -1, 0, 2, 1, 1],
  C7M: [-1, 3, 2, 0, 0, 0], F7M: [-1, -1, 3, 2, 1, 0], A7M: [-1, 0, 2, 1, 2, 0], D7M: [-1, -1, 0, 2, 2, 2], G7M: [3, 2, 0, 0, 0, 2], E7M: [0, 2, 1, 1, 0, 0],
  Asus4: [-1, 0, 2, 2, 3, 0], Dsus4: [-1, -1, 0, 2, 3, 3], Esus4: [0, 2, 2, 2, 0, 0], Asus2: [-1, 0, 2, 2, 0, 0], Dsus2: [-1, -1, 0, 2, 3, 0],
  E5: [0, 2, 2, -1, -1, -1], A5: [-1, 0, 2, 2, -1, -1], D5: [-1, -1, 0, 2, 3, -1],
};

/**
 * Formas móveis com pestana, a partir da fundamental na 6ª corda (E) ou na 5ª (A): casas relativas à da
 * fundamental (podem ser negativas: dedos abaixo dela), null = corda que não toca.
 */
type Rel = (number | null)[];
const x = null;
const MOVABLE: Partial<Record<ChordQ, { e?: Rel; a?: Rel }>> = {
  maj: { e: [0, 2, 2, 1, 0, 0], a: [x, 0, 2, 2, 2, 0] },
  min: { e: [0, 2, 2, 0, 0, 0], a: [x, 0, 2, 2, 1, 0] },
  '7': { e: [0, 2, 0, 1, 0, 0], a: [x, 0, 2, 0, 2, 0] },
  m7: { e: [0, 2, 0, 0, 0, 0], a: [x, 0, 2, 0, 1, 0] },
  maj7: { e: [0, x, 1, 1, 0, x], a: [x, 0, 2, 1, 2, 0] },
  sus4: { e: [0, 2, 2, 2, 0, 0], a: [x, 0, 2, 2, 3, 0] },
  sus2: { a: [x, 0, 2, 2, 0, 0] },
  '5': { e: [0, 2, 2, x, x, x], a: [x, 0, 2, 2, x, x] },
  '6': { a: [x, 0, 2, 2, 2, 2] },
  m6: { a: [x, 0, 2, 2, 1, 2] },
  '9': { a: [x, 0, -1, 0, 0, 0] },
  m9: { a: [x, 0, -2, 0, 0, 0] },
  add9: { a: [x, 0, 2, 2, 0, 0] },
  dim: { a: [x, 0, 1, 2, 1, x] },
  m7b5: { a: [x, 0, 1, 0, 1, x] },
  aug: { a: [x, 0, -1, -2, -2, x] },
};

/** Desenho do acorde: as casas e a casa da pestana (para os móveis). Null se não houver desenho. */
export function chordShape(c: Pick<ChordEvent, 'root' | 'q' | 'flat'>): { frets: Shape; base: number } | null {
  const name = chordName({ root: c.root, q: c.q, flat: c.flat });
  const open = OPEN[name] ?? OPEN[chordName({ root: c.root, q: c.q, flat: !c.flat })];
  if (open) return { frets: open, base: 1 };
  const m = MOVABLE[c.q];
  if (!m) return null;
  const cands: { frets: Shape; base: number }[] = [];
  for (const [key, root0] of [['e', 4], ['a', 9]] as const) {
    const shape = m[key];
    if (!shape) continue;
    let r = (((c.root - root0) % 12) + 12) % 12;
    // forma com dedos abaixo da fundamental: sobe uma oitava se não couber
    if (Math.min(...shape.filter((f): f is number => f !== null)) + r < 0) r += 12;
    cands.push({ frets: shape.map((f) => (f === null ? -1 : f + r)), base: r });
  }
  cands.sort((a, b) => a.base - b.base);
  const best = cands[0];
  if (!best) return null;
  const used = best.frets.filter((f) => f > 0);
  return { frets: best.frets, base: used.length ? Math.min(...used) : 1 };
}
