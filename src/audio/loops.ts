// Biblioteca de loops: padrões MIDI originais que tocam nos instrumentos do próprio app.
import { useStore } from '../store';
import { BEATS_PER_BAR, Note, Region, uid } from '../types';
import { Harmony, inferHarmony } from './chords';

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

/**
 * Linha de baixo: o mesmo desenho (`pat`: [início no compasso, intervalo em semitons sobre a fundamental,
 * duração]) em cada compasso, sobre a fundamental do acorde daquele compasso (`roots`).
 */
const line = (roots: number[], pat: [number, number, number][]): [number, number, number][] =>
  roots.flatMap((r, i) => pat.map(([st, iv, d]) => [i * 4 + st, r + iv, d] as [number, number, number]));
/** Tercina: posição do passo `k` (0, 1, 2) dentro do tempo `beat`. */
const trip = (beat: number, k: number) => beat + k / 3;

/**
 * Acordes com ritmo: um acorde por compasso (`prog`), tocado nos pontos de `pat` ([início no compasso,
 * duração]) — o "jeito de tocar" de cada estilo (skank do reggae, clave da bossa, charleston do jazz…).
 */
const comp = (prog: number[][], pat: [number, number][]): [number, number, number][] =>
  prog.flatMap((ch, i) => pat.flatMap(([st, d]) => ch.map((p) => [i * 4 + st, p, d] as [number, number, number])));
