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
/**
 * Padrão de bateria: uma linha por peça, um caractere por passo ('x' forte, 'o' fraco/ghost, '.' nada),
 * repetida até preencher. `div` = passos por tempo: 4 (semicolcheias, o normal) ou 3 (tercinas: shuffle,
 * blues, jazz — 12 passos por compasso).
 */
function drums(id: string, name: string, bars: number, pat: Record<number, string>, div = 4): Loop {
  const notes: N[] = [];
  for (const [pitch, p] of Object.entries(pat)) {
    for (let i = 0; i < bars * BEATS_PER_BAR * div; i++) {
      const c = p[i % p.length];
      if (c !== '.') notes.push({ pitch: +pitch, start: i / div, duration: 1 / div, velocity: c === 'x' ? 105 : 60 });
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
const PSYCH = [[52, 55, 59, 62], [57, 61, 64], [52, 55, 59, 62], [50, 54, 57]]; // Em7 A Em7 D (mi dórico)

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
  // Psicodélico anos 70: groove de rock com chimbal solto, groove tribal nos tons e meio tempo pesado.
  drums('d-psych-groove', 'Psicodélico Groove', 2, {
    36: 'x.....x...x.....x.....x.x...x...',
    38: '....x.......x.......x..o....x.oo',
    42: 'x.x.x.x.x.x.x.x.x.x.x.x.x.x.....',
    46: '..............................x.',
    49: 'x...............................',
  }),
  drums('d-psych-tribal', 'Psicodélico Tribal', 2, {
    36: 'x.....x.x.....x.x.....x.x...x.x.',
    45: '..x...x...x..xx...x...x...x.xxxx',
    48: '....x.......x.......x.......x...',
    42: 'x...x...x...x...x...x...x...x...',
    49: 'x...............................',
  }),
  drums('d-psych-heavy', 'Psicodélico Pesado', 2, {
    36: 'x.......x.x.....x.......x.....x.',
    38: '........x...............x.......',
    46: 'x...x...x...x...x...x...x.......',
    50: '............................xx..',
    48: '..............................x.',
    45: '...............................x',
    49: 'x...............................',
  }),
  // Brasileiros
  drums('d-samba', 'Samba', 2, {
    36: 'x..xx..xx..xx..x',
    42: 'xoxoxoxoxoxoxoxo',
    38: 'o.o..o.o.o..o.o.o.o..o.o..o..o.o',
  }),
  drums('d-bossa', 'Bossa Nova', 2, {
    36: 'x..xx..xx..xx..x',
    38: 'o..o..o...o..o....o..o..o..o....',
    42: 'x.o.x.o.x.o.x.o.',
  }),
  drums('d-baiao', 'Baião', 2, {
    36: 'x..x....x..x....',
    38: '....o.......x...',
    42: 'xoxxxoxxxoxxxoxx',
  }),
  drums('d-xote', 'Xote', 2, {
    36: 'x.....x.x.....x.',
    38: '....x.......x..o',
    42: 'x.x.x.x.x.x.x.x.',
  }),
  // Pop e dança
  drums('d-pop', 'Pop', 2, {
    36: 'x.....x.x.......x.....x.x..x....',
    38: '....x.......x...',
    42: 'x.x.x.x.x.x.x.x.x.x.x.x.x.x.x...',
    46: '..............................x.',
  }),
  drums('d-ballad', 'Balada', 2, {
    36: 'x.........x.....x.......x.x.....',
    38: '........x.......',
    42: 'x.x.x.x.x.x.x.x.',
  }),
  drums('d-disco', 'Disco', 2, {
    36: 'x...x...x...x...',
    38: '....x.......x...',
    42: 'x...x...x...x...',
    46: '..x...x...x...x.',
  }),
  drums('d-motown', 'Motown', 2, {
    36: 'x.x...x.x.x...x.',
    38: 'x...x...x...x...',
    42: 'x.x.x.x.x.x.x.x.',
  }),
  // Shuffle, blues e jazz (grade de tercinas: 12 passos por compasso)
  drums('d-shuffle', 'Shuffle', 2, {
    36: 'x.....x.....',
    38: '...x.....x..',
    42: 'x.xx.xx.xx.x',
  }, 3),
  drums('d-blues', 'Blues Lento 12/8', 2, {
    36: 'x.....x..x..',
    38: '...x.....x..',
    42: 'xooxooxooxoo',
  }, 3),
  drums('d-jazz', 'Jazz Swing', 2, {
    42: 'x..x.xx..x.x',
    36: 'o..o..o..o..',
    38: '.....o.....o.......o..o.',
  }, 3),
  // Metal
  drums('d-metal-double', 'Metal Bumbo Duplo', 2, {
    36: 'xxxxxxxxxxxxxxxx',
    38: '....x.......x...',
    42: 'x.x.x.x.x.x.x.x.',
    49: 'x...............................',
  }),
  drums('d-metal-gallop', 'Metal Galope', 2, {
    36: 'x.xxx.xxx.xxx.xx',
    38: '....x.......x...',
    49: 'x...x...x...x...',
  }),
  drums('d-metal-blast', 'Metal Blast Beat', 2, {
    36: 'x.x.x.x.x.x.x.x.',
    38: '.x.x.x.x.x.x.x.x',
    49: 'x.x.x.x.x.x.x.x.',
  }),
  // Eletrônico
  drums('d-techno', 'Techno', 2, {
    36: 'x...x...x...x...',
    39: '....x.......x...',
    42: 'oxoxoxoxoxoxoxox',
    46: '..x...x...x...x.',
  }),
  drums('d-dnb', 'Drum and Bass', 2, {
    36: 'x.........x.....x.x.......x.....',
    38: '....x.......x.......x..o....x...',
    42: 'x.x.x.x.x.x.x.x.',
  }),
  drums('d-lofi', 'Lo-fi Hip-hop', 2, {
    36: 'x......x..x.....x.....x...x.....',
    38: '....x.......x...',
    42: 'x.o.x.oox.o.x.o.',
  }),
  drums('d-toms', 'Virada de Tons', 1, { 36: 'x...x...x...x...', 50: 'xx.x............', 48: '....xx.x........', 45: '........xx.xx.x.', 49: '...............x' }),

  mel('b-pop', 'Baixo Pop', 'Baixo', 'ebass', 4, eighths([36, 31, 33, 29])),
  mel('b-minor', 'Baixo Menor', 'Baixo', 'ebass', 4, eighths([33, 29, 36, 31])),
  mel('b-groove', 'Baixo Groove', 'Baixo', 'ebass', 2,
    [[0, 36, 0.5], [0.75, 36, 0.25], [1.5, 48, 0.25], [2, 36, 0.5], [2.75, 39, 0.25], [3, 41, 0.5], [3.5, 43, 0.5]], 4),

  // Psicodélico anos 70 (em mi dórico: a sexta maior, Dó#, dá o colorido "viajante")
  mel('b-psych', 'Baixo Psicodélico', 'Baixo', 'ebass', 2, [
    [0, 40, 0.5], [0.75, 40, 0.25], [1, 43, 0.5], [1.5, 45, 0.5], [2, 40, 0.5], [2.5, 50, 0.25], [2.75, 49, 0.25], [3, 47, 0.5], [3.5, 45, 0.5],
    [4, 40, 0.75], [4.75, 40, 0.25], [5, 43, 0.5], [5.5, 45, 0.5], [6, 47, 0.5], [6.5, 49, 0.25], [6.75, 47, 0.25], [7, 45, 0.5], [7.5, 43, 0.5],
  ]),
  mel('c-psych-organ', 'Órgão Psicodélico', 'Acordes', 'organfast', 4, chords(PSYCH), 16, 80),
  mel('m-psych-lead', 'Frase Psicodélica', 'Melodia', 'lead', 4, [
    [0, 76, 1.5], [1.5, 74, 0.5], [2, 71, 0.5], [2.5, 69, 0.5], [3, 67, 1],
    [4, 64, 0.5], [4.5, 67, 0.5], [5, 69, 1], [6, 71, 0.75], [6.75, 73, 0.25], [7, 71, 1],
    [8, 79, 1], [9, 76, 0.5], [9.5, 74, 0.5], [10, 76, 1.5], [11.5, 73, 0.5],
    [12, 71, 0.5], [12.5, 69, 0.5], [13, 67, 0.5], [13.5, 64, 0.5], [14, 64, 2],
  ]),
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
  { group: 'Psicodélico anos 70', ids: ['d-psych-groove', 'd-psych-tribal', 'd-psych-heavy'] },
  { group: 'Brasileiros', ids: ['d-samba', 'd-bossa', 'd-baiao', 'd-xote'] },
  { group: 'Pop e dança', ids: ['d-pop', 'd-ballad', 'd-disco', 'd-motown'] },
  { group: 'Shuffle, blues e jazz', ids: ['d-shuffle', 'd-blues', 'd-jazz'] },
  { group: 'Metal', ids: ['d-metal-double', 'd-metal-gallop', 'd-metal-blast'] },
  { group: 'Hip-hop e eletrônico', ids: ['d-hiphop', 'd-trap', 'd-house', 'd-dembow', 'd-techno', 'd-dnb', 'd-lofi'] },
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
    s.updateRegion(sel.id, { name: loop.name, notes: withFills({ ...sel, name: loop.name }, sel.fills, tile(loop, sel.length)) });
    return;
  }
  const length = Math.max(4, loop.bars) * BEATS_PER_BAR;
  const start = Math.max(0, Math.floor(beat / BEATS_PER_BAR) * BEATS_PER_BAR);
  const fills = DEFAULT_FILLS;
  const notes = withFills({ name: loop.name, length }, fills, tile(loop, length));
  const r = s.addRegion({ trackId, name: loop.name, start, length, fills, notes });
  useStore.getState().set({ selectedRegionId: r.id, selectedTrackId: trackId });
}

/**
 * Notas de uma região esticada para `length` tempos: mantém as que já estavam dentro dela e preenche
 * o trecho novo repetindo o padrão, alinhado ao início da região. O ciclo é o do loop de origem; uma
 * região de bateria que não veio de um estilo repete o próprio tamanho original. Regiões de instrumento
 * só repetem se vieram de um loop (baixo, acordes ou melodia); as desenhadas à mão ficam como estão.
 */
export function extendPattern(r: Region, length: number, kind: Loop['kind']): Note[] | undefined {
  // com viradas: estende o ritmo sem elas e depois as recoloca nos lugares certos do novo tamanho
  if (kind === 'drums' && r.fills && r.notes) {
    const plain = extendPattern({ ...r, fills: 0, notes: withFills(r, 0, r.notes) }, length, kind);
    return withFills({ ...r, length }, r.fills, plain);
  }
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

// ---------- Viradas automáticas ----------

/** De quantos em quantos compassos a virada entra numa região nova de estilo. */
export const DEFAULT_FILLS = 4;
export const FILL_CHOICES = [0, 2, 4, 8];

/**
 * Virada: ocupa o compasso a partir de `from` tempos até o fim dele (o ritmo nesse trecho dá lugar a
 * ela). Cada string cobre o compasso inteiro (16 = semicolcheias, 32 = fusas): x = forte, o = fraco.
 * 'S' é a caixa do estilo (palmas, se o estilo não tem caixa). A primeira nota cai sempre em `from`.
 */
interface Fill {
  from: number;
  big: boolean;
  pat: Record<string, string>;
}

const ACOUSTIC_FILLS: Fill[] = [
  { from: 3, big: false, pat: { S: '............xxxx', 36: '............x...' } },
  { from: 3, big: false, pat: { S: '............xoxx', 36: '.............x..' } },
  { from: 2, big: false, pat: { S: '........xx......', 50: '..........xx....', 48: '............xx..', 45: '..............xx', 36: '........x...x...' } },
  { from: 2, big: false, pat: { S: '........x..x..x.', 50: '.........x..x...', 45: '..........x..x.x', 36: '........x.......' } },
  { from: 0, big: true, pat: { S: 'x.x.xxx.........', 50: '........xx......', 48: '..........xx....', 45: '............x.xx', 36: 'x...x...x...x...' } },
  { from: 0, big: true, pat: { S: 'x.xxx.xx........', 50: '........x.x.....', 48: '.........x.x....', 45: '............xxxx', 36: 'x.......x...x...' } },
  { from: 2, big: true, pat: { S: '........xxxx....', 50: '............x...', 48: '.............x..', 45: '..............xx', 36: '........x.......' } },
];

const ELECTRO_FILLS: Fill[] = [
  { from: 2, big: false, pat: { S: '........x.x.xxxx' } },
  { from: 3, big: false, pat: { 42: '........................xxxxxxxx', S: '..............x.' } },
  { from: 2, big: false, pat: { 42: '................xxxx....xxxxxxxx', S: '............x...', 36: '........x.......' } },
  { from: 0, big: true, pat: { S: 'x...x...x.x.xxxx', 36: 'x.......x.......' } },
  { from: 0, big: true, pat: { S: 'x.x.x.x.xxxxxxxx', 36: 'x...............' } },
];

const B = BEATS_PER_BAR;
const isCrash = (n: Note) => n.pitch === 49 && n.start % B === 0;

/**
 * Tira as viradas: apaga as notas geradas e devolve o ritmo aos trechos que elas ocupavam. Região de
 * estilo: copia do padrão original do estilo; outras: do mesmo trecho no compasso anterior.
 */
function stripFills(notes: Note[], loop?: Loop): Note[] {
  const zones = new Map<number, number>(); // compasso → início (tempos) do trecho que a virada ocupou
  for (const n of notes) {
    if (!n.fill || isCrash(n)) continue;
    const bar = Math.floor(n.start / B);
    zones.set(bar, Math.min(zones.get(bar) ?? Infinity, Math.floor(n.start)));
  }
  let out = notes.filter((n) => !n.fill);
  for (const bar of [...zones.keys()].sort((a, b) => a - b)) {
    const from = zones.get(bar)!;
    const end = (bar + 1) * B;
    // compasso de origem: o equivalente no padrão do estilo, ou o anterior na própria região
    const src = loop ? bar % loop.bars : bar - 1;
    if (src < 0) continue;
    const shift = (bar - src) * B;
    const pool: N[] = loop ? loop.notes : out;
    const copy = pool.filter((n) => n.start >= from - shift && n.start < end - shift);
    out = out.concat(copy.map((n) => ({ ...n, id: uid(), start: n.start + shift })));
  }
  return out;
}

function addFills(notes: Note[], length: number, every: number, pool: Fill[], snare: number, seed: number): Note[] {
  const bars = Math.floor(length / B + 1e-6);
  let out = notes;
  let count = 0;
  for (let bar = every - 1; bar < bars; bar += every, count++) {
    // a última virada da região e (com viradas espaçadas) uma sim, outra não são as maiores
    const big = bar + every >= bars || (every >= 4 && count % 2 === 1);
    const options = pool.filter((f) => f.big === big);
    const f = options[(seed + count * 3 + bar) % options.length];
    const start = bar * B;
    const from = start + f.from;
    const end = start + B;
    out = out.filter((n) => n.start < from || n.start >= end);
    for (const [k, p] of Object.entries(f.pat)) {
      const pitch = k === 'S' ? snare : +k;
      const step = B / p.length;
      for (let i = 0; i < p.length; i++) {
        if (p[i] === '.') continue;
        const t = i * step;
        // crescendo: a virada vai ficando mais forte até cair no prato
        const velocity = p[i] === 'x' ? Math.min(127, Math.round(78 + (44 * t) / B)) : 58;
        out.push({ id: uid(), pitch, start: start + t, duration: Math.min(0.25, step), velocity, fill: true });
      }
    }
    if (end < length - 1e-6 && !out.some((n) => n.pitch === 49 && Math.abs(n.start - end) < 1e-6)) {
      out.push({ id: uid(), pitch: 49, start: end, duration: 1, velocity: 112, fill: true });
    }
  }
  return out;
}

/**
 * Notas da região com viradas a cada `every` compassos (0/ausente = tira as viradas). As viradas
 * anteriores são sempre desfeitas antes, então dá para trocar a frequência quantas vezes quiser.
 * O tipo de virada segue o estilo: tons e caixa no rock/funk/reggae, rufos e chimbal no eletrônico.
 */
export function withFills(r: Pick<Region, 'name' | 'length'>, every: number | undefined, notes: Note[] = []): Note[] {
  const loop = LOOPS.find((l) => l.kind === 'drums' && l.name === r.name);
  const base = stripFills(notes, loop);
  if (!every || every < 1) return base;
  const electro = !!loop && DRUM_STYLES.some((g) => g.group.startsWith('Hip-hop') && g.ids.includes(loop.id));
  const has = (p: number) => base.some((n) => n.pitch === p);
  const snare = !has(38) && has(39) ? 39 : 38;
  const seed = [...r.name].reduce((a, c) => a + c.charCodeAt(0), 0);
  return addFills(base, r.length, every, electro ? ELECTRO_FILLS : ACOUSTIC_FILLS, snare, seed);
}

/**
 * Liga/desliga as viradas: na região selecionada da trilha ou, sem seleção, em todas as regiões de
 * bateria dela.
 */
export function setTrackFills(trackId: string, every: number) {
  const s = useStore.getState();
  const regions = s.project.regions.filter((r) => r.trackId === trackId && r.notes);
  const sel = regions.find((r) => r.id === s.selectedRegionId);
  const targets = sel ? [sel] : regions;
  if (!targets.length) return;
  s.snapshot();
  for (const r of targets) s.updateRegion(r.id, { fills: every || undefined, notes: withFills(r, every, r.notes) }, false);
}
