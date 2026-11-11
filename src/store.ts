import { create } from 'zustand';
import { Note, Project, Region, Track, TrackKind, regionLen, uid } from './types';

const COLORS = ['#4f9cf9', '#f97362', '#5fd08a', '#f5c04e', '#b584f5', '#4fd1c5', '#f58fc3', '#a3b1c2'];

const KIND_NAME: Record<TrackKind, string> = { instrument: 'Instrumento', drums: 'Bateria', audio: 'Áudio' };

export function newTrack(kind: TrackKind, index: number, patch: Partial<Track> = {}): Track {
  return {
    id: uid(),
    name: `${KIND_NAME[kind]} ${index + 1}`,
    kind,
    instrument: kind === 'instrument' ? 'epiano' : kind,
    volume: 0.8,
    pan: 0,
    mute: false,
    solo: false,
    color: COLORS[index % COLORS.length],
    fx: { low: 0, mid: 0, high: 0, reverb: kind === 'drums' ? 0.05 : 0.15, delay: 0, comp: false },
    ...patch,
  };
}

export function defaultProject(): Project {
  return {
    name: 'Minha Música',
    bpm: 120,
    metronome: false,
    tracks: [newTrack('instrument', 0), newTrack('drums', 1)],
    regions: [],
  };
}

function pref(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function savePref(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* armazenamento indisponível */
  }
}

export type BottomTab = 'editor' | 'fx' | 'loops' | 'keys';

interface State {
  project: Project;
  past: Project[];
  future: Project[];
  selectedTrackId: string | null;
  selectedRegionId: string | null;
  editingRegionId: string | null;
  selectedNoteId: string | null;
  playing: boolean;
  recording: { trackId: string; startBeat: number } | null;
  ppb: number; // pixels por tempo na timeline
  bottomTab: BottomTab;
  octave: number;

  // entrada de áudio (preferências do computador, não fazem parte do projeto)
  inputs: { id: string; label: string }[];
  inputDeviceId: string | null; // null = padrão do sistema
  inputChannel: number; // 0 = entrada 1, 1 = entrada 2, 2 = soma das duas
  inputChannels: number; // quantos canais o dispositivo aberto entrega
  inputOpen: boolean;
  inputMuted: boolean; // aberta, mas o sistema não entrega sinal (dispositivo no mudo)
  monitor: boolean;

  set: (patch: Partial<State>) => void;
  /** Guarda o estado atual no histórico de desfazer. */
  snapshot: () => void;
  update: (fn: (p: Project) => Project, history?: boolean) => void;
  undo: () => void;
  redo: () => void;
  loadProject: (p: Project) => void;

  addTrack: (kind: TrackKind, patch?: Partial<Track>) => Track;
  updateTrack: (id: string, patch: Partial<Track>, history?: boolean) => void;
  removeTrack: (id: string) => void;

  addRegion: (r: Omit<Region, 'id'>) => Region;
  updateRegion: (id: string, patch: Partial<Region>, history?: boolean) => void;
  removeRegion: (id: string) => void;
  duplicateRegion: (id: string) => void;
  splitRegion: (id: string, beat: number) => void;
  setNotes: (regionId: string, notes: Note[], history?: boolean) => void;
}

