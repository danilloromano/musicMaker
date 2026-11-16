// Biblioteca de loops: padrões MIDI originais que tocam nos instrumentos do próprio app.
import { useStore } from '../store';
import { BEATS_PER_BAR, Note, Region, uid } from '../types';

type N = Omit<Note, 'id'>;

export interface Loop {
  id: string;
  name: string;
  category: 'Bateria' | 'Baixo' | 'Acordes' | 'Melodia';
  kind: 'instrument' | 'drums';
  instrument: string;
  bars: number;
  notes: N[];
}

/** Cada string é um compasso em semicolcheias: x = forte, o = fraco, . = pausa. */
function drums(id: string, name: string, bars: number, pat: Record<number, string>): Loop {
  const notes: N[] = [];
  for (const [pitch, p] of Object.entries(pat)) {
    for (let i = 0; i < bars * 16; i++) {
      const c = p[i % p.length];
      if (c !== '.') notes.push({ pitch: +pitch, start: i / 4, duration: 0.25, velocity: c === 'x' ? 105 : 60 });
    }
  }
  return { id, name, category: 'Bateria', kind: 'drums', instrument: 'drums', bars, notes };
}

/** seq: [início, nota, duração] dentro de um ciclo de `cycle` tempos, repetido até preencher. */
function mel(
  id: string,
  name: string,
  category: Loop['category'],
  instrument: string,
  bars: number,
  seq: [number, number, number][],
  cycle = bars * BEATS_PER_BAR,
  velocity = 95,
): Loop {
  const notes: N[] = [];
  for (let o = 0; o < bars * BEATS_PER_BAR; o += cycle) {
    for (const [s, p, d] of seq) notes.push({ pitch: p, start: o + s, duration: d, velocity });
  }
  return { id, name, category, kind: 'instrument', instrument, bars, notes };
}

const chords = (prog: number[][], beats = 4): [number, number, number][] =>
  prog.flatMap((ch, i) => ch.map((p) => [i * beats, p, beats - 0.1] as [number, number, number]));

const arp = (prog: number[][]): [number, number, number][] =>
  prog.flatMap((ch, i) =>
    Array.from({ length: 16 }, (_, k) => {
      const tones = [...ch, ch[0] + 12, ch[1] + 12];
      const idx = [0, 1, 2, 3, 4, 3, 2, 1][k % 8];
      return [i * 4 + k / 4, tones[idx], 0.22] as [number, number, number];
    }),
  );

const eighths = (roots: number[]): [number, number, number][] =>
  roots.flatMap((r, i) =>
    Array.from({ length: 8 }, (_, k) => [i * 4 + k / 2, k === 6 ? r + 12 : r, 0.42] as [number, number, number]),
  );

const POP = [[60, 64, 67], [59, 62, 67], [57, 60, 64], [57, 60, 65]]; // C G Am F
const MINOR = [[57, 60, 64], [53, 57, 60], [48, 52, 55], [55, 59, 62]]; // Am F C G

