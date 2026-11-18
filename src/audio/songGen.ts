// Gerador de estrutura: monta o esboço de uma música inteira a partir de um estilo — seções (Intro, Verso,
// Refrão…) com marcadores, a trilha de acordes (progressões de verso, refrão e ponte no tom escolhido) e o
// arranjo: em cada seção entram as partes do estilo que fazem sentido ali (a melodia só no refrão e no
// solo, a variação da bateria no pré-refrão e na ponte, viradas no fim de cada seção) e um acorde final.
// Os loops seguem a trilha de acordes, então a mesma banda toca as progressões geradas no tom pedido.
import { newTrack } from '../store';
import { Marker, MusicKey, Note, Project, Region, Track, uid } from '../types';
import { ChordEvent, ChordQ } from './chords';
import { LOOPS, Loop, STYLES, Style, loopHarmony, tile, withFills } from './loops';

// ---------- estruturas ----------

export interface SongForm {
  id: string;
  name: string;
  sections: [string, number][]; // [nome, compassos]
}

export const SONG_FORMS: SongForm[] = [
  { id: 'short', name: 'Curta (~1 min)', sections: [['Intro', 4], ['Verso', 8], ['Refrão', 8], ['Final', 4]] },
  {
    id: 'pop',
    name: 'Pop (~2–3 min)',
    sections: [['Intro', 4], ['Verso', 8], ['Refrão', 8], ['Verso', 8], ['Refrão', 8], ['Ponte', 8], ['Refrão', 8], ['Final', 4]],
  },
  {
    id: 'full',
    name: 'Completa, com pré-refrão e solo (~3–4 min)',
    sections: [
      ['Intro', 4], ['Verso', 8], ['Pré-refrão', 4], ['Refrão', 8], ['Verso', 8], ['Pré-refrão', 4], ['Refrão', 8],
      ['Solo', 8], ['Ponte', 8], ['Refrão', 8], ['Refrão', 8], ['Final', 4],
    ],
  },
  {
    id: 'jam',
    name: 'Jam / instrumental (tema – solo – tema)',
    sections: [['Intro', 4], ['Refrão', 8], ['Solo', 16], ['Refrão', 8], ['Final', 4]],
  },
];

/** Andamento típico de cada estilo (BPM). */
const STYLE_BPM: Record<string, number> = {
  rock: 120, metal: 150, punk: 175, poppunk: 165, psych: 100, motorik: 130, pop: 110, ballad: 72, country: 112,
  funk: 100, disco: 118, motown: 104, reggae: 76, ska: 150, blues: 90, jazz: 140, samba: 98, pagode: 96, bossa: 128,
  baiao: 110, 'funk-carioca': 130, axe: 135, sertanejo: 92, maracatu: 100, frevo: 150, ijexa: 100, salsa: 100,
  cumbia: 95, bachata: 125, bolero: 80, dembow: 95, afrobeat: 110, afrobeats: 104, amapiano: 112, hiphop: 90,
  trap: 140, lofi: 80, house: 124, techno: 128, dnb: 170, ukg: 132, dubstep: 140, jersey: 140, synthwave: 100,
};
export const styleBpm = (id: string) => STYLE_BPM[id] ?? 110;

// ---------- harmonia ----------

/** Grau: semitons sobre a tônica e qualidade do acorde. */
type Deg = [number, ChordQ];
const MAJ: Record<string, Deg> = { I: [0, 'maj'], ii: [2, 'min'], iii: [4, 'min'], IV: [5, 'maj'], V: [7, 'maj'], vi: [9, 'min'], bVII: [10, 'maj'] };
const MIN: Record<string, Deg> = { i: [0, 'min'], iv: [5, 'min'], v: [7, 'min'], V: [7, 'maj'], III: [3, 'maj'], VI: [8, 'maj'], VII: [10, 'maj'] };

