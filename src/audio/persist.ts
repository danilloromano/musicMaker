// Salvamento: automático no IndexedDB e manual em arquivo .mmproj (JSON com o áudio embutido).
import { Project } from '../types';

interface RawBuffer {
  sampleRate: number;
  channels: Float32Array[];
}

const toRaw = (b: AudioBuffer): RawBuffer => ({
  sampleRate: b.sampleRate,
  channels: Array.from({ length: b.numberOfChannels }, (_, c) => b.getChannelData(c).slice()),
});

function fromRaw(r: RawBuffer): AudioBuffer {
  const b = new AudioBuffer({ length: r.channels[0].length, numberOfChannels: r.channels.length, sampleRate: r.sampleRate });
  r.channels.forEach((d, c) => b.getChannelData(c).set(d));
  return b;
}

// ---------- IndexedDB ----------

let dbp: Promise<IDBDatabase> | null = null;
function db(): Promise<IDBDatabase> {
  return (dbp ??= new Promise((res, rej) => {
    const rq = indexedDB.open('musicmaker', 1);
    rq.onupgradeneeded = () => rq.result.createObjectStore('kv');
    rq.onsuccess = () => res(rq.result);
    rq.onerror = () => rej(rq.error);
  }));
}

async function idb<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const d = await db();
  return new Promise((res, rej) => {
    const rq = fn(d.transaction('kv', mode).objectStore('kv'));
    rq.onsuccess = () => res(rq.result);
    rq.onerror = () => rej(rq.error);
  });
}

export const saveBufferLocal = (id: string, b: AudioBuffer) => idb('readwrite', (s) => s.put(toRaw(b), `buf:${id}`));
export const saveProjectLocal = (p: Project) => idb('readwrite', (s) => s.put(p, 'project'));

export async function loadLocal(buffers: Map<string, AudioBuffer>): Promise<Project | null> {
  const p = (await idb('readonly', (s) => s.get('project'))) as Project | undefined;
  if (!p) return null;
  const used = new Set<string>();
  for (const r of p.regions) {
    if (!r.bufferId) continue;
    used.add(r.bufferId);
    if (buffers.has(r.bufferId)) continue;
    const raw = (await idb('readonly', (s) => s.get(`buf:${r.bufferId}`))) as RawBuffer | undefined;
    if (raw) buffers.set(r.bufferId, fromRaw(raw));
  }
  p.regions = p.regions.filter((r) => !r.bufferId || buffers.has(r.bufferId));
  // limpa áudios que nenhuma região usa mais
  const keys = (await idb('readonly', (s) => s.getAllKeys())) as string[];
  for (const k of keys) {
    if (k.startsWith('buf:') && !used.has(k.slice(4))) void idb('readwrite', (s) => s.delete(k));
  }
  return p;
}

// ---------- Arquivo ----------

function f32ToB64(a: Float32Array): string {
  const u = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
  let s = '';
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000));
  return btoa(s);
}

function b64ToF32(b: string): Float32Array {
  const s = atob(b);
  const u = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i);
  return new Float32Array(u.buffer);
}

export function download(blob: Blob, filename: string) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

export function saveProjectFile(p: Project, buffers: Map<string, AudioBuffer>) {
  const out: Record<string, { sampleRate: number; channels: string[] }> = {};
  for (const r of p.regions) {
    const b = r.bufferId && buffers.get(r.bufferId);
    if (r.bufferId && b && !out[r.bufferId]) {
      const raw = toRaw(b);
      out[r.bufferId] = { sampleRate: raw.sampleRate, channels: raw.channels.map(f32ToB64) };
    }
  }
  const json = JSON.stringify({ version: 1, project: p, buffers: out });
  download(new Blob([json], { type: 'application/json' }), `${p.name || 'projeto'}.mmproj`);
}

export async function openProjectFile(file: File, buffers: Map<string, AudioBuffer>): Promise<Project> {
  const data = JSON.parse(await file.text());
  if (!data?.project?.tracks || !data.project.regions) throw new Error('Arquivo de projeto inválido');
  for (const [id, raw] of Object.entries<{ sampleRate: number; channels: string[] }>(data.buffers ?? {})) {
    const b = fromRaw({ sampleRate: raw.sampleRate, channels: raw.channels.map(b64ToF32) });
    buffers.set(id, b);
    void saveBufferLocal(id, b);
  }
  return data.project as Project;
}