export const LOOPS: Loop[] = [
  drums('d-rock', 'Rock Direto', 2, { 36: 'x.......x.x.....', 38: '....x.......x...', 42: 'x.x.x.x.x.x.x.x.' }),
  drums('d-hiphop', 'Boom Bap', 2, { 36: 'x.....x...x.....', 38: '....x.......x...', 42: 'x.o.x.o.x.o.x.oo' }),
  drums('d-house', 'House 4x4', 2, { 36: 'x...x...x...x...', 39: '....x.......x...', 42: 'xo.oxo.oxo.oxo.o', 46: '..x...x...x...x.' }),
  drums('d-funk', 'Funk Sincopado', 2, { 36: 'x..x..x...x..x..', 38: '....x..o.o..x..o', 42: 'xoxoxoxoxoxoxoxo' }),
  drums('d-trap', 'Trap', 2, { 36: 'x......x..x.....', 39: '........x.......', 42: 'x.x.x.xxx.x.xxxx' }),
  drums('d-dembow', 'Dembow', 2, { 36: 'x...x...x...x...', 38: '...x..x....x..x.', 42: 'x.x.x.x.x.x.x.x.' }),
  // Funk americano (estilo anos 70): bumbo sincopado, caixa com ghost notes, chimbal em semicolcheias.
  drums('d-funk-us', 'Funk Americano', 2, {
    36: 'x.x.......x..x..x.x....x..x..x..',
    38: '....x..o.o.ox..o....x..o.o..x..o',
    42: 'xoxoxoxoxoxoxo.oxoxoxoxoxoxoxoxo',
    46: '..............x.................',
  }),
  drums('d-funk-break', 'Funk Breakbeat', 2, {
    36: 'x.x.......x.....x.x.......x..x..',
    38: '....x..o.o..x..o....x..o.o..x...',
    42: 'x.x.x.x.x.x.x.x.x.x.x.x.x.x.x.x.',
    46: '...............................x',
  }),
  // Hardcore: andamento rápido, "skank beat" (bumbo/caixa alternados) e d-beat.
  drums('d-hc-skank', 'Hardcore Skank', 2, {
    36: 'x...x...x...x...',
    38: '..x...x...x...x.',
    42: 'x.x.x.x.x.x.x.x.',
    49: 'x...............................',
  }),
  drums('d-hc-dbeat', 'Hardcore D-Beat', 2, {
    36: 'x.....x.x.....x.',
    38: '....x.......x...',
    46: 'x.x.x.x.x.x.x.x.',
    49: 'x...............................',
  }),
  // Hard rock: groove pesado com chimbal aberto e prato no início.
  drums('d-hardrock', 'Hard Rock', 2, {
    36: 'x.....x.x.x.....x.....x.x...x.x.',
    38: '....x.......x.......x.......x...',
    46: 'x.o.x.o.x.o.x.o.x.o.x.o.x.o.x.o.',
    49: 'x...............................',
  }),
  drums('d-hardrock-half', 'Hard Rock Meio Tempo', 2, {
    36: 'x.....x...x.....x.....x.x.......',
    38: '........x...............x.....oo',
    46: 'x...x...x...x...x...x...x...x...',
    49: 'x...............................',
  }),
  // Reggae: one drop (bumbo + caixa só no 3º tempo), rockers e steppers.
  drums('d-reggae-onedrop', 'Reggae One Drop', 2, {
    36: '........x.......',
    38: '........x.......',
    42: 'x.ox.oxox.ox.oxo',
    46: '..............x.',
  }),
  drums('d-reggae-rockers', 'Reggae Rockers', 2, {
    36: 'x.......x.......',
    38: '........x.......',
    42: '..x...x...x...x.',
    56: '..............................o.',
  }),
  drums('d-reggae-steppers', 'Reggae Steppers', 2, {
    36: 'x...x...x...x...',
    38: '........x.......',
    42: 'x.ox.oxox.ox.oxo',
  }),
  drums('d-toms', 'Virada de Tons', 1, { 36: 'x...x...x...x...', 50: 'xx.x............', 48: '....xx.x........', 45: '........xx.xx.x.', 49: '...............x' }),

  mel('b-pop', 'Baixo Pop', 'Baixo', 'bass', 4, eighths([36, 31, 33, 29])),
  mel('b-minor', 'Baixo Menor', 'Baixo', 'bass', 4, eighths([33, 29, 36, 31])),
  mel('b-groove', 'Baixo Groove', 'Baixo', 'bass', 2,
    [[0, 36, 0.5], [0.75, 36, 0.25], [1.5, 48, 0.25], [2, 36, 0.5], [2.75, 39, 0.25], [3, 41, 0.5], [3.5, 43, 0.5]], 4),

  mel('c-pop', 'Acordes Pop', 'Acordes', 'epiano', 4, chords(POP), 16, 85),
  mel('c-minor', 'Acordes Menores', 'Acordes', 'epiano', 4, chords(MINOR), 16, 85),
  mel('c-pad', 'Pad Atmosférico', 'Acordes', 'pad', 4, chords(MINOR.map((c) => c.map((p) => p - 12).concat(c[2]))), 16, 80),
  mel('c-strings', 'Cordas Longas', 'Acordes', 'strings', 4, chords(POP), 16, 80),

  mel('m-arp', 'Arpejo Pluck', 'Melodia', 'pluck', 4, arp(MINOR), 16, 90),
  mel('m-arp-pop', 'Arpejo Brilhante', 'Melodia', 'bell', 4, arp(POP.map((c) => c.map((p) => p + 12))), 16, 75),
  mel('m-lead', 'Frase Lead', 'Melodia', 'lead', 4, [
    [0, 72, 1], [1, 76, 0.5], [1.5, 79, 1], [3, 76, 0.5], [3.5, 74, 0.5],
    [4, 74, 1.5], [5.5, 71, 0.5], [6, 67, 2],
    [8, 69, 1], [9, 72, 0.5], [9.5, 76, 1], [11, 72, 0.5], [11.5, 69, 0.5],
    [12, 69, 1], [13, 72, 1], [14, 67, 2],
  ]),
];