export const useStore = create<State>((set, get) => ({
  project: defaultProject(),
  past: [],
  future: [],
  selectedTrackId: null,
  selectedRegionId: null,
  editingRegionId: null,
  selectedNoteId: null,
  playing: false,
  recording: null,
  ppb: 24,
  bottomTab: 'loops',
  octave: 4,

  inputs: [],
  inputDeviceId: pref('mm.inputDevice') || null,
  inputChannel: +(pref('mm.inputChannel') ?? 0) || 0,
  inputChannels: 1,
  inputOpen: false,
  inputMuted: false,
  monitor: false,

  set: (patch) => set(patch),

  snapshot: () => set((s) => ({ past: [...s.past.slice(-99), s.project], future: [] })),

  update: (fn, history = true) =>
    set((s) => {
      const project = fn(s.project);
      if (project === s.project) return s;
      return history ? { project, past: [...s.past.slice(-99), s.project], future: [] } : { project };
    }),

  undo: () =>
    set((s) => {
      const prev = s.past[s.past.length - 1];
      if (!prev) return s;
      return { project: prev, past: s.past.slice(0, -1), future: [s.project, ...s.future], selectedNoteId: null };
    }),

  redo: () =>
    set((s) => {
      const next = s.future[0];
      if (!next) return s;
      return { project: next, past: [...s.past, s.project], future: s.future.slice(1), selectedNoteId: null };
    }),

  loadProject: (p) =>
    set({
      project: p,
      past: [],
      future: [],
      selectedTrackId: p.tracks[0]?.id ?? null,
      selectedRegionId: null,
      editingRegionId: null,
      selectedNoteId: null,
    }),

  addTrack: (kind, patch) => {
    const t = newTrack(kind, get().project.tracks.length, patch);
    get().update((p) => ({ ...p, tracks: [...p.tracks, t] }));
    set({ selectedTrackId: t.id });
    return t;
  },

  updateTrack: (id, patch, history = true) =>
    get().update((p) => ({ ...p, tracks: p.tracks.map((t) => (t.id === id ? { ...t, ...patch } : t)) }), history),

  removeTrack: (id) => {
    get().update((p) => ({
      ...p,
      tracks: p.tracks.filter((t) => t.id !== id),
      regions: p.regions.filter((r) => r.trackId !== id),
    }));
    const s = get();
    if (s.selectedTrackId === id) set({ selectedTrackId: s.project.tracks[0]?.id ?? null });
  },

  addRegion: (r) => {
    const region = { ...r, id: uid() };
    get().update((p) => ({ ...p, regions: [...p.regions, region] }));
    return region;
  },

  updateRegion: (id, patch, history = true) =>
    get().update((p) => ({ ...p, regions: p.regions.map((r) => (r.id === id ? { ...r, ...patch } : r)) }), history),

  removeRegion: (id) => {
    get().update((p) => ({ ...p, regions: p.regions.filter((r) => r.id !== id) }));
    const s = get();
    set({
      selectedRegionId: s.selectedRegionId === id ? null : s.selectedRegionId,
      editingRegionId: s.editingRegionId === id ? null : s.editingRegionId,
    });
  },

  duplicateRegion: (id) => {
    const p = get().project;
    const r = p.regions.find((x) => x.id === id);
    if (!r) return;
    const copy = get().addRegion({
      ...r,
      start: r.start + regionLen(r, p.bpm),
      notes: r.notes?.map((n) => ({ ...n, id: uid() })),
    });
    set({ selectedRegionId: copy.id });
  },

  splitRegion: (id, beat) => {
    const p = get().project;
    const r = p.regions.find((x) => x.id === id);
    if (!r) return;
    const len = regionLen(r, p.bpm);
    const cut = beat - r.start;
    if (cut <= 0.01 || cut >= len - 0.01) return;
    let left: Region, right: Region;
    if (r.bufferId) {
      const cutSec = (cut * 60) / p.bpm;
      left = { ...r, duration: cutSec };
      right = { ...r, id: uid(), start: beat, offset: (r.offset ?? 0) + cutSec, duration: (r.duration ?? 0) - cutSec };
    } else {
      const notes = r.notes ?? [];
      left = {
        ...r,
        length: cut,
        notes: notes.filter((n) => n.start < cut).map((n) => ({ ...n, duration: Math.min(n.duration, cut - n.start) })),
      };
      right = {
        ...r,
        id: uid(),
        start: beat,
        length: len - cut,
        notes: notes.filter((n) => n.start >= cut).map((n) => ({ ...n, id: uid(), start: n.start - cut })),
      };
    }
    get().update((pr) => ({ ...pr, regions: pr.regions.flatMap((x) => (x.id === id ? [left, right] : [x])) }));
  },

  setNotes: (regionId, notes, history = true) => get().updateRegion(regionId, { notes }, history),
}));
