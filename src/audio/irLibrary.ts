// Biblioteca de IRs (impulse responses de caixa e microfone): os arquivos carregados ficam guardados no
// aplicativo (IndexedDB, "ir:<id>"), fora dos projetos — dá para usar o mesmo IR em qualquer trilha ou
// projeto. A lista (id e nome) fica em "irlib".
import { useSyncExternalStore } from 'react';
import { fromRaw, idb, toRaw } from './persist';
import type { RawAudio } from './persist';

export interface IrEntry {
  id: string;
  name: string;
}

let list: IrEntry[] = [];
let loaded = false;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((f) => f());

async function save() {
  await idb('readwrite', (s) => s.put(list, 'irlib'));
  emit();
}

/** Lê a lista guardada (uma vez). */
export async function initIrLibrary() {
  if (loaded) return list;
  loaded = true;
  list = ((await idb('readonly', (s) => s.get('irlib'))) as IrEntry[] | undefined) ?? [];
  emit();
  return list;
}

/** A lista atual, para componentes React (atualiza sozinha). */
export function useIrLibrary(): IrEntry[] {
  return useSyncExternalStore(
    (f) => {
      listeners.add(f);
      void initIrLibrary();
      return () => listeners.delete(f);
    },
    () => list,
  );
}

const newId = () => `ir${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

/**
 * Decodifica e guarda arquivos de IR. Devolve as entradas novas e os erros (arquivo ilegível ou longo
 * demais para ser um IR).
 */
export async function addIrFiles(ctx: BaseAudioContext, files: File[], buffers: Map<string, AudioBuffer>) {
  await initIrLibrary();
  const added: IrEntry[] = [];
  const errors: string[] = [];
  for (const f of files) {
    let buf: AudioBuffer;
    try {
      buf = await ctx.decodeAudioData(await f.arrayBuffer());
    } catch {
      errors.push(`"${f.name}" não é um áudio que dê para ler.`);
      continue;
    }
    if (buf.duration > 3) {
      errors.push(`"${f.name}" tem ${buf.duration.toFixed(1)} s: parece uma música, não um IR (IRs de caixa têm menos de 1 s).`);
      continue;
    }
    const e = { id: newId(), name: f.name.replace(/\.[^.]+$/, '') };
    buffers.set(e.id, buf);
    await idb('readwrite', (s) => s.put(toRaw(buf), `ir:${e.id}`));
    added.push(e);
  }
  if (added.length) {
    list = [...list, ...added].sort((a, b) => a.name.localeCompare(b.name, 'pt'));
    await save();
  }
  return { added, errors };
}

/** Garante o áudio do IR na memória (lido da biblioteca se preciso). */
export async function loadIrBuffer(id: string, buffers: Map<string, AudioBuffer>): Promise<boolean> {
  if (buffers.has(id)) return true;
  const raw = (await idb('readonly', (s) => s.get(`ir:${id}`))) as RawAudio | undefined;
  if (!raw) return false;
  buffers.set(id, fromRaw(raw));
  return true;
}

/** Guarda na biblioteca um IR que veio de um projeto (ex.: carregado antes da biblioteca existir). */
export async function adoptIr(id: string, name: string, buf: AudioBuffer) {
  await initIrLibrary();
  if (list.some((e) => e.id === id)) return;
  await idb('readwrite', (s) => s.put(toRaw(buf), `ir:${id}`));
  list = [...list, { id, name }].sort((a, b) => a.name.localeCompare(b.name, 'pt'));
  await save();
}

export async function renameIr(id: string, name: string) {
  list = list.map((e) => (e.id === id ? { ...e, name } : e));
  await save();
}

/** Tira da biblioteca (trilhas que já usam o IR continuam com ele: o projeto guarda uma cópia). */
export async function deleteIr(id: string) {
  list = list.filter((e) => e.id !== id);
  await idb('readwrite', (s) => s.delete(`ir:${id}`));
  await save();
}