/** Coloca um loop na timeline: numa trilha compatível (se indicada) ou numa trilha nova. */
export function addLoop(loop: Loop, beat: number, trackId?: string) {
  const s = useStore.getState();
  const target =
    s.project.tracks.find((t) => t.id === trackId && t.kind === loop.kind) ??
    s.addTrack(loop.kind, { name: loop.name, instrument: loop.instrument });
  const start = Math.max(0, Math.floor(beat / BEATS_PER_BAR) * BEATS_PER_BAR);
  const r = useStore.getState().addRegion({
    trackId: target.id,
    name: loop.name,
    start,
    length: loop.bars * BEATS_PER_BAR,
    notes: loop.notes.map((n) => ({ ...n, id: uid() })),
  });
  useStore.getState().set({ selectedRegionId: r.id, selectedTrackId: target.id });
}

/** Estilos de bateria agrupados por gênero (para o seletor no cabeçalho da trilha de bateria). */
export const DRUM_STYLES: { group: string; ids: string[] }[] = [
  { group: 'Rock', ids: ['d-rock', 'd-hardrock', 'd-hardrock-half', 'd-toms'] },
  { group: 'Hardcore', ids: ['d-hc-skank', 'd-hc-dbeat'] },
  { group: 'Funk', ids: ['d-funk', 'd-funk-us', 'd-funk-break'] },
  { group: 'Reggae', ids: ['d-reggae-onedrop', 'd-reggae-rockers', 'd-reggae-steppers'] },
  { group: 'Hip-hop e eletrônico', ids: ['d-hiphop', 'd-trap', 'd-house', 'd-dembow'] },
];

/** Repete o padrão do loop até preencher `beats` tempos. */
function tile(loop: Loop, beats: number) {
  const cycle = loop.bars * BEATS_PER_BAR;
  const notes: Note[] = [];
  for (let o = 0; o < beats; o += cycle) {
    for (const n of loop.notes) if (o + n.start < beats) notes.push({ ...n, start: o + n.start, id: uid() });
  }
  return notes;
}

/**
 * Aplica um estilo de bateria na trilha: se uma região dela estiver selecionada, troca o ritmo dessa
 * região (mantendo o tamanho); senão cria uma região de 4 compassos na posição do cursor.
 */
export function applyDrumStyle(loopId: string, trackId: string, beat: number) {
  const loop = LOOPS.find((l) => l.id === loopId && l.kind === 'drums');
  if (!loop) return;
  const s = useStore.getState();
  const sel = s.project.regions.find((r) => r.id === s.selectedRegionId && r.trackId === trackId && r.notes);
  if (sel) {
    s.updateRegion(sel.id, { name: loop.name, notes: tile(loop, sel.length) });
    return;
  }
  const length = Math.max(4, loop.bars) * BEATS_PER_BAR;
  const start = Math.max(0, Math.floor(beat / BEATS_PER_BAR) * BEATS_PER_BAR);
  const r = s.addRegion({ trackId, name: loop.name, start, length, notes: tile(loop, length) });
  useStore.getState().set({ selectedRegionId: r.id, selectedTrackId: trackId });
}

/**
 * Notas de uma região esticada para `length` tempos: mantém as que já estavam dentro dela e preenche
 * o trecho novo repetindo o padrão, alinhado ao início da região. O ciclo é o do loop de origem; uma
 * região de bateria que não veio de um estilo repete o próprio tamanho original. Regiões de instrumento
 * só repetem se vieram de um loop (baixo, acordes ou melodia); as desenhadas à mão ficam como estão.
 */
export function extendPattern(r: Region, length: number, kind: Loop['kind']): Note[] | undefined {
  if (!r.notes || length <= r.length || r.length <= 0) return r.notes;
  const loop = LOOPS.find((l) => l.kind === kind && l.name === r.name);
  if (!loop && kind !== 'drums') return r.notes;
  const cycle = Math.min(r.length, loop ? loop.bars * BEATS_PER_BAR : r.length);
  const kept = r.notes.filter((n) => n.start < r.length);
  const base = kept.filter((n) => n.start < cycle);
  const notes = [...kept];
  for (let o = 0; o < length; o += cycle) {
    for (const n of base) {
      const s = o + n.start;
      if (s >= r.length && s < length) notes.push({ ...n, start: s, id: uid() });
    }
  }
  return notes;
}