/** Arpejo em colcheias (balada): fundamental, quinta, oitava, terça… de cada acorde. */
const ballad = (prog: number[][]): [number, number, number][] =>
  prog.flatMap((ch, i) => [ch[0] - 12, ch[2] - 12, ch[0], ch[1], ch[2], ch[1], ch[0], ch[2] - 12].map(
    (p, k) => [i * 4 + k / 2, p, k === 0 ? 3.9 : Math.min(0.9, 3.95 - k / 2)] as [number, number, number]));

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
    37: '........x.......',
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
    70: 'xoooxoooxoooxooo',
    67: 'x.x..x.x..x.x...',
    68: '...x......x...x.',
  }),
  drums('d-bossa', 'Bossa Nova', 2, {
    36: 'x..xx..xx..xx..x',
    37: 'o..o..o...o..o....o..o..o..o....',
    42: 'x.o.x.o.x.o.x.o.',
    70: 'x.o.x.o.x.o.x.o.',
  }),
  drums('d-baiao', 'Baião', 2, {
    36: 'x..x....x..x....',
    38: '....o.......x...',
    80: 'xx.xxx.xxx.xxx.x',
    81: '..x...x...x...x.',
  }),
  drums('d-xote', 'Xote', 2, {
    36: 'x.....x.x.....x.',
    38: '....x.......x..o',
    80: 'x.x.x.x.x.x.x.x.',
    81: '.x...x...x...x..',
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
    51: 'x..x.xx..x.x',
    36: 'o..o..o..o..',
    38: '.....o.....o.......o..o.',
    44: '...x.....x..',
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
  // Mais brasileiros (tons = surdos/alfaias/atabaques, cowbell = agogô/gonguê, chimbal = pandeiro/ganzá)
  drums('d-funk-carioca', 'Funk Carioca (Tamborzão)', 2, {
    36: 'x..x..x.x.....x.',
    39: '....x.......x...',
    63: '..x...x...x.x...',
    64: '.............x.x',
    42: 'x.x.x.x.x.x.x.x.',
  }),
  drums('d-axe', 'Axé / Samba-reggae', 2, {
    36: 'x.......x.......',
    45: '....x.......x.xx',
    48: '..x...x...x...x.',
    38: 'x.ox.oxox.ox.ox.',
  }),
  drums('d-pagode', 'Pagode', 2, {
    36: 'x......xx......x',
    45: '....x.......x...',
    54: 'xooxxooxxooxxoox',
    62: '..o..o....o..o..',
  }),
  drums('d-sertanejo', 'Sertanejo', 2, {
    36: 'x.....x.x.....x.',
    38: '....x.......x...',
    42: 'x.xxx.xxx.xxx.xx',
    49: 'x...............................',
  }),
  drums('d-maracatu', 'Maracatu', 2, {
    36: 'x.......x..x....',
    45: '..x.x..x..x.x..x',
    38: 'xoxoxooxxoxoxoox',
    56: 'x.x..x.x..x.x...',
    70: 'x.x.x.x.x.x.x.x.',
  }),
  drums('d-frevo', 'Frevo', 2, {
    36: 'x...x...x...x...',
    38: 'x.oxx.o.x.oxx.o.',
    45: '..............xx',
    49: 'x...............................',
  }),
  drums('d-ijexa', 'Ijexá', 2, {
    36: 'x.....x.x.....x.',
    64: '...x.......x....',
    67: 'x.x.x...x.x.x...',
    70: 'o.o.o.o.o.o.o.o.',
    68: '......x.......x.',
  }),
  // Latinos (palmas = clave, tons = congas/bongôs, cowbell = campana)
  drums('d-salsa', 'Salsa', 2, {
    75: 'x..x..x.............x...x.......',
    56: 'x...x...x...x...',
    62: '....x.......x...',
    63: '............x.x.',
    36: '......x.....x...',
  }),
  drums('d-cumbia', 'Cumbia', 2, {
    36: 'x.......x.......',
    73: 'x.xxx.xxx.xxx.xx',
    63: '..x...x...x...x.',
    38: '....o.......o...',
  }),
  drums('d-bachata', 'Bachata', 2, {
    36: 'x.......x.......',
    73: 'x.xxx.xxx.xxx.xx',
    60: 'x.o.x.o.x.o.x.oo',
    61: '..............x.',
  }),
  drums('d-bolero', 'Bolero', 2, {
    36: 'x.......x.......',
    60: 'x..x.x..x..x.x..',
    61: '......x.......x.',
    70: 'o.o.o.o.o.o.o.o.',
  }),
  // Punk e indie
  drums('d-punk', 'Punk', 2, {
    36: 'x.x.x.x.x.x.x.x.',
    38: '....x.......x...',
    46: 'x.x.x.x.x.x.x.x.',
    49: 'x...............................',
  }),
  drums('d-poppunk', 'Pop Punk', 2, {
    36: 'x.x...x.x.x...x.',
    38: '....x.......x...',
    46: 'x...x...x...x...',
    49: 'x...............................',
  }),
  drums('d-motorik', 'Motorik (Krautrock)', 2, {
    36: 'x...x.x.x...x.x.',
    38: '....x.......x...',
    42: 'x.x.x.x.x.x.x.x.',
  }),
  drums('d-ska', 'Ska', 2, {
    36: 'x.......x.......',
    38: '....x.......x...',
    46: '..x...x...x...x.',
    42: 'x...x...x...x...',
  }),
  drums('d-country', 'Country (Train Beat)', 2, {
    36: 'x.......x.......',
    38: 'ooooxoooooooxooo',
  }),
  // Africanos
  drums('d-afrobeat', 'Afrobeat (anos 70)', 2, {
    36: 'x.....x...x.....x..x..x...x.....',
    38: '....x..o.o..x..o',
    42: 'xoxoxoxoxoxoxo.o',
    46: '..............x.',
    56: 'x.x.xx.x.x.xx.x.',
    70: 'x.x.x.x.x.x.x.x.',
  }),
  drums('d-afrobeats', 'Afrobeats', 2, {
    36: 'x.....x.x.......',
    39: '....x.......x...',
    62: '..x..x.x..x..x.x',
    42: 'x.xxx.x.x.xxx.x.',
    70: 'xoxoxoxoxoxoxoxo',
  }),
  drums('d-amapiano', 'Amapiano', 2, {
    36: 'x...x...x...x...',
    39: '....x.......x...',
    42: 'xoxoxoxoxoxoxoxo',
    76: '...o..o.....o..o',
    62: '..........x.....',
  }),
  // Mais eletrônicos
  drums('d-ukg', 'UK Garage 2-Step', 2, {
    36: 'x.........x.....x.......x.x.....',
    38: '....x.......x...',
    42: '..x...x...x...xo',
    46: '......x.........',
  }),
  drums('d-dubstep', 'Dubstep (meio tempo)', 2, {
    36: 'x.........x.....x.....x...x.....',
    38: '........x...............x.......',
    42: 'x.x.x.x.x.x.x.x.',
  }),
  drums('d-jersey', 'Jersey Club', 2, {
    36: 'x...x...x..x..x.',
    39: '....x.......x...',
    42: 'x.x.x.x.x.x.x.x.',
  }),
  drums('d-synthwave', 'Synthwave', 2, {
    36: 'x.......x.x.....',
    38: '....x.......x...',
    42: 'xoxoxoxoxoxoxoxo',
    49: 'x...............................',
  }),
  drums('d-toms', 'Virada de Tons', 1, { 36: 'x...x...x...x...', 50: 'xx.x............', 48: '....xx.x........', 45: '........xx.xx.x.', 49: '...............x' }),

  mel('b-pop', 'Baixo Pop', 'Baixo', 'ebass', 4, eighths([36, 31, 33, 29])),
  mel('b-minor', 'Baixo Menor', 'Baixo', 'ebass', 4, eighths([33, 29, 36, 31])),
  mel('b-groove', 'Baixo Groove', 'Baixo', 'ebass', 2,
    [[0, 36, 0.5], [0.75, 36, 0.25], [1.5, 48, 0.25], [2, 36, 0.5], [2.75, 39, 0.25], [3, 41, 0.5], [3.5, 43, 0.5]], 4),

  // Baixos por estilo (combinam com os estilos de bateria de mesmo nome)
  mel('b-rock', 'Baixo Rock', 'Baixo', 'ebass', 4, line([33, 33, 38, 40], [
    [0, 0, 0.42], [0.5, 0, 0.42], [1, 0, 0.42], [1.5, 0, 0.42], [2, 0, 0.42], [2.5, 0, 0.42], [3, 0, 0.42], [3.5, 7, 0.42],
  ])),
  mel('b-funk', 'Baixo Funk', 'Baixo', 'ebass', 2, line([28, 28], [
    [0, 0, 0.22], [0.75, 0, 0.18], [1, 12, 0.12], [1.5, 10, 0.2], [1.75, 12, 0.12], [2.5, 0, 0.22], [2.75, 3, 0.18], [3, 5, 0.2], [3.25, 7, 0.12], [3.5, 10, 0.22],
  ])),
  mel('b-reggae', 'Baixo Reggae', 'Baixo', 'ebass', 4, line([33, 33, 38, 38], [
    [1, 0, 0.7], [2, 7, 0.45], [2.5, 5, 0.22], [2.75, 3, 0.45], [3.5, 0, 0.45],
  ])),
  mel('b-samba', 'Baixo Samba', 'Baixo', 'ebass', 4, line([36, 33, 38, 31], [
    [0, 0, 0.45], [0.75, 0, 0.22], [1, -5, 0.45], [1.75, -5, 0.22], [2, 0, 0.45], [2.75, 0, 0.22], [3, -5, 0.45], [3.75, -5, 0.22],
  ])),
  mel('b-bossa', 'Baixo Bossa Nova', 'Baixo', 'dbass', 4, line([36, 38, 31, 36], [
    [0, 0, 1.3], [1.5, -5, 0.45], [2, -5, 1.3], [3.5, 0, 0.45],
  ])),
  mel('b-baiao', 'Baixo Baião', 'Baixo', 'ebass', 4, line([31, 31, 29, 31], [
    [0, 0, 0.7], [0.75, 7, 0.6], [1.5, 10, 0.4], [2, 0, 0.7], [2.75, 7, 0.6], [3.5, 10, 0.4],
  ])),
  // walking bass num ii-V-I-VI em Dó: cada compasso termina numa nota cromática que leva ao próximo acorde
  mel('b-walking', 'Baixo Walking (Jazz)', 'Baixo', 'dbass', 4, [
    [0, 38, 0.9], [1, 41, 0.9], [2, 45, 0.9], [3, 42, 0.9],
    [4, 43, 0.9], [5, 41, 0.9], [6, 38, 0.9], [7, 35, 0.9],
    [8, 36, 0.9], [9, 40, 0.9], [10, 43, 0.9], [11, 44, 0.9],
    [12, 45, 0.9], [13, 43, 0.9], [14, 40, 0.9], [15, 37, 0.9],
  ]),
  // boogie de blues em tercina (fundamental, terça, quinta e sexta), A A D A
  mel('b-blues', 'Baixo Blues Shuffle', 'Baixo', 'ebass', 4, line([33, 33, 38, 33], [
    [trip(0, 0), 0, 0.6], [trip(0, 2), 0, 0.3], [trip(1, 0), 4, 0.6], [trip(1, 2), 4, 0.3],
    [trip(2, 0), 7, 0.6], [trip(2, 2), 7, 0.3], [trip(3, 0), 9, 0.6], [trip(3, 2), 7, 0.3],
  ])),
  mel('b-disco', 'Baixo Disco', 'Baixo', 'ebass', 4, line([33, 38, 31, 36],
    Array.from({ length: 8 }, (_, k) => [k / 2, k % 2 ? 12 : 0, 0.35] as [number, number, number]))),
  mel('b-motown', 'Baixo Motown', 'Baixo', 'ebass', 4, line([36, 33, 29, 31], [
    [0, 0, 0.45], [0.5, 0, 0.22], [1, 4, 0.45], [1.5, 7, 0.45], [2, 9, 0.45], [2.5, 7, 0.22], [3, 4, 0.45], [3.5, 2, 0.45],
  ])),
  mel('b-metal', 'Baixo Metal Galope', 'Baixo', 'ebass', 4, line([28, 28, 31, 30], [
    [0, 0, 0.4], [0.5, 0, 0.2], [0.75, 0, 0.2], [1, 0, 0.4], [1.5, 0, 0.2], [1.75, 0, 0.2],
    [2, 0, 0.4], [2.5, 0, 0.2], [2.75, 0, 0.2], [3, 0, 0.4], [3.5, 0, 0.2], [3.75, 0, 0.2],
  ])),
  mel('b-house', 'Baixo House', 'Baixo', 'bass', 4, line([33, 33, 29, 31], [
    [0.5, 0, 0.3], [1.5, 0, 0.3], [2.5, 0, 0.3], [3.5, 12, 0.3],
  ])),
  mel('b-trap', '808 Trap', 'Baixo', 'bass', 4, line([33, 33, 29, 31], [
    [0, 0, 1.6], [1.75, 0, 0.6], [2.5, 12, 1.4],
  ])),
  mel('b-dnb', 'Baixo Drum and Bass', 'Baixo', 'bass', 4, line([33, 33, 29, 31], [
    [0, 0, 1.4], [1.5, 0, 0.4], [2, 3, 1.4], [3.5, -2, 0.45],
  ])),
  mel('b-dembow', 'Baixo Reggaeton', 'Baixo', 'bass', 4, line([33, 29, 36, 31], [
    [0, 0, 0.6], [0.75, 0, 0.6], [1.5, 0, 0.4], [2, 0, 0.6], [2.75, 0, 0.6], [3.5, 0, 0.4],
  ])),
  // Mais baixos por estilo (combinam com os estilos de bateria novos de mesmo nome)
  mel('b-funk-carioca', 'Baixo Funk Carioca', 'Baixo', 'bass', 4, line([33, 33, 31, 29], [
    [0, 0, 0.5], [0.75, 0, 0.4], [1.5, 0, 0.4], [2, 0, 0.5], [3, 7, 0.3], [3.5, 12, 0.3],
  ])),
  mel('b-axe', 'Baixo Axé', 'Baixo', 'ebass', 4, line([36, 29, 31, 36], [
    [0, 0, 0.45], [0.75, 7, 0.2], [1, 12, 0.45], [2, 0, 0.45], [2.5, 7, 0.45], [3, 12, 0.3], [3.5, 7, 0.4],
  ])),
  mel('b-pagode', 'Baixo Pagode', 'Baixo', 'ebass', 4, line([36, 33, 38, 31], [
    [0, 0, 0.45], [0.75, 0, 0.22], [1, 7, 0.45], [1.75, 7, 0.22], [2, 0, 0.45], [2.5, 4, 0.22], [2.75, 5, 0.22], [3, 7, 0.45], [3.5, 9, 0.45],
  ])),
  mel('b-sertanejo', 'Baixo Sertanejo', 'Baixo', 'ebass', 4, line([31, 38, 40, 36], [
    [0, 0, 0.7], [1, 7, 0.45], [1.5, 0, 0.45], [2, 0, 0.7], [3, 7, 0.45], [3.5, 0, 0.45],
  ])),
  // Maracatu: ré eólio, pesado como as alfaias
  mel('b-maracatu', 'Baixo Maracatu', 'Baixo', 'ebass', 4, line([38, 38, 36, 34], [
    [0, 0, 0.7], [1.5, 0, 0.4], [2, 7, 0.45], [2.75, 0, 0.6], [3.5, 10, 0.4],
  ])),
  mel('b-frevo', 'Baixo Frevo', 'Baixo', 'ebass', 4, line([31, 36, 38, 31], [
    [0, 0, 0.4], [0.5, 7, 0.4], [1, 12, 0.4], [1.5, 7, 0.4], [2, 0, 0.4], [2.5, 4, 0.4], [3, 7, 0.4], [3.5, 4, 0.4],
  ])),
  mel('b-ijexa', 'Baixo Ijexá', 'Baixo', 'ebass', 4, line([33, 38, 33, 40], [
    [0, 0, 0.6], [0.75, 7, 0.6], [1.5, 10, 0.4], [2, 12, 0.4], [2.75, 7, 0.6], [3.5, 3, 0.4],
  ])),
  // Salsa: tumbao (no "e" do 2 a fundamental do acorde; no 4 já antecipa a do próximo, ligada até o "e" do 2)
  mel('b-salsa', 'Baixo Salsa (Tumbao)', 'Baixo', 'dbass', 4, [33, 38, 31, 36].flatMap((r, i, a) => [
    [i * 4 + 1.5, r, 1.4], [i * 4 + 3, a[(i + 1) % a.length], 1.0],
  ] as [number, number, number][])),
  mel('b-cumbia', 'Baixo Cumbia', 'Baixo', 'ebass', 4, line([33, 38, 40, 33], [
    [0, 0, 0.9], [1, 7, 0.45], [2, -5, 0.9], [3, 7, 0.45],
  ])),
  mel('b-bachata', 'Baixo Bachata', 'Baixo', 'ebass', 4, line([33, 38, 40, 33], [
    [0, 0, 0.4], [0.5, 7, 0.4], [1, 12, 0.4], [2, 0, 0.4], [2.5, 7, 0.4], [3, 12, 0.3], [3.5, 10, 0.3],
  ])),
  mel('b-bolero', 'Baixo Bolero', 'Baixo', 'dbass', 4, line([36, 33, 38, 31], [
    [0, 0, 1.4], [1.5, 7, 0.45], [2, 7, 1.4], [3.5, 0, 0.45],
  ])),
  mel('b-punk', 'Baixo Punk', 'Baixo', 'ebass', 4, line([28, 28, 33, 35],
    Array.from({ length: 8 }, (_, k) => [k / 2, 0, 0.42] as [number, number, number]))),
  mel('b-poppunk', 'Baixo Pop Punk', 'Baixo', 'ebass', 4, line([38, 33, 35, 31],
    Array.from({ length: 8 }, (_, k) => [k / 2, k === 7 ? 12 : 0, 0.42] as [number, number, number]))),
  mel('b-motorik', 'Baixo Motorik', 'Baixo', 'ebass', 4, line([33, 33, 33, 31], [
    [0, 0, 0.4], [0.5, 0, 0.4], [1, 0, 0.4], [1.5, 12, 0.3], [2, 0, 0.4], [2.5, 0, 0.4], [3, 7, 0.4], [3.5, 0, 0.4],
  ])),
  // Ska: walking em semínimas subindo pelo acorde
  mel('b-ska', 'Baixo Ska', 'Baixo', 'ebass', 4, line([36, 33, 29, 31], [
    [0, 0, 0.9], [1, 4, 0.9], [2, 7, 0.9], [3, 9, 0.9],
  ])),
  // Country: fundamental no 1, quinta no 3
  mel('b-country', 'Baixo Country', 'Baixo', 'dbass', 4, line([31, 36, 38, 31], [
    [0, 0, 1.4], [2, 7, 1.4],
  ])),
  // Afrobeat: riff de ré dórico repetido (o baixo do Fela não muda de acorde)
  mel('b-afrobeat', 'Baixo Afrobeat', 'Baixo', 'ebass', 2, [
    [0, 38, 0.4], [0.75, 38, 0.2], [1, 41, 0.4], [1.5, 43, 0.4], [2.5, 45, 0.2], [2.75, 43, 0.4], [3.5, 41, 0.4],
    [4, 38, 0.4], [4.75, 38, 0.2], [5, 41, 0.4], [5.5, 43, 0.4], [6, 47, 0.4], [6.5, 45, 0.4], [7, 43, 0.4], [7.5, 40, 0.4],
  ]),
  mel('b-afrobeats', 'Baixo Afrobeats', 'Baixo', 'bass', 4, line([33, 29, 36, 31], [
    [0, 0, 0.6], [0.75, 0, 0.4], [1.5, 0, 0.4], [2.5, 7, 0.5], [3.5, 5, 0.4],
  ])),
  // Amapiano: o "log drum" (notas curtas e sincopadas, pulando oitava)
  mel('b-amapiano', 'Log Drum Amapiano', 'Baixo', 'bass', 4, line([33, 33, 29, 31], [
    [0, 0, 0.3], [0.75, 0, 0.3], [1.5, 7, 0.3], [2.25, 12, 0.3], [2.75, 10, 0.3], [3.5, 7, 0.3],
  ])),
  mel('b-ukg', 'Baixo UK Garage', 'Baixo', 'bass', 4, line([33, 36, 29, 31], [
    [0, 0, 0.5], [0.75, 0, 0.25], [1.5, 12, 0.3], [2.5, 0, 0.4], [3, 10, 0.3], [3.5, 7, 0.4],
  ])),
  mel('b-dubstep', 'Baixo Dubstep', 'Baixo', 'bass', 4, line([28, 28, 31, 26], [
    [0, 0, 1.9], [2.5, 0, 0.4], [3, 3, 0.4], [3.5, -2, 0.45],
  ])),
  mel('b-jersey', 'Baixo Jersey Club', 'Baixo', 'bass', 4, line([33, 33, 29, 31], [
    [0, 0, 0.3], [1, 0, 0.3], [2, 0, 0.3], [2.75, 0, 0.3], [3.5, 12, 0.3],
  ])),
  mel('b-synthwave', 'Baixo Synthwave', 'Baixo', 'bass', 4, line([33, 29, 36, 31],
    Array.from({ length: 8 }, (_, k) => [k / 2, k === 7 ? 7 : 0, 0.4] as [number, number, number]))),
  // Para completar os estilos (todo estilo tem bateria, baixo, acordes e melodia)
  mel('b-ballad', 'Baixo Balada', 'Baixo', 'ebass', 4, line([36, 31, 33, 29], [[0, 0, 1.9], [2, 7, 0.9], [3, 0, 0.9]]), 16, 85),
  mel('b-lofi', 'Contrabaixo Lo-fi', 'Baixo', 'dbass', 4, line([41, 40, 38, 36], [[0, 0, 1.4], [1.5, 7, 0.4], [2.5, 0, 1.4]]), 16, 85),
  // Techno: baixo "rolante" em semicolcheias entre os bumbos, num pedal de Lá
  mel('b-techno', 'Baixo Techno', 'Baixo', 'bass', 1, [0, 1, 2, 3].flatMap((b) => [[b + 0.25, 33, 0.18], [b + 0.5, 33, 0.18], [b + 0.75, 45, 0.15]] as [number, number, number][]), 4, 90),

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
  // Acordes por estilo (mesmos tons e progressões dos baixos de mesmo nome: dá para usar juntos)
  mel('c-rock', 'Órgão Rock', 'Acordes', 'organ', 4, comp([[57, 61, 64], [57, 61, 64], [57, 62, 66], [56, 59, 64]], [[0, 1.9], [2, 1.4], [3.5, 0.45]]), 16, 80),
  mel('c-funk', 'Clavinete Funk', 'Acordes', 'clav', 2, comp([[56, 62, 66], [56, 62, 66]], [
    [0, 0.15], [0.75, 0.12], [1.25, 0.12], [1.5, 0.2], [2.25, 0.12], [2.75, 0.12], [3, 0.15], [3.5, 0.12],
  ]), 8, 90),
  mel('c-reggae', 'Skank Reggae', 'Acordes', 'organ', 4, comp([[57, 60, 64], [57, 60, 64], [57, 62, 65], [57, 62, 65]], [[1, 0.25], [3, 0.25]]), 16, 85),
  mel('c-samba', 'Cavaco Samba', 'Acordes', 'guitar', 4, comp([[55, 60, 64], [55, 61, 64], [57, 60, 65], [55, 59, 65]], [
    [0, 0.2], [0.5, 0.2], [0.75, 0.2], [1.25, 0.2], [1.75, 0.2], [2, 0.2], [2.5, 0.2], [3, 0.2], [3.25, 0.2], [3.75, 0.2],
  ]), 16, 80),
  mel('c-bossa', 'Bossa Nova', 'Acordes', 'epiano', 4, comp([[59, 64, 67], [60, 65, 69], [59, 62, 65], [59, 64, 67]], [
    [0, 0.6], [0.75, 0.6], [1.5, 0.45], [2.5, 0.6], [3.25, 0.6],
  ]), 16, 75),
  mel('c-baiao', 'Órgão Baião', 'Acordes', 'organ', 4, comp([[59, 62, 67], [59, 62, 67], [57, 60, 65], [59, 62, 67]], [
    [0, 0.5], [0.75, 0.5], [1.5, 0.4], [2, 0.5], [2.75, 0.5], [3.5, 0.4],
  ]), 16, 80),
  // ii-V-I-VI em Dó com acordes sem a fundamental (o baixo walking faz a fundamental), no ritmo charleston
  mel('c-jazz', 'Jazz Comping', 'Acordes', 'grand', 4, comp([[53, 57, 60, 64], [53, 57, 59, 64], [52, 55, 59, 62], [55, 61, 65]], [[0, 0.6], [1.5, 0.45]]), 16, 75),
  mel('c-blues', 'Piano Blues Shuffle', 'Acordes', 'honky', 4, comp([[55, 61, 64], [55, 61, 64], [54, 60, 64], [55, 61, 64]],
    [0, 1, 2, 3].flatMap((b) => [[b, 0.55], [trip(b, 2), 0.28]] as [number, number][])), 16, 80),
  mel('c-disco', 'Cordas Disco', 'Acordes', 'strings', 4, comp([[57, 60, 64], [57, 62, 65], [55, 59, 62], [55, 60, 64]], [[0.5, 0.35], [1.5, 0.35], [2.5, 0.35], [3.5, 0.35]]), 16, 85),
  mel('c-motown', 'Piano Motown', 'Acordes', 'grand', 4, comp([[55, 60, 64], [57, 60, 64], [57, 60, 65], [55, 59, 62]], [[0, 0.4], [1, 0.4], [2, 0.4], [3, 0.4]]), 16, 85),
  mel('c-ballad', 'Piano Balada', 'Acordes', 'grand', 4, ballad(POP), 16, 75),
  mel('c-house', 'Piano House', 'Acordes', 'grand', 4, comp([[57, 60, 64, 67], [57, 60, 64, 67], [57, 60, 64, 65], [55, 59, 62, 64]], [
    [0.5, 0.25], [1.25, 0.25], [2, 0.25], [2.75, 0.25], [3.5, 0.25],
  ]), 16, 90),
  mel('c-trap', 'Sino Trap', 'Acordes', 'bell', 4, comp([[69, 72, 76], [69, 72, 76], [65, 69, 72], [67, 71, 74]], [[0, 1.9], [2, 1.9]]), 16, 70),
  mel('c-lofi', 'Piano Lo-fi', 'Acordes', 'felt', 4, comp([[53, 57, 60, 64], [52, 55, 59, 62], [50, 53, 57, 60], [48, 52, 55, 59]], [[0, 1.4], [1.5, 0.4], [2.5, 1.4]]), 16, 70),
  // Mais acordes por estilo (mesmos tons e progressões dos baixos novos de mesmo nome)
  mel('c-funk-carioca', 'Synth Funk Carioca', 'Acordes', 'pluck', 4, comp([[57, 60, 64], [57, 60, 64], [55, 59, 62], [57, 60, 65]], [
    [0, 0.2], [0.75, 0.2], [1.5, 0.2], [2.5, 0.2], [3.5, 0.2],
  ]), 16, 85),
  mel('c-axe', 'Guitarra Axé', 'Acordes', 'guitar', 4, comp([[60, 64, 67], [60, 65, 69], [59, 62, 67], [60, 64, 67]], [
    [0, 0.2], [0.5, 0.2], [0.75, 0.2], [1.5, 0.2], [2, 0.2], [2.5, 0.2], [2.75, 0.2], [3.5, 0.2],
  ]), 16, 80),
  mel('c-pagode', 'Cavaco Pagode', 'Acordes', 'guitar', 4, comp([[55, 60, 64], [55, 61, 64], [57, 60, 65], [55, 59, 65]], [
    [0, 0.2], [0.5, 0.2], [0.75, 0.2], [1.5, 0.2], [2, 0.2], [2.5, 0.2], [2.75, 0.2], [3.5, 0.2],
  ]), 16, 80),
  mel('c-sertanejo', 'Piano Sertanejo', 'Acordes', 'epiano', 4, comp([[59, 62, 67], [57, 62, 66], [59, 64, 67], [60, 64, 67]], [
    [0, 0.9], [1, 0.4], [1.5, 0.4], [2, 0.9], [3, 0.4], [3.5, 0.4],
  ]), 16, 80),
  mel('c-maracatu', 'Órgão Maracatu', 'Acordes', 'organ', 4, comp([[57, 62, 65], [57, 62, 65], [55, 60, 64], [53, 58, 62]], [
    [0, 1.4], [1.5, 0.4], [2.75, 1.2],
  ]), 16, 60),
  mel('c-frevo', 'Stabs Frevo', 'Acordes', 'trumpet', 4, comp([[59, 62, 67], [60, 64, 67], [60, 62, 66], [59, 62, 67]], [
    [0, 0.2], [0.5, 0.2], [1.5, 0.2], [2, 0.2], [2.75, 0.2], [3.5, 0.4],
  ]), 16, 115),
  mel('c-ijexa', 'Piano Ijexá', 'Acordes', 'epiano', 4, comp([[55, 60, 64], [57, 60, 65], [55, 60, 64], [55, 59, 64]], [
    [0, 0.4], [0.5, 0.4], [1, 0.2], [1.5, 0.4], [2, 0.4], [3, 0.4], [3.5, 0.4],
  ]), 16, 75),
  // Salsa: montuno (nota de cima nos tempos, o resto do acorde nos contratempos), Am7 D7 Gmaj7 C
  mel('c-salsa', 'Montuno Salsa', 'Acordes', 'grand', 4, [[57, 60, 64, 67], [57, 60, 62, 66], [55, 59, 62, 66], [55, 60, 64, 67]].flatMap((ch, i) =>
    Array.from({ length: 8 }, (_, k) => (k % 2 ? ch.slice(0, 3) : [ch[3]]).map((p) => [i * 4 + k / 2, p, 0.4] as [number, number, number])).flat()), 16, 60),
  mel('c-cumbia', 'Acordeom Cumbia', 'Acordes', 'organ', 4, comp([[57, 60, 64], [57, 62, 65], [56, 59, 64], [57, 60, 64]], [
    [0.5, 0.3], [1, 0.2], [1.5, 0.3], [2.5, 0.3], [3, 0.2], [3.5, 0.3],
  ]), 16, 80),
  // Bachata: arpejo em colcheias, como o requinto
  mel('c-bachata', 'Arpejo Bachata', 'Acordes', 'guitar', 4, [[57, 60, 64], [57, 62, 65], [56, 59, 64], [57, 60, 64]].flatMap((ch, i) =>
    [ch[0], ch[1], ch[2], ch[0] + 12, ch[2], ch[1], ch[2], ch[0] + 12].map((p, k) => [i * 4 + k / 2, p, 0.45] as [number, number, number])), 16, 80),
  mel('c-bolero', 'Piano Bolero', 'Acordes', 'grand', 4, comp([[55, 60, 64], [57, 60, 64], [57, 60, 65], [55, 59, 62, 65]], [
    [0, 0.9], [1, 0.45], [1.5, 0.45], [2, 0.9], [3, 0.9],
  ]), 16, 60),
  // Punk e pop punk: power chords (fundamental, quinta e oitava)
  mel('c-punk', 'Power Chords Punk', 'Acordes', 'guitar', 4, comp([[52, 59, 64], [52, 59, 64], [57, 64, 69], [59, 66, 71]],
    Array.from({ length: 8 }, (_, k) => [k / 2, 0.42] as [number, number])), 16, 75),
  mel('c-poppunk', 'Power Chords Pop Punk', 'Acordes', 'guitar', 4, comp([[50, 57, 62], [45, 52, 57], [47, 54, 59], [43, 50, 55]], [
    [0, 1.4], [1.5, 0.4], [2, 0.4], [2.5, 0.4], [3, 0.4], [3.5, 0.4],
  ]), 16, 75),
  mel('c-motorik', 'Órgão Motorik', 'Acordes', 'organ', 4, comp([[57, 60, 64], [57, 60, 64], [57, 60, 64], [55, 59, 62]],
    Array.from({ length: 8 }, (_, k) => [k / 2, 0.4] as [number, number])), 16, 55),
  mel('c-ska', 'Órgão Ska', 'Acordes', 'organ', 4, comp([[60, 64, 67], [60, 64, 69], [60, 65, 69], [59, 62, 67]], [
    [0.5, 0.25], [1.5, 0.25], [2.5, 0.25], [3.5, 0.25],
  ]), 16, 85),
  mel('c-country', 'Piano Country', 'Acordes', 'honky', 4, comp([[59, 62, 67], [60, 64, 67], [57, 62, 66], [59, 62, 67]], [
    [1, 0.45], [3, 0.45], [3.5, 0.3],
  ]), 16, 62),
  mel('c-afrobeat', 'Órgão Afrobeat', 'Acordes', 'organ', 2, comp([[57, 60, 62, 65], [59, 62, 65, 69]], [
    [0.5, 0.2], [1.25, 0.2], [2, 0.4], [2.75, 0.2], [3.5, 0.2],
  ]), 8, 80),
  mel('c-afrobeats', 'Piano Afrobeats', 'Acordes', 'epiano', 4, comp([[57, 60, 64], [57, 60, 65], [55, 60, 64], [55, 59, 62]], [
    [0, 0.6], [0.75, 0.6], [1.5, 0.4], [2, 0.6], [2.75, 0.6], [3.5, 0.4],
  ]), 16, 80),
  // Amapiano: piano de deep house com nonas (Am9, Am9, Fmaj9, G6)
  mel('c-amapiano', 'Piano Amapiano', 'Acordes', 'grand', 4, comp([[55, 59, 60, 64], [55, 59, 60, 64], [55, 57, 60, 64], [55, 59, 62, 64]], [
    [0, 1.4], [1.5, 0.3], [2.25, 0.3], [3, 0.9],
  ]), 16, 60),
  mel('c-ukg', 'Órgão UK Garage', 'Acordes', 'organ', 4, comp([[55, 60, 64], [55, 59, 64], [57, 60, 64], [55, 59, 62]], [
    [0, 0.2], [0.75, 0.2], [1.5, 0.4], [2.75, 0.2], [3.25, 0.4],
  ]), 16, 80),
  mel('c-dubstep', 'Pad Dubstep', 'Acordes', 'pad', 4, comp([[55, 59, 64], [55, 59, 64], [55, 59, 62], [54, 57, 62]], [[0, 3.9]]), 16, 75),
  mel('c-jersey', 'Stabs Jersey Club', 'Acordes', 'pluck', 4, comp([[57, 60, 64], [57, 60, 64], [57, 60, 65], [55, 59, 62]], [
    [0, 0.2], [0.75, 0.2], [1.5, 0.2], [2.5, 0.2], [3, 0.2],
  ]), 16, 85),
  mel('c-synthwave', 'Pad Synthwave', 'Acordes', 'pad', 4, comp([[57, 60, 64, 69], [57, 60, 65, 69], [55, 60, 64, 67], [55, 59, 62, 67]], [[0, 3.9]]), 16, 75),
  // Para completar os estilos
  // Hip-hop (boom bap): Cm9 e Fm9 sobre o pedal de Dó do baixo
  mel('c-hiphop', 'Piano Boom Bap', 'Acordes', 'felt', 4, comp([[58, 62, 63, 67], [58, 62, 63, 67], [56, 60, 63, 67], [56, 60, 63, 67]], [[0, 1.9], [2.5, 1.4]]), 16, 80),
  mel('c-dembow', 'Synth Reggaeton', 'Acordes', 'pluck', 4, comp([[57, 60, 64], [57, 60, 65], [55, 60, 64], [55, 59, 62]], [
    [0, 0.3], [0.75, 0.3], [1.5, 0.3], [2, 0.3], [2.75, 0.3], [3.5, 0.3],
  ]), 16, 85),
  // Metal: power chords em galope (E5 E5 G5 F#5)
  mel('c-metal', 'Guitarra Metal', 'Acordes', 'guitar', 4, comp([[40, 47, 52], [40, 47, 52], [43, 50, 55], [42, 49, 54]], [
    [0, 0.4], [0.5, 0.2], [0.75, 0.2], [1, 0.4], [1.5, 0.2], [1.75, 0.2], [2, 0.4], [2.5, 0.2], [2.75, 0.2], [3, 0.4], [3.5, 0.2], [3.75, 0.2],
  ]), 16, 100),
  mel('c-techno', 'Stabs Techno', 'Acordes', 'pluck', 4, comp([[57, 60, 64, 67], [57, 60, 64, 67], [57, 60, 64, 67], [57, 60, 64, 67]], [[0.5, 0.25], [1.75, 0.25], [3, 0.25]]), 16, 80),
  mel('c-dnb', 'Pad Drum and Bass', 'Acordes', 'pad', 4, comp([[57, 60, 64, 67], [57, 60, 64, 67], [55, 60, 65, 67], [55, 59, 62, 64]], [[0, 3.9]]), 16, 75),
  mel('c-pad', 'Pad Atmosférico', 'Acordes', 'pad', 4, chords(MINOR.map((c) => c.map((p) => p - 12).concat(c[2]))), 16, 80),
  mel('c-strings', 'Cordas Longas', 'Acordes', 'strings', 4, chords(POP), 16, 80),

  // Melodias por estilo (mesmos tons e progressões dos acordes e baixos de mesmo nome)
  // Rock: pentatônica de Lá menor sobre A A D E, voltando pela terça maior (Dó#) para o Lá
  mel('m-rock', 'Riff Rock', 'Melodia', 'guitar', 4, [
    [0, 69, 0.5], [0.5, 72, 0.5], [1, 76, 0.75], [1.75, 74, 0.25], [2, 69, 1], [3, 67, 0.5], [3.5, 69, 0.5],
    [4, 76, 0.5], [4.5, 74, 0.5], [5, 72, 0.5], [5.5, 74, 0.5], [6, 69, 1.5],
    [8, 74, 1], [9, 72, 0.5], [9.5, 69, 0.5], [10, 74, 1.5], [11.5, 72, 0.5],
    [12, 76, 1], [13, 74, 0.5], [13.5, 71, 0.5], [14, 68, 1], [15, 71, 0.5], [15.5, 73, 0.5],
  ]),
  // Funk: mi dórico em semicolcheias picadas
  mel('m-funk', 'Lick Funk', 'Melodia', 'tine', 2, [
    [0, 64, 0.2], [0.25, 67, 0.15], [0.75, 69, 0.2], [1.25, 67, 0.15], [1.5, 64, 0.3], [2.5, 71, 0.2], [2.75, 69, 0.2], [3, 67, 0.2], [3.5, 64, 0.3],
    [4, 76, 0.22], [4.5, 74, 0.2], [4.75, 71, 0.2], [5.25, 69, 0.2], [5.5, 67, 0.2], [6, 64, 0.5], [7, 62, 0.22], [7.25, 64, 0.5],
  ], 8),
  mel('m-reggae', 'Melodia Reggae', 'Melodia', 'reed', 4, [
    [0, 76, 1], [1, 74, 0.5], [1.5, 72, 0.5], [2, 69, 1.5], [3.5, 72, 0.5],
    [4, 74, 0.5], [4.5, 72, 0.5], [5, 69, 0.5], [5.5, 67, 0.5], [6, 69, 2],
    [8, 77, 1], [9, 76, 0.5], [9.5, 74, 0.5], [10, 74, 1.5], [11.5, 72, 0.5],
    [12, 69, 0.5], [12.5, 72, 0.5], [13, 74, 1], [14, 69, 2],
  ]),
  // Samba: frases sincopadas que contornam C, A7, Dm7 e G7
  mel('m-samba', 'Melodia Samba', 'Melodia', 'flute', 4, [
    [0, 72, 0.5], [0.5, 76, 0.25], [0.75, 79, 0.5], [1.25, 76, 0.25], [1.5, 72, 0.5], [2.25, 74, 0.25], [2.5, 76, 0.75], [3.5, 79, 0.5],
    [4, 81, 0.5], [4.5, 79, 0.25], [4.75, 76, 0.5], [5.25, 73, 0.5], [5.75, 76, 0.25], [6, 79, 1], [7, 76, 0.5], [7.5, 73, 0.5],
    [8, 74, 0.5], [8.5, 77, 0.25], [8.75, 81, 0.5], [9.25, 77, 0.25], [9.5, 74, 0.5], [10.25, 76, 0.25], [10.5, 77, 0.75], [11.5, 81, 0.5],
    [12, 79, 0.5], [12.5, 77, 0.25], [12.75, 74, 0.5], [13.25, 71, 0.5], [13.75, 74, 0.25], [14, 77, 1], [15, 74, 0.5], [15.5, 71, 0.5],
  ]),
  mel('m-bossa', 'Melodia Bossa Nova', 'Melodia', 'flute', 4, [
    [0, 79, 1.5], [1.5, 76, 0.5], [2, 74, 1], [3, 76, 1],
    [4, 77, 1.5], [5.5, 76, 0.5], [6, 74, 1], [7, 72, 1],
    [8, 71, 1.5], [9.5, 74, 0.5], [10, 77, 1], [11, 76, 0.5], [11.5, 74, 0.5],
    [12, 76, 3.5],
  ], 16, 85),
  // Baião: sol mixolídio (o Fá natural é a "cara" do nordeste)
  mel('m-baiao', 'Melodia Baião', 'Melodia', 'flute', 4, [
    [0, 67, 0.5], [0.5, 71, 0.5], [1, 74, 0.5], [1.5, 77, 0.5], [2, 76, 0.5], [2.5, 74, 0.5], [3, 71, 0.5], [3.5, 74, 0.5],
    [4, 79, 0.75], [4.75, 77, 0.25], [5, 76, 0.5], [5.5, 74, 0.5], [6, 71, 1], [7, 67, 1],
    [8, 72, 0.5], [8.5, 77, 0.5], [9, 81, 0.5], [9.5, 79, 0.5], [10, 77, 0.5], [10.5, 76, 0.5], [11, 74, 0.5], [11.5, 72, 0.5],
    [12, 71, 0.5], [12.5, 74, 0.5], [13, 67, 1], [14, 67, 2],
  ]),
  // Jazz: linha bebop no ii-V-I-VI, com aproximações cromáticas para o próximo acorde
  mel('m-jazz', 'Linha Jazz', 'Melodia', 'grand', 4, [
    [0, 74, 0.5], [0.5, 77, 0.5], [1, 81, 0.5], [1.5, 84, 0.5], [2, 83, 0.5], [2.5, 81, 0.5], [3, 77, 0.5], [3.5, 76, 0.5],
    [4, 77, 0.5], [4.5, 74, 0.5], [5, 71, 0.5], [5.5, 67, 0.5], [6, 65, 0.5], [6.5, 67, 0.5], [7, 71, 0.5], [7.5, 74, 0.5],
    [8, 76, 1.5], [9.5, 79, 0.5], [10, 83, 1], [11, 79, 1],
    [12, 81, 0.5], [12.5, 79, 0.5], [13, 76, 0.5], [13.5, 73, 0.5], [14, 70, 0.5], [14.5, 73, 0.5], [15, 76, 0.5], [15.5, 75, 0.5],
  ], 16, 85),
  // Blues: escala blues de Lá em tercinas (shuffle)
  mel('m-blues', 'Frase Blues', 'Melodia', 'organ', 4, [
    [0, 81, 0.6], [trip(0, 2), 79, 0.3], [1, 76, 0.6], [trip(1, 2), 75, 0.3], [2, 74, 0.6], [trip(2, 2), 72, 0.3], [3, 69, 1],
    [4, 69, 0.6], [trip(4, 2), 72, 0.3], [5, 74, 0.6], [trip(5, 2), 75, 0.3], [6, 76, 2],
    [8, 81, 1], [9, 79, 0.6], [trip(9, 2), 74, 0.3], [10, 72, 0.6], [trip(10, 2), 69, 0.3], [11, 72, 1],
    [12, 69, 0.6], [trip(12, 2), 72, 0.3], [13, 75, 0.3], [trip(13, 1), 76, 0.6], [14, 69, 2],
  ]),
  mel('m-disco', 'Melodia Disco', 'Melodia', 'sax', 4, [
    [0, 81, 0.5], [0.75, 79, 0.25], [1, 76, 0.5], [1.5, 72, 0.5], [2, 76, 0.5], [2.75, 79, 0.25], [3, 81, 1],
    [4, 77, 0.5], [4.75, 76, 0.25], [5, 74, 0.5], [5.5, 72, 0.5], [6, 74, 0.5], [6.75, 77, 0.25], [7, 81, 1],
    [8, 79, 0.5], [8.75, 77, 0.25], [9, 74, 0.5], [9.5, 71, 0.5], [10, 74, 0.5], [10.75, 77, 0.25], [11, 79, 1],
    [12, 76, 0.5], [12.75, 74, 0.25], [13, 72, 0.5], [13.5, 67, 0.5], [14, 72, 2],
  ]),
  mel('m-motown', 'Melodia Motown', 'Melodia', 'tine', 4, [
    [0, 67, 0.5], [0.5, 72, 0.5], [1, 76, 1], [2, 74, 0.5], [2.5, 72, 0.5], [3, 76, 1],
    [4, 76, 0.5], [4.5, 72, 0.5], [5, 69, 1], [6, 72, 0.5], [6.5, 76, 0.5], [7, 74, 1],
    [8, 72, 0.5], [8.5, 77, 0.5], [9, 81, 1], [10, 79, 0.5], [10.5, 77, 0.5], [11, 72, 1],
    [12, 74, 1], [13, 71, 0.5], [13.5, 74, 0.5], [14, 79, 2],
  ]),
  mel('m-ballad', 'Melodia Balada', 'Melodia', 'grand', 4, [
    [0, 79, 1.5], [1.5, 76, 0.5], [2, 74, 1], [3, 72, 1],
    [4, 74, 1.5], [5.5, 71, 0.5], [6, 74, 2],
    [8, 76, 1.5], [9.5, 72, 0.5], [10, 76, 0.5], [10.5, 77, 0.5], [11, 79, 1],
    [12, 81, 1], [13, 79, 0.5], [13.5, 77, 0.5], [14, 72, 2],
  ], 16, 80),
  // House: gancho de um compasso (Mi, Sol, Dó cabem em Am7, Fmaj7 e G6)
  mel('m-house', 'Gancho House', 'Melodia', 'lead', 1, [
    [0.5, 76, 0.25], [0.75, 79, 0.25], [1.5, 76, 0.25], [2, 72, 0.5], [2.75, 76, 0.25], [3.5, 79, 0.45],
  ], 4, 90),
  // Trap: lá menor harmônico (o Sol# dá o clima sombrio)
  mel('m-trap', 'Melodia Trap', 'Melodia', 'pluck', 4, [
    [0, 81, 0.5], [0.75, 84, 0.25], [1, 80, 0.5], [1.5, 81, 1], [3, 76, 0.75],
    [4, 72, 0.5], [4.75, 76, 0.25], [5, 77, 0.5], [5.5, 76, 1.5], [7.5, 72, 0.5],
    [8, 77, 0.5], [8.75, 81, 0.25], [9, 77, 0.5], [9.5, 76, 1.5], [11.5, 72, 0.5],
    [12, 74, 0.5], [12.75, 79, 0.25], [13, 74, 0.5], [13.5, 71, 1.5], [15.5, 80, 0.45],
  ]),
  mel('m-lofi', 'Melodia Lo-fi', 'Melodia', 'tine', 4, [
    [0, 76, 0.75], [1, 72, 0.5], [1.5, 69, 0.5], [2.5, 72, 1.5],
    [4, 74, 0.75], [5, 71, 0.5], [5.5, 67, 0.5], [6.5, 71, 1.5],
    [8, 72, 0.75], [9, 69, 0.5], [9.5, 65, 0.5], [10.5, 69, 1.5],
    [12, 71, 0.75], [13, 67, 0.5], [13.5, 64, 0.5], [14.5, 67, 1.5],
  ], 16, 80),
  // Mais melodias por estilo (mesmos tons e progressões dos acordes e baixos novos de mesmo nome)
  // Funk carioca: gancho de um compasso (Lá, Dó, Mi e Ré cabem em Am, G e F)
  mel('m-funk-carioca', 'Gancho Funk Carioca', 'Melodia', 'lead', 1, [
    [0, 76, 0.25], [0.75, 76, 0.25], [1.5, 72, 0.25], [2, 74, 0.5], [3, 72, 0.25], [3.5, 69, 0.4],
  ], 4, 110),
  mel('m-axe', 'Melodia Axé', 'Melodia', 'trumpet', 4, [
    [0, 72, 0.5], [0.5, 76, 0.5], [1, 79, 0.75], [1.75, 76, 0.25], [2, 79, 0.5], [2.5, 76, 0.5], [3, 72, 1],
    [4, 77, 0.5], [4.5, 81, 0.5], [5, 84, 0.75], [5.75, 81, 0.25], [6, 77, 0.5], [6.5, 76, 0.5], [7, 77, 1],
    [8, 79, 0.5], [8.5, 83, 0.5], [9, 79, 0.75], [9.75, 77, 0.25], [10, 74, 0.5], [10.5, 71, 0.5], [11, 74, 1],
    [12, 76, 0.5], [12.5, 74, 0.5], [13, 72, 1.5], [15, 67, 0.5], [15.5, 71, 0.5],
  ]),
  mel('m-pagode', 'Melodia Pagode', 'Melodia', 'guitar', 4, [
    [0, 76, 0.5], [0.5, 79, 0.5], [1, 76, 0.25], [1.25, 74, 0.25], [1.5, 72, 0.5], [2.5, 76, 0.5], [3, 74, 0.5], [3.5, 72, 0.5],
    [4, 73, 0.5], [4.5, 76, 0.5], [5, 79, 1], [6, 76, 0.5], [6.5, 73, 0.5], [7, 69, 1],
    [8, 74, 0.5], [8.5, 77, 0.5], [9, 81, 1], [10, 77, 0.5], [10.5, 74, 0.5], [11, 72, 1],
    [12, 71, 0.5], [12.5, 74, 0.5], [13, 77, 1], [14, 74, 0.5], [14.5, 71, 0.5], [15, 67, 1],
  ]),
  mel('m-sertanejo', 'Melodia Sertanejo', 'Melodia', 'guitar', 4, [
    [0, 71, 0.5], [0.5, 74, 0.5], [1, 79, 1], [2, 76, 0.5], [2.5, 74, 0.5], [3, 71, 1],
    [4, 69, 0.5], [4.5, 74, 0.5], [5, 78, 1], [6, 76, 0.5], [6.5, 74, 0.5], [7, 69, 1],
    [8, 71, 0.5], [8.5, 76, 0.5], [9, 79, 1], [10, 78, 0.5], [10.5, 76, 0.5], [11, 71, 1],
    [12, 72, 0.5], [12.5, 76, 0.5], [13, 79, 1], [14, 76, 0.5], [14.5, 74, 0.5], [15, 72, 1],
  ]),
  mel('m-maracatu', 'Melodia Maracatu', 'Melodia', 'trumpet', 4, [
    [0, 74, 1], [1, 77, 0.5], [1.5, 76, 0.5], [2, 74, 0.5], [2.5, 72, 0.5], [3, 69, 1],
    [4, 74, 0.5], [4.5, 77, 0.5], [5, 81, 1], [6, 79, 0.5], [6.5, 77, 0.5], [7, 76, 1],
    [8, 76, 1], [9, 72, 0.5], [9.5, 74, 0.5], [10, 76, 1], [11, 79, 1],
    [12, 77, 1], [13, 74, 0.5], [13.5, 72, 0.5], [14, 70, 1], [15, 74, 1],
  ]),
  // Frevo: semicolcheias rápidas com bordaduras cromáticas, como os metais
  mel('m-frevo', 'Melodia Frevo', 'Melodia', 'trumpet', 4, [
    [0, 79, 0.25], [0.25, 78, 0.25], [0.5, 79, 0.25], [0.75, 81, 0.25], [1, 83, 0.5], [1.5, 79, 0.5], [2, 74, 0.5], [2.5, 71, 0.5], [3, 74, 0.5], [3.5, 79, 0.5],
    [4, 76, 0.25], [4.25, 75, 0.25], [4.5, 76, 0.25], [4.75, 77, 0.25], [5, 79, 0.5], [5.5, 76, 0.5], [6, 72, 0.5], [6.5, 67, 0.5], [7, 72, 0.5], [7.5, 76, 0.5],
    [8, 78, 0.25], [8.25, 77, 0.25], [8.5, 78, 0.25], [8.75, 79, 0.25], [9, 81, 0.5], [9.5, 78, 0.5], [10, 74, 0.5], [10.5, 72, 0.5], [11, 69, 0.5], [11.5, 66, 0.5],
    [12, 67, 0.5], [12.5, 71, 0.5], [13, 74, 0.5], [13.5, 79, 0.5], [14, 83, 1], [15, 79, 0.5], [15.5, 78, 0.4],
  ]),
  mel('m-ijexa', 'Melodia Ijexá', 'Melodia', 'tine', 4, [
    [0, 76, 1], [1, 72, 0.5], [1.5, 74, 0.5], [2, 76, 1.5], [3.5, 79, 0.5],
    [4, 77, 1], [5, 74, 0.5], [5.5, 72, 0.5], [6, 69, 1.5], [7.5, 72, 0.5],
    [8, 76, 0.5], [8.5, 79, 0.5], [9, 81, 1], [10, 79, 0.5], [10.5, 76, 0.5], [11, 72, 1],
    [12, 74, 1], [13, 71, 0.5], [13.5, 67, 0.5], [14, 71, 1.5], [15.5, 74, 0.5],
  ], 16, 85),
  mel('m-salsa', 'Melodia Salsa', 'Melodia', 'trumpet', 4, [
    [0, 76, 0.5], [0.5, 72, 0.5], [1, 69, 0.5], [1.5, 72, 0.25], [1.75, 76, 0.75], [2.5, 79, 0.5], [3, 76, 0.5], [3.5, 74, 0.5],
    [4, 72, 0.5], [4.5, 74, 0.5], [5, 78, 0.75], [5.75, 81, 0.75], [6.5, 78, 0.5], [7, 74, 1],
    [8, 71, 0.5], [8.5, 74, 0.5], [9, 78, 0.75], [9.75, 79, 0.75], [10.5, 74, 0.5], [11, 71, 1],
    [12, 72, 0.5], [12.5, 76, 0.5], [13, 79, 0.75], [13.75, 76, 0.75], [14.5, 72, 0.5], [15, 76, 0.5], [15.5, 74, 0.5],
  ]),
  mel('m-cumbia', 'Melodia Cumbia', 'Melodia', 'organ', 4, [
    [0, 76, 0.5], [0.5, 77, 0.5], [1, 76, 0.5], [1.5, 74, 0.5], [2, 72, 0.5], [2.5, 71, 0.5], [3, 69, 1],
    [4, 74, 0.5], [4.5, 77, 0.5], [5, 81, 0.5], [5.5, 77, 0.5], [6, 74, 1], [7, 77, 1],
    [8, 76, 0.5], [8.5, 80, 0.5], [9, 83, 0.5], [9.5, 80, 0.5], [10, 76, 0.5], [10.5, 74, 0.5], [11, 71, 1],
    [12, 72, 0.5], [12.5, 71, 0.5], [13, 69, 2], [15, 64, 1],
  ]),
  mel('m-bachata', 'Melodia Bachata', 'Melodia', 'guitar', 4, [
    [0, 69, 0.5], [0.5, 72, 0.5], [1, 76, 1], [2, 74, 0.5], [2.5, 72, 0.5], [3, 71, 0.5], [3.5, 72, 0.5],
    [4, 74, 0.5], [4.5, 77, 0.5], [5, 81, 1], [6, 79, 0.5], [6.5, 77, 0.5], [7, 74, 1],
    [8, 76, 0.5], [8.5, 74, 0.5], [9, 71, 1], [10, 68, 0.5], [10.5, 71, 0.5], [11, 74, 1],
    [12, 72, 1], [13, 71, 0.5], [13.5, 69, 2.4],
  ]),
  mel('m-bolero', 'Melodia Bolero', 'Melodia', 'sax', 4, [
    [0, 76, 1.5], [1.5, 74, 0.5], [2, 72, 1], [3, 76, 1],
    [4, 76, 1.5], [5.5, 72, 0.5], [6, 69, 1], [7, 72, 1],
    [8, 77, 1.5], [9.5, 76, 0.5], [10, 74, 1], [11, 72, 1],
    [12, 71, 1.5], [13.5, 74, 0.5], [14, 77, 1], [15, 74, 1],
  ], 16, 100),
  // Punk: Mi maior pentatônico sobre E E A B
  mel('m-punk', 'Melodia Punk', 'Melodia', 'guitar', 4, [
    [0, 76, 1], [1, 76, 0.5], [1.5, 78, 0.5], [2, 80, 1], [3, 78, 0.5], [3.5, 76, 0.5],
    [4, 76, 0.5], [4.5, 78, 0.5], [5, 80, 0.5], [5.5, 83, 0.5], [6, 80, 1], [7, 78, 1],
    [8, 81, 1], [9, 80, 0.5], [9.5, 78, 0.5], [10, 76, 1], [11, 73, 1],
    [12, 78, 1], [13, 75, 0.5], [13.5, 78, 0.5], [14, 83, 1], [15, 80, 0.5], [15.5, 78, 0.5],
  ]),
  mel('m-poppunk', 'Melodia Pop Punk', 'Melodia', 'guitar', 4, [
    [0, 74, 0.5], [0.5, 78, 0.5], [1, 81, 1], [2, 78, 0.5], [2.5, 76, 0.5], [3, 74, 1],
    [4, 73, 0.5], [4.5, 76, 0.5], [5, 81, 1], [6, 79, 0.5], [6.5, 76, 0.5], [7, 73, 1],
    [8, 74, 0.5], [8.5, 78, 0.5], [9, 83, 1], [10, 81, 0.5], [10.5, 78, 0.5], [11, 74, 1],
    [12, 74, 0.5], [12.5, 79, 0.5], [13, 83, 1], [14, 81, 0.5], [14.5, 79, 0.5], [15, 76, 1],
  ]),
  // Motorik: o mesmo desenho em colcheias, repetido (hipnótico), descendo um tom no último compasso
  mel('m-motorik', 'Melodia Motorik', 'Melodia', 'guitar', 4, [0, 0, 0, -2].flatMap((t, i) =>
    [69, 76, 72, 76, 69, 76, 74, 76].map((p, k) => [i * 4 + k / 2, p + t, 0.4] as [number, number, number])), 16, 110),
  mel('m-ska', 'Melodia Ska', 'Melodia', 'trumpet', 4, [
    [0, 72, 0.5], [0.5, 76, 0.5], [1, 79, 0.5], [1.5, 76, 0.5], [2, 79, 1], [3, 81, 0.5], [3.5, 79, 0.5],
    [4, 76, 0.5], [4.5, 72, 0.5], [5, 69, 0.5], [5.5, 72, 0.5], [6, 76, 1.5], [7.5, 74, 0.5],
    [8, 72, 0.5], [8.5, 77, 0.5], [9, 81, 0.5], [9.5, 77, 0.5], [10, 81, 1], [11, 84, 0.5], [11.5, 81, 0.5],
    [12, 79, 0.5], [12.5, 74, 0.5], [13, 71, 0.5], [13.5, 74, 0.5], [14, 79, 1.5], [15.5, 74, 0.5],
  ]),
  mel('m-country', 'Melodia Country', 'Melodia', 'guitar', 4, [
    [0, 74, 0.5], [0.5, 71, 0.5], [1, 74, 0.5], [1.5, 76, 0.5], [2, 79, 1], [3, 76, 0.5], [3.5, 74, 0.5],
    [4, 76, 0.5], [4.5, 72, 0.5], [5, 76, 0.5], [5.5, 79, 0.5], [6, 81, 1], [7, 79, 0.5], [7.5, 76, 0.5],
    [8, 78, 0.5], [8.5, 74, 0.5], [9, 78, 0.5], [9.5, 81, 0.5], [10, 78, 1], [11, 76, 0.5], [11.5, 74, 0.5],
    [12, 71, 0.5], [12.5, 74, 0.5], [13, 79, 2], [15, 74, 1],
  ]),
  // Afrobeat: riff de metais em pergunta (Dm7) e resposta (G9)
  mel('m-afrobeat', 'Metais Afrobeat', 'Melodia', 'trumpet', 2, [
    [0.5, 74, 0.25], [0.75, 77, 0.5], [1.5, 81, 0.5], [2, 79, 0.25], [2.25, 77, 0.5], [3, 74, 0.75],
    [4.5, 71, 0.25], [4.75, 74, 0.5], [5.5, 77, 0.5], [6, 76, 0.25], [6.25, 74, 0.5], [7, 71, 0.75],
  ], 8, 90),
  mel('m-afrobeats', 'Melodia Afrobeats', 'Melodia', 'pluck', 4, [
    [0, 76, 0.5], [0.75, 74, 0.25], [1, 72, 0.5], [1.5, 69, 0.75], [2.5, 72, 0.5], [3, 74, 0.5], [3.5, 76, 0.5],
    [4, 77, 0.5], [4.75, 76, 0.25], [5, 72, 0.5], [5.5, 69, 0.75], [6.5, 72, 0.5], [7, 74, 0.5], [7.5, 72, 0.5],
    [8, 76, 0.5], [8.75, 74, 0.25], [9, 72, 0.5], [9.5, 67, 0.75], [10.5, 72, 0.5], [11, 74, 0.5], [11.5, 76, 0.5],
    [12, 74, 0.5], [12.75, 71, 0.25], [13, 67, 0.5], [13.5, 71, 0.75], [14.5, 74, 1.5],
  ], 16, 110),
  mel('m-amapiano', 'Melodia Amapiano', 'Melodia', 'tine', 4, [
    [0.5, 76, 0.5], [1.5, 79, 0.5], [2.5, 76, 0.25], [2.75, 74, 0.75], [3.5, 72, 0.5],
    [4.5, 76, 0.5], [5.5, 72, 0.5], [6.5, 69, 1.5],
    [8.5, 77, 0.5], [9.5, 76, 0.5], [10.5, 72, 0.25], [10.75, 69, 0.75], [11.5, 72, 0.5],
    [12.5, 74, 0.5], [13.5, 71, 0.5], [14.5, 67, 1.5],
  ], 16, 110),
  mel('m-ukg', 'Melodia UK Garage', 'Melodia', 'bell', 4, [
    [0, 76, 0.25], [0.5, 79, 0.25], [1, 76, 0.25], [1.75, 72, 0.5], [2.5, 74, 0.25], [3, 76, 0.5],
    [4, 79, 0.25], [4.5, 76, 0.25], [5, 71, 0.25], [5.75, 72, 0.5], [6.5, 74, 0.25], [7, 76, 0.5],
    [8, 76, 0.25], [8.5, 77, 0.25], [9, 81, 0.25], [9.75, 76, 0.5], [10.5, 72, 0.25], [11, 69, 0.5],
    [12, 74, 0.25], [12.5, 71, 0.25], [13, 67, 0.25], [13.75, 71, 0.5], [14.5, 74, 0.25], [15, 79, 0.75],
  ], 16, 80),
  mel('m-dubstep', 'Melodia Dubstep', 'Melodia', 'lead', 4, [
    [0, 76, 1.5], [1.5, 79, 0.5], [2, 83, 1.5], [3.5, 81, 0.5],
    [4, 79, 2], [6, 76, 1], [7, 74, 1],
    [8, 74, 1.5], [9.5, 79, 0.5], [10, 83, 1.5], [11.5, 81, 0.5],
    [12, 78, 2], [14, 74, 1], [15, 76, 1],
  ]),
  mel('m-jersey', 'Gancho Jersey Club', 'Melodia', 'lead', 1, [
    [0, 81, 0.25], [0.5, 81, 0.25], [1, 76, 0.25], [1.5, 79, 0.25], [2, 76, 0.25], [2.75, 72, 0.25], [3, 76, 0.25], [3.5, 69, 0.4],
  ], 4, 110),
  mel('m-synthwave', 'Melodia Synthwave', 'Melodia', 'lead', 4, [
    [0, 76, 1.5], [1.5, 72, 0.5], [2, 74, 0.5], [2.5, 76, 1.5],
    [4, 77, 1.5], [5.5, 76, 0.5], [6, 72, 0.5], [6.5, 69, 1.5],
    [8, 79, 1.5], [9.5, 76, 0.5], [10, 72, 0.5], [10.5, 76, 1.5],
    [12, 74, 1.5], [13.5, 71, 0.5], [14, 74, 0.5], [14.5, 79, 1.5],
  ]),
  // Para completar os estilos
  mel('m-hiphop', 'Melodia Boom Bap', 'Melodia', 'tine', 4, [
    [0.5, 75, 0.5], [1, 79, 1], [2.5, 77, 0.5], [3, 75, 1],
    [4.5, 72, 0.5], [5, 75, 1.5], [7, 70, 1],
    [8.5, 77, 0.5], [9, 80, 1], [10.5, 79, 0.5], [11, 77, 1],
    [12.5, 75, 0.5], [13, 72, 1.5], [15, 70, 1],
  ], 16, 90),
  mel('m-dembow', 'Melodia Reggaeton', 'Melodia', 'lead', 4, [
    [0, 76, 0.5], [0.75, 76, 0.25], [1, 74, 0.5], [1.5, 72, 0.5], [2, 69, 0.75], [3, 72, 0.5], [3.5, 74, 0.5],
    [4, 77, 0.5], [4.75, 77, 0.25], [5, 76, 0.5], [5.5, 72, 0.5], [6, 69, 0.75], [7, 72, 0.5], [7.5, 74, 0.5],
    [8, 79, 0.5], [8.75, 79, 0.25], [9, 76, 0.5], [9.5, 72, 0.5], [10, 67, 0.75], [11, 72, 0.5], [11.5, 74, 0.5],
    [12, 74, 0.5], [12.75, 74, 0.25], [13, 71, 0.5], [13.5, 67, 0.5], [14, 71, 1], [15, 74, 1],
  ]),
  // Metal: riff em mi menor (E5 E5 G5 F#5)
  mel('m-metal', 'Riff Metal', 'Melodia', 'guitar', 4, [
    [0, 64, 0.5], [0.5, 67, 0.5], [1, 71, 0.5], [1.5, 69, 0.5], [2, 67, 0.5], [2.5, 66, 0.5], [3, 64, 1],
    [4, 64, 0.5], [4.5, 67, 0.5], [5, 71, 0.5], [5.5, 72, 0.5], [6, 71, 1], [7, 69, 1],
    [8, 67, 0.5], [8.5, 71, 0.5], [9, 74, 0.5], [9.5, 72, 0.5], [10, 71, 1], [11, 67, 1],
    [12, 66, 0.5], [12.5, 69, 0.5], [13, 73, 0.5], [13.5, 71, 0.5], [14, 69, 1], [15, 66, 1],
  ], 16, 100),
  // Techno: sequência hipnótica de um compasso
  mel('m-techno', 'Sequência Techno', 'Melodia', 'lead', 1, [
    [0, 69, 0.2], [0.75, 72, 0.2], [1.5, 76, 0.2], [2.25, 69, 0.2], [3, 74, 0.2], [3.5, 72, 0.2],
  ], 4, 85),
  mel('m-dnb', 'Melodia Drum and Bass', 'Melodia', 'tine', 4, [
    [0, 76, 1.5], [1.5, 79, 0.5], [2, 76, 1], [3, 72, 1],
    [4, 74, 1.5], [5.5, 72, 0.5], [6, 69, 2],
    [8, 77, 1.5], [9.5, 79, 0.5], [10, 72, 1], [11, 67, 1],
    [12, 74, 1.5], [13.5, 71, 0.5], [14, 67, 2],
  ], 16, 90),
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
    // a harmonia sobre a qual o loop foi escrito: com ela, ele segue a trilha de acordes
    ...(loop.kind === 'instrument' ? { harmony: loopHarmony(loop) } : {}),
  });
  useStore.getState().set({ selectedRegionId: r.id, selectedTrackId: target.id });
}

