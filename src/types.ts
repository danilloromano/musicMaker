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
  tracks: Track[];
  regions: Region[];
}

export const BEATS_PER_BAR = 4;

export const uid = () => Math.random().toString(36).slice(2, 10);

/** Comprimento da região em tempos (áudio depende do BPM). */
export function regionLen(r: Region, bpm: number): number {
  return r.bufferId ? ((r.duration ?? 0) * bpm) / 60 : r.length;
}

export function projectEnd(p: Project): number {
  return p.regions.reduce((m, r) => Math.max(m, r.start + regionLen(r, p.bpm)), 0);
}