const PROGS: Record<'major' | 'minor', Record<'verse' | 'chorus' | 'bridge', string[][]>> = {
  major: {
    verse: [['I', 'V', 'vi', 'IV'], ['I', 'vi', 'IV', 'V'], ['I', 'IV', 'vi', 'V'], ['vi', 'IV', 'I', 'V'], ['I', 'iii', 'IV', 'V']],
    chorus: [['IV', 'I', 'V', 'vi'], ['I', 'V', 'vi', 'IV'], ['IV', 'V', 'I', 'vi'], ['vi', 'IV', 'I', 'V'], ['I', 'IV', 'V', 'IV']],
    bridge: [['vi', 'IV', 'I', 'V'], ['ii', 'IV', 'V', 'V'], ['IV', 'V', 'iii', 'vi'], ['bVII', 'IV', 'I', 'V']],
  },
  minor: {
    verse: [['i', 'VI', 'III', 'VII'], ['i', 'iv', 'VII', 'III'], ['i', 'VII', 'VI', 'VII'], ['i', 'iv', 'v', 'i'], ['i', 'VI', 'iv', 'V']],
    chorus: [['VI', 'VII', 'i', 'i'], ['VI', 'III', 'VII', 'i'], ['iv', 'VI', 'VII', 'i'], ['i', 'VI', 'III', 'VII']],
    bridge: [['iv', 'v', 'VI', 'VII'], ['VI', 'VII', 'iv', 'V'], ['III', 'VII', 'VI', 'V']],
  },
};
/** Jazz e bossa: II–V–I com tétrades. */
const JAZZ: Record<'verse' | 'chorus' | 'bridge', [number, ChordQ][][]> = {
  verse: [[[2, 'm7'], [7, '7'], [0, 'maj7'], [9, '7']], [[0, 'maj7'], [9, 'm7'], [2, 'm7'], [7, '7']]],
  chorus: [[[5, 'maj7'], [4, 'm7'], [2, 'm7'], [7, '7']], [[0, 'maj7'], [5, 'maj7'], [2, 'm7'], [7, '7']]],
  bridge: [[[4, 'm7'], [9, '7'], [2, 'm7'], [7, '7']], [[5, 'm7'], [10, '7'], [0, 'maj7'], [9, '7']]],
};
/** Blues de 12 compassos. */
const BLUES_12: [number, ChordQ][] = [[0, '7'], [0, '7'], [0, '7'], [0, '7'], [5, '7'], [5, '7'], [0, '7'], [0, '7'], [7, '7'], [5, '7'], [0, '7'], [7, '7']];

/** Tempero do estilo: tétrades (jazz, bossa, lo-fi…), power chords (rock pesado) ou tríades. */
function flavorOf(style: Style): 'seventh' | 'power' | 'triad' {
  const c = LOOPS.find((l) => l.id === style.chords[0]);
  const h = c && loopHarmony(c);
  if (!h?.chords.length) return 'triad';
  const qs = h.chords.map((x) => x.q);
  if (qs.filter((q) => q === '5').length >= qs.length / 2) return 'power';
  if (qs.filter((q) => ['7', 'maj7', 'm7', 'm9', '9', 'm7b5'].includes(q)).length >= qs.length / 2) return 'seventh';
  return 'triad';
}

const SEVENTH: Partial<Record<ChordQ, ChordQ>> = { maj: 'maj7', min: 'm7' };

/** Tom original do estilo: o primeiro acorde da harmonia dos loops dele. */
export function styleKey(style: Style): MusicKey {
  const c = LOOPS.find((l) => l.id === style.chords[0]);
  const first = c && loopHarmony(c)?.chords[0];
  return first ? { root: first.root, minor: ['min', 'm7', 'm9', 'm6'].includes(first.q) } : { root: 0, minor: false };
}

/** PRNG com semente (a mesma semente dá a mesma música). */
function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Role = 'verse' | 'chorus' | 'bridge';
const ROLE: Record<string, Role> = { Intro: 'verse', Verso: 'verse', 'Pré-refrão': 'bridge', Refrão: 'chorus', Ponte: 'bridge', Solo: 'chorus', Final: 'verse' };

// ---------- montagem ----------

export interface SongOptions {
  styleId: string;
  formId: string;
  key: MusicKey;
  bpm: number;
  seed: number;
}

/** Região que repete o loop para preencher `bars` compassos (com a harmonia de origem, para seguir os acordes). */
function loopRegion(loop: Loop, trackId: string, start: number, bars: number, fills?: number): Region {
  const length = bars * 4;
  let notes = tile(loop, length);
  if (loop.kind === 'drums' && fills) notes = withFills({ name: loop.name, length }, fills, notes);
  return {
    id: uid(),
    trackId,
    name: loop.name,
    start,
    length,
    notes,
    ...(loop.kind === 'drums' ? (fills ? { fills } : {}) : { harmony: loopHarmony(loop) }),
  };
}