const harmonyCache = new Map<string, Harmony | undefined>();

/**
 * Harmonia de um loop melódico: os acordes do loop de acordes do estilo dele (as quatro partes de um estilo
 * são escritas sobre a mesma progressão), reconhecidos nas notas, um por compasso. Um loop mais curto que
 * o de acordes usa só o começo da progressão (é o que ele repete).
 */
export function loopHarmony(loop: Loop): Harmony | undefined {
  if (harmonyCache.has(loop.id)) return harmonyCache.get(loop.id);
  const style = STYLES.find((s) => [...s.bass, ...s.chords, ...s.melody].includes(loop.id));
  const src = (style && LOOPS.find((l) => l.id === style.chords[0])) ?? (loop.category === 'Acordes' ? loop : undefined);
  let h: Harmony | undefined;
  if (src) {
    const bass = style && LOOPS.find((l) => l.id === style.bass[0]);
    h = inferHarmony(src.notes, src.bars, bass?.notes, bass?.bars);
    if (loop.bars < src.bars) h = { period: loop.bars * 4, chords: h.chords.filter((c) => c.at < loop.bars * 4) };
  }
  harmonyCache.set(loop.id, h);
  return h;
}

/**
 * Os estilos musicais, iguais para as quatro partes: cada estilo tem bateria, baixo, acordes e melodia que
 * combinam entre si (mesmo tom, mesma progressão, mesmo balanço). Quando há mais de um loop numa parte,
 * são variações do mesmo estilo (o primeiro é o principal).
 */
