export type TrackKind = 'instrument' | 'drums' | 'audio';

export interface Note {
  id: string;
  pitch: number; // número MIDI
  start: number; // em tempos (beats), relativo ao início da região
  duration: number; // em tempos
  velocity: number; // 1..127
}

export interface Region {
  id: string;
  trackId: string;
  name: string;
  start: number; // em tempos, posição na timeline
  // regiões MIDI
  length: number; // em tempos
  notes?: Note[];
  // regiões de áudio
  bufferId?: string;
  offset?: number; // segundos dentro do buffer
  duration?: number; // segundos
  gain?: number; // volume da região (linear, 1 = original)
  fadeIn?: number; // segundos
  fadeOut?: number; // segundos
}

/** Trecho tocado em repetição (em tempos). */
export interface LoopRange {
  start: number;
  end: number;
  on: boolean;
}

export interface TrackFx {
  low: number; // dB
  mid: number;
  high: number;
  reverb: number; // 0..1
  delay: number; // 0..1
  comp: boolean;
}

export interface Track {
  id: string;
  name: string;
  kind: TrackKind;
  instrument: string;
  volume: number; // 0..1
  pan: number; // -1..1
  mute: boolean;
  solo: boolean;
  color: string;
  fx: TrackFx;
}

export interface Project {
  name: string;
  bpm: number;
  metronome: boolean;
  loop?: LoopRange;
  tracks: Track[];
  regions: Region[];
}

export const BEATS_PER_BAR = 4;

export const uid = () => Math.random().toString(36).slice(2, 10);

/** Comprimento da região em tempos (áudio depende do BPM). */
export function regionLen(r: Region, bpm: number): number {
  return r.bufferId ? ((r.duration ?? 0) * bpm) / 60 : r.length;
}

/** Mantém os fades de uma região de áudio dentro da duração dela (sem se sobreporem). */
export function fitFades(r: Region): Region {
  if (!r.bufferId) return r;
  const d = r.duration ?? 0;
  const fadeIn = Math.min(Math.max(0, r.fadeIn ?? 0), d);
  const fadeOut = Math.min(Math.max(0, r.fadeOut ?? 0), d - fadeIn);
  return fadeIn === (r.fadeIn ?? 0) && fadeOut === (r.fadeOut ?? 0) ? r : { ...r, fadeIn, fadeOut };
}

/** Volume (linear) de uma região de áudio a `x` segundos do início dela, com ganho e fades. */
export function regionGainAt(r: Region, x: number): number {
  const d = r.duration ?? 0;
  const fi = r.fadeIn ?? 0;
  const fo = r.fadeOut ?? 0;
  let g = r.gain ?? 1;
  if (fi > 0 && x < fi) g *= Math.max(0, x / fi);
  if (fo > 0 && x > d - fo) g *= Math.max(0, (d - x) / fo);
  return g;
}

export function projectEnd(p: Project): number {
  return p.regions.reduce((m, r) => Math.max(m, r.start + regionLen(r, p.bpm)), 0);
}
