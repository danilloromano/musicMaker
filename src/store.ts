import { create } from 'zustand';
import type { ExportReport } from './audio/export';
import type { Analysis } from './audio/analysis';
import { Marker, barBeats, Note, Project, Region, SECTION_NAMES, Track, TrackKind, fitFades, regionLen, uid } from './types';

const COLORS = ['#ff7a45', '#38d9c0', '#b98cff', '#ffcf3f', '#ff5fa2', '#5fb4ff', '#9be15d', '#e0b48a'];

const KIND_NAME: Record<TrackKind, string> = { instrument: 'Instrumento', drums: 'Bateria', audio: 'Áudio', bus: 'Grupo' };

export function newTrack(kind: TrackKind, index: number, patch: Partial<Track> = {}): Track {
  return {
    id: uid(),
    name: `${KIND_NAME[kind]} ${index + 1}`,
    kind,
    instrument: kind === 'instrument' ? 'grand' : kind,
    volume: 0.8,
    pan: 0,
    mute: false,
    solo: false,
    color: COLORS[index % COLORS.length],
    fx: { low: 0, mid: 0, high: 0, reverb: kind === 'drums' ? 0.05 : kind === 'bus' ? 0 : 0.15, delay: 0, comp: false },
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

export function pref(key: string): string | null {
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

export type BottomTab = 'editor' | 'fx' | 'amp' | 'loops' | 'keys' | 'audio' | 'mixer' | 'master' | 'tab' | 'study';

interface State {
  project: Project;
  past: Project[];
  future: Project[];
  selectedTrackId: string | null;
  selectedRegionId: string | null;
  editingRegionId: string | null;
  audioEditId: string | null; // região de áudio aberta no editor de áudio
  audioSel: { trackId: string; start: number; end: number } | null; // trecho selecionado no editor de áudio (tempos)
  selectedNoteId: string | null;
  playing: boolean;
  /** gravação em andamento; `punch` = só o trecho [start, end) é gravado e substitui o que havia */
  recording: { trackId: string; startBeat: number; punch?: { start: number; end: number } } | null;
  ppb: number; // pixels por tempo na timeline
  bottomTab: BottomTab;
  countIn: boolean; // conta 1 compasso no metrônomo antes de gravar
  /** metrônomo: subdivisão, volume e o treino de velocidade (preferências, não vão no projeto) */
  metro: MetroSettings;
  setMetro: (patch: Partial<MetroSettings>) => void;
  octave: number;
  /** carregamento em andamento (mostra a nave): progresso 0..1, ou null quando não dá para medir */
  loading: { label: string; progress: number | null } | null;
  /** resultado da última exportação (loudness e pico real do arquivo) */
  lastExport: ExportReport | null;
  /** A/B: ouvindo a referência (true) ou a mix (false) */
  abRef: boolean;
  /** A/B: igualar o volume da referência ao da mix (para comparar o timbre, não o volume) */
  abMatch: boolean;
  /** análises (não fazem parte do projeto: recalculadas quando preciso) */
  refAnalysis: Analysis | null;
  mixAnalysis: Analysis | null;

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
  /** Apaga o trecho [start, end) (em tempos) de todas as regiões de áudio da trilha, deixando silêncio no lugar. */
  deleteAudioRange: (trackId: string, start: number, end: number) => void;
  /** Liga/desliga o loop; se ainda não há trecho, usa a região selecionada ou 4 compassos a partir do cursor. */
  toggleLoop: (cursorBeat: number) => void;
  /** Liga/desliga o punch-in; se ainda não há trecho, usa o do loop, a região selecionada ou 2 compassos do cursor. */
  togglePunch: (cursorBeat: number) => void;
  setNotes: (regionId: string, notes: Note[], history?: boolean) => void;

  /** Cria um marcador de seção no compasso do tempo dado (com o nome da próxima seção provável). */
  addMarker: (beat: number) => Marker | null;
  updateMarker: (id: string, patch: Partial<Marker>, history?: boolean) => void;
  removeMarker: (id: string) => void;
}

const sortMarkers = (m: Marker[]) => [...m].sort((a, b) => a.beat - b.beat);

/** Metrônomo: subdivisão (1 = nenhuma, 2, 3, 4), volume (0..1) e o treino de velocidade. */
export interface MetroSettings {
  sub: number;
  vol: number;
  /** treino: sobe `step` BPM a cada `every` compassos, até `max`; ao parar, volta ao andamento original */
  trainer: { on: boolean; step: number; every: number; max: number };
}
const METRO_DEFAULT: MetroSettings = { sub: 1, vol: 0.8, trainer: { on: false, step: 2, every: 4, max: 160 } };
function loadMetro(): MetroSettings {
  try {
    const v = JSON.parse(pref('mm.metro') ?? 'null');
    return v ? { ...METRO_DEFAULT, ...v, trainer: { ...METRO_DEFAULT.trainer, ...v.trainer } } : METRO_DEFAULT;
  } catch {
    return METRO_DEFAULT;
  }
}

export const useStore = create<State>((set, get) => ({
  project: defaultProject(),
  past: [],
  future: [],
  selectedTrackId: null,
  selectedRegionId: null,
  editingRegionId: null,
  audioEditId: null,
  audioSel: null,
  selectedNoteId: null,
  playing: false,
  recording: null,
  ppb: 24,
  bottomTab: 'loops',
  countIn: pref('mm.countIn') === '1',
  metro: loadMetro(),
  setMetro: (patch) => {
    const metro = { ...get().metro, ...patch };
    set({ metro });
    savePref('mm.metro', JSON.stringify(metro));
  },
  octave: 4,
  loading: null,
  lastExport: null,
  abRef: false,
  abMatch: true,
  refAnalysis: null,
  mixAnalysis: null,

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
      audioEditId: null,
      audioSel: null,
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
      takes: p.takes?.filter((r) => r.trackId !== id),
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
    get().update((p) => ({ ...p, regions: p.regions.map((r) => (r.id === id ? fitFades({ ...r, ...patch }) : r)) }), history),

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
      // o fade-in fica na parte da esquerda e o fade-out na da direita
      left = fitFades({ ...r, duration: cutSec, fadeOut: 0 });
      right = fitFades({ ...r, id: uid(), start: beat, offset: (r.offset ?? 0) + cutSec, duration: (r.duration ?? 0) - cutSec, fadeIn: 0 });
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
        // a harmonia de origem continua do ponto do corte
        harmony: r.harmony && { ...r.harmony, offset: (r.harmony.offset ?? 0) + cut },
      };
    }
    get().update((pr) => ({ ...pr, regions: pr.regions.flatMap((x) => (x.id === id ? [left, right] : [x])) }));
  },

  deleteAudioRange: (trackId, a, b) => {
    const p = get().project;
    const spb = 60 / p.bpm;
    let changed = false;
    const regions = p.regions.flatMap((r): Region[] => {
      if (r.trackId !== trackId || !r.bufferId) return [r];
      const rs = r.start;
      const re = rs + regionLen(r, p.bpm);
      if (re <= a || rs >= b) return [r];
      changed = true;
      const out: Region[] = [];
      // pedaço antes do trecho (mantém o id e o fade-in)
      if (rs < a) out.push(fitFades({ ...r, duration: (a - rs) * spb, fadeOut: 0 }));
      // pedaço depois do trecho (mantém o fade-out)
      if (re > b) {
        const cut = (b - rs) * spb;
        out.push(
          fitFades({
            ...r,
            id: rs < a ? uid() : r.id,
            start: b,
            offset: (r.offset ?? 0) + cut,
            duration: (r.duration ?? 0) - cut,
            fadeIn: 0,
          }),
        );
      }
      return out;
    });
    if (!changed) return;
    get().update((pr) => ({ ...pr, regions }));
    // se a região aberta no editor sumiu, abre a mais próxima da mesma trilha
    const s = get();
    if (!regions.some((r) => r.id === s.audioEditId)) {
      const near = regions
        .filter((r) => r.trackId === trackId && r.bufferId)
        .sort((x, y) => Math.abs(x.start - a) - Math.abs(y.start - a))[0];
      set({ audioEditId: near?.id ?? null, selectedRegionId: near?.id ?? null });
    }
    set({ audioSel: null });
  },

  togglePunch: (cursorBeat) => {
    const s = get();
    const p = s.project;
    let punch = p.punch;
    if (!punch) {
      const r = p.regions.find((x) => x.id === s.selectedRegionId);
      const bb = barBeats(p);
      const bar = Math.floor(cursorBeat / bb) * bb;
      punch = p.loop
        ? { start: p.loop.start, end: p.loop.end, on: false }
        : r
          ? { start: r.start, end: r.start + Math.max(1, regionLen(r, p.bpm)), on: false }
          : { start: bar, end: bar + 2 * bb, on: false };
    }
    s.update((pr) => ({ ...pr, punch: { ...punch, on: !punch.on } }), false);
  },
  addMarker: (at) => {
    const bb = barBeats(get().project);
    const beat = Math.max(0, Math.floor(at / bb + 1e-6) * bb);
    const list = get().project.markers ?? [];
    if (list.some((m) => Math.abs(m.beat - beat) < 1e-6)) return null;
    // o nome segue o da seção anterior (Intro → Verso → Pré-refrão → Refrão…)
    const prev = list.filter((m) => m.beat < beat).pop();
    const k = prev ? SECTION_NAMES.indexOf(prev.name) : -1;
    const name = !prev ? SECTION_NAMES[0] : k >= 0 && k < SECTION_NAMES.length - 1 ? SECTION_NAMES[k + 1] : `Seção ${list.length + 1}`;
    const marker = { id: uid(), beat, name };
    get().update((p) => ({ ...p, markers: sortMarkers([...(p.markers ?? []), marker]) }));
    return marker;
  },
  updateMarker: (id, patch, history = true) =>
    get().update((p) => ({ ...p, markers: sortMarkers((p.markers ?? []).map((m) => (m.id === id ? { ...m, ...patch } : m))) }), history),
  removeMarker: (id) => get().update((p) => ({ ...p, markers: (p.markers ?? []).filter((m) => m.id !== id) })),

  toggleLoop: (cursorBeat) => {
    const s = get();
    const p = s.project;
    let loop = p.loop;
    if (!loop) {
      const r = p.regions.find((x) => x.id === s.selectedRegionId);
      const bb = barBeats(p);
      const bar = (b: number, up: boolean) => (up ? Math.ceil(b / bb - 1e-6) : Math.floor(b / bb + 1e-6)) * bb;
      const start = r ? bar(r.start, false) : bar(cursorBeat, false);
      const end = r ? Math.max(start + bb, bar(r.start + regionLen(r, p.bpm), true)) : start + 4 * bb;
      loop = { start, end, on: false };
    }
    s.update((pr) => ({ ...pr, loop: { ...loop, on: !loop.on } }), false);
  },

  setNotes: (regionId, notes, history = true) => get().updateRegion(regionId, { notes }, history),
}));