export interface Style {
  id: string;
  name: string;
  group: string;
  drums: string[];
  bass: string[];
  chords: string[];
  melody: string[];
}

const st = (group: string, id: string, name: string, drums: string[], bass: string[], chords: string[], melody: string[]): Style =>
  ({ id, name, group, drums, bass, chords, melody });
/** Estilo cujas quatro partes têm o mesmo nome de id (d-x, b-x, c-x, m-x). */
const same = (group: string, id: string, name: string) => st(group, id, name, [`d-${id}`], [`b-${id}`], [`c-${id}`], [`m-${id}`]);

export const STYLES: Style[] = [
  st('Rock e pesado', 'rock', 'Rock', ['d-rock', 'd-hardrock', 'd-hardrock-half', 'd-toms'], ['b-rock'], ['c-rock'], ['m-rock']),
  st('Rock e pesado', 'metal', 'Metal', ['d-metal-double', 'd-metal-gallop', 'd-metal-blast'], ['b-metal'], ['c-metal'], ['m-metal']),
  st('Rock e pesado', 'punk', 'Punk / Hardcore', ['d-punk', 'd-hc-skank', 'd-hc-dbeat'], ['b-punk'], ['c-punk'], ['m-punk']),
  same('Rock e pesado', 'poppunk', 'Pop Punk'),
  st('Rock e pesado', 'psych', 'Psicodélico anos 70', ['d-psych-groove', 'd-psych-tribal', 'd-psych-heavy'], ['b-psych'], ['c-psych-organ'], ['m-psych-lead']),
  same('Rock e pesado', 'motorik', 'Motorik (Krautrock)'),
  st('Pop', 'pop', 'Pop', ['d-pop'], ['b-pop'], ['c-pop', 'c-strings'], ['m-lead', 'm-arp-pop']),
  same('Pop', 'ballad', 'Balada'),
  same('Pop', 'country', 'Country'),
  st('Groove e soul', 'funk', 'Funk', ['d-funk', 'd-funk-us', 'd-funk-break'], ['b-funk'], ['c-funk'], ['m-funk']),
  same('Groove e soul', 'disco', 'Disco'),
  same('Groove e soul', 'motown', 'Motown'),
  st('Groove e soul', 'reggae', 'Reggae', ['d-reggae-onedrop', 'd-reggae-rockers', 'd-reggae-steppers'], ['b-reggae'], ['c-reggae'], ['m-reggae']),
  same('Groove e soul', 'ska', 'Ska'),
  st('Blues e jazz', 'blues', 'Blues / Shuffle', ['d-shuffle', 'd-blues'], ['b-blues'], ['c-blues'], ['m-blues']),
  st('Blues e jazz', 'jazz', 'Jazz', ['d-jazz'], ['b-walking'], ['c-jazz'], ['m-jazz']),
  same('Brasileiros', 'samba', 'Samba'),
  same('Brasileiros', 'pagode', 'Pagode'),
  same('Brasileiros', 'bossa', 'Bossa Nova'),
  st('Brasileiros', 'baiao', 'Baião / Xote', ['d-baiao', 'd-xote'], ['b-baiao'], ['c-baiao'], ['m-baiao']),
  same('Brasileiros', 'funk-carioca', 'Funk Carioca'),
  same('Brasileiros', 'axe', 'Axé'),
  same('Brasileiros', 'sertanejo', 'Sertanejo'),
  same('Brasileiros', 'maracatu', 'Maracatu'),
  same('Brasileiros', 'frevo', 'Frevo'),
  same('Brasileiros', 'ijexa', 'Ijexá'),
  same('Latinos', 'salsa', 'Salsa'),
  same('Latinos', 'cumbia', 'Cumbia'),
  same('Latinos', 'bachata', 'Bachata'),
  same('Latinos', 'bolero', 'Bolero'),
  same('Latinos', 'dembow', 'Reggaeton'),
  same('Africanos', 'afrobeat', 'Afrobeat (anos 70)'),
  st('Africanos', 'afrobeats', 'Afrobeats', ['d-afrobeats'], ['b-afrobeats', 'b-minor'], ['c-afrobeats', 'c-minor'], ['m-afrobeats']),
  same('Africanos', 'amapiano', 'Amapiano'),
  st('Hip-hop', 'hiphop', 'Boom Bap', ['d-hiphop'], ['b-groove'], ['c-hiphop'], ['m-hiphop']),
  same('Hip-hop', 'trap', 'Trap'),
  same('Hip-hop', 'lofi', 'Lo-fi Hip-hop'),
  same('Eletrônicos', 'house', 'House'),
  same('Eletrônicos', 'techno', 'Techno'),
  same('Eletrônicos', 'dnb', 'Drum and Bass'),
  same('Eletrônicos', 'ukg', 'UK Garage'),
  same('Eletrônicos', 'dubstep', 'Dubstep'),
  same('Eletrônicos', 'jersey', 'Jersey Club'),
  st('Eletrônicos', 'synthwave', 'Synthwave', ['d-synthwave'], ['b-synthwave'], ['c-synthwave', 'c-pad'], ['m-synthwave', 'm-arp']),
];