/** Monta o projeto da música (a partir do projeto atual: mantém nome, master e afins). */
export function generateSong(base: Project, o: SongOptions): Project {
  const style = STYLES.find((s) => s.id === o.styleId) ?? STYLES[0];
  const form = SONG_FORMS.find((f) => f.id === o.formId) ?? SONG_FORMS[1];
  const rand = rng(o.seed);
  const pick = <T,>(xs: T[]) => xs[Math.floor(rand() * xs.length)];
  const flavor = flavorOf(style);
  const blues = style.id === 'blues';
  const jazz = flavor === 'seventh' && (style.group === 'Blues e jazz' || style.id === 'bossa' || style.id === 'samba');

  // uma progressão por papel (todas as seções do mesmo tipo usam a mesma — o refrão é sempre o refrão)
  const progs = {} as Record<Role, [number, ChordQ][]>;
  for (const role of ['verse', 'chorus', 'bridge'] as Role[]) {
    if (blues) progs[role] = BLUES_12;
    else if (jazz && !o.key.minor) progs[role] = pick(JAZZ[role]);
    else {
      const table = o.key.minor ? MIN : MAJ;
      progs[role] = pick(PROGS[o.key.minor ? 'minor' : 'major'][role]).map((d) => {
        const [st, q] = table[d];
        return [st, flavor === 'power' ? '5' : flavor === 'seventh' ? SEVENTH[q] ?? q : q];
      });
    }
  }

  // trilhas: bateria, baixo, acordes e melodia do estilo
  const part = (ids: string[], i = 0) => LOOPS.find((l) => l.id === (ids[i] ?? ids[0]))!;
  const drums = part(style.drums), drumsB = part(style.drums, 1);
  const bass = part(style.bass), chords = part(style.chords), melody = part(style.melody), melodyB = part(style.melody, 1);
  const tracks: Track[] = [
    newTrack('drums', 0, { name: `Bateria ${style.name}` }),
    newTrack('instrument', 1, { name: `Baixo ${style.name}`, instrument: bass.instrument }),
    newTrack('instrument', 2, { name: `Acordes ${style.name}`, instrument: chords.instrument }),
    newTrack('instrument', 3, { name: `Melodia ${style.name}`, instrument: melody.instrument }),
  ];
  const [tD, tB, tC, tM] = tracks.map((t) => t.id);

  const regions: Region[] = [];
  const markers: Marker[] = [];
  const chordEvents: ChordEvent[] = [];
  let at = 0;
  for (const [name, bars0] of form.sections) {
    // blues: seções inteiras de 12 compassos (a intro e o final ficam com os 4 últimos da forma)
    const bars = blues && name !== 'Intro' && name !== 'Final' ? Math.max(12, Math.round(bars0 / 12) * 12) : bars0;
    markers.push({ id: uid(), beat: at, name });
    const prog = progs[ROLE[name] ?? 'verse'];
    const src = blues && bars < 12 ? prog.slice(12 - bars) : prog;
    const isFinal = name === 'Final';
    const harmonyBars = isFinal ? bars - 1 : bars;
    for (let b = 0; b < harmonyBars; b++) {
      const [st, q] = src[b % src.length];
      chordEvents.push({ id: uid(), beat: at + b * 4, root: (o.key.root + st) % 12, q, flat: [1, 3, 8, 10].includes(o.key.root) });
    }
    // arranjo da seção
    const play = (loop: Loop, trackId: string, fills?: number) => regions.push(loopRegion(loop, trackId, at, harmonyBars, fills));
    const fillEvery = Math.min(harmonyBars, 8);
    if (name === 'Intro') {
      play(drums, tD, harmonyBars);
      play(chords, tC);
    } else if (name === 'Pré-refrão' || name === 'Ponte') {
      play(drumsB, tD, fillEvery);
      play(bass, tB);
      play(chords, tC);
    } else if (name === 'Refrão') {
      play(drums, tD, fillEvery);
      play(bass, tB);
      play(chords, tC);
      play(melody, tM);
    } else if (name === 'Solo') {
      play(drums, tD, fillEvery);
      play(bass, tB);
      play(chords, tC);
      play(melodyB, tM);
    } else {
      // verso e final
      play(drums, tD, harmonyBars > 0 ? fillEvery : undefined);
      play(bass, tB);
      play(chords, tC);
    }
    if (isFinal) {
      // último compasso: acorde da tônica segurado, baixo na tônica e prato
      const end = at + harmonyBars * 4;
      const tonic = (o.key.root + 12) % 12;
      const third = o.key.minor ? 3 : 4;
      const mid = 54 + ((tonic - 6 + 12) % 12); // tônica entre Fá#3 e Fá4
      const hit = (pitch: number, vel = 100): Note => ({ id: uid(), pitch, start: 0, duration: 3.9, velocity: vel });
      chordEvents.push({ id: uid(), beat: end, root: tonic, q: o.key.minor ? 'min' : 'maj', flat: [1, 3, 8, 10].includes(o.key.root) });
      regions.push({ id: uid(), trackId: tC, name: 'Final', start: end, length: 4, notes: [hit(mid), hit(mid + third), hit(mid + 7), hit(mid + 12, 90)] });
      regions.push({ id: uid(), trackId: tB, name: 'Final', start: end, length: 4, notes: [hit(28 + ((tonic - 4 + 12) % 12), 110)] });
      regions.push({ id: uid(), trackId: tD, name: 'Final', start: end, length: 4, notes: [hit(36, 115), hit(49, 115)].map((n) => ({ ...n, duration: 0.25 })) });
    }
    at += bars * 4;
  }

  return {
    ...base,
    bpm: o.bpm,
    meter: undefined, // os loops são em 4/4
    key: o.key,
    tracks,
    regions,
    takes: [],
    markers,
    chords: chordEvents,
    loop: undefined,
    punch: undefined,
  };
}