/** Grupos de estilos, na ordem em que aparecem. */
export const STYLE_GROUPS = [...new Set(STYLES.map((x) => x.group))];

/** As partes de um estilo, na ordem das colunas (bateria, baixo, acordes, melodia). */
export const STYLE_PARTS: { key: 'drums' | 'bass' | 'chords' | 'melody'; category: Loop['category'] }[] = [
  { key: 'drums', category: 'Bateria' },
  { key: 'bass', category: 'Baixo' },
  { key: 'chords', category: 'Acordes' },
  { key: 'melody', category: 'Melodia' },
];

/** O estilo a que um loop pertence. */
export const styleOfLoop = (id: string) => STYLES.find((x) => STYLE_PARTS.some((p) => x[p.key].includes(id)));

/** Estilos de bateria agrupados por gênero (para o seletor no cabeçalho da trilha de bateria). */
export const DRUM_STYLES: { group: string; ids: string[] }[] = STYLE_GROUPS.map((group) => ({
  group,
  ids: STYLES.filter((x) => x.group === group).flatMap((x) => x.drums),
}));

/** Estilos com viradas de bateria eletrônica (rufos e chimbal) em vez de tons e caixa. */
const ELECTRO_DRUMS = new Set(['d-hiphop', 'd-trap', 'd-house', 'd-dembow', 'd-techno', 'd-dnb', 'd-lofi', 'd-ukg', 'd-dubstep', 'd-jersey', 'd-synthwave']);

/**
 * Banda completa: a parte principal de cada parte do estilo, cada uma numa trilha nova, a partir do compasso
 * do cursor (a bateria com viradas, como no seletor de estilo).
 */
export function addStyleBand(style: Style, beat: number) {
  const s = useStore.getState();
  s.snapshot();
  const drums = LOOPS.find((l) => l.id === style.drums[0])!;
  const t = s.addTrack('drums', { name: `Bateria ${style.name}` });
  applyDrumStyle(drums.id, t.id, beat);
  for (const part of [style.bass[0], style.chords[0], style.melody[0]]) {
    const l = LOOPS.find((x) => x.id === part);
    if (l) addLoop(l, beat);
  }
}

/** Repete o padrão do loop até preencher `beats` tempos. */
export function tile(loop: Loop, beats: number) {
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
  const electro = !!loop && ELECTRO_DRUMS.has(loop.id);
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
