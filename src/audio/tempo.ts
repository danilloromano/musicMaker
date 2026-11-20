// Áudio que segue o andamento: ao mudar o BPM, as regiões de áudio esticam/encolhem junto (sem mudar a
// altura) e continuam no mesmo lugar da grade.
//
// Cada região guarda o áudio original (`src.bufferId`) e quanto ele precisa ser esticado (`src.ratio`,
// duração nova ÷ original). O áudio esticado é sempre feito a partir do original (mudar o BPM várias vezes
// não acumula perdas) e fica guardado com um id que diz de onde veio e quanto foi esticado; `bufRatio` diz
// quanto o áudio que a região usa agora (`bufferId`) já está esticado.
import { Project, Region } from '../types';
import { wsola } from './wsola';

/** Precisa (re)esticar: o áudio que a região usa não está na proporção pedida. */
export const needsStretch = (r: Region) => !!r.src && Math.abs((r.bufRatio ?? 1) - r.src.ratio) > 1e-6;

/** Id do áudio esticado: o original na proporção 1. */
export const stretchedId = (src: string, ratio: number) => (Math.abs(ratio - 1) < 1e-6 ? src : `${src}~${ratio.toFixed(6)}`);

/**
 * Muda o andamento do projeto para `bpm` levando o áudio junto: cada região de áudio (que segue o
 * andamento) continua começando no mesmo tempo da grade e dura os mesmos tempos — em segundos, encolhe ou
 * estica (o áudio de verdade é refeito depois, em segundo plano).
 */
export function retimeAudio(p: Project, bpm: number): Project {
  if (bpm === p.bpm) return p;
  const f = p.bpm / bpm; // segundos novos por segundo antigo
  const fix = (r: Region): Region => {
    if (!r.bufferId || r.fixedTempo) return r;
    return {
      ...r,
      offset: (r.offset ?? 0) * f,
      duration: (r.duration ?? 0) * f,
      fadeIn: r.fadeIn && r.fadeIn * f,
      fadeOut: r.fadeOut && r.fadeOut * f,
      src: { bufferId: r.src?.bufferId ?? r.bufferId, ratio: (r.src?.ratio ?? 1) * f },
    };
  };
  return { ...p, bpm, regions: p.regions.map(fix), takes: p.takes?.map(fix) };
}

/** Troca, nas regiões que esperavam por ele, o áudio pelo esticado (`id`, feito de `src` na proporção `ratio`). */
export function applyStretched(p: Project, src: string, ratio: number, id: string): Project {
  const fix = (r: Region): Region =>
    r.src?.bufferId === src && Math.abs(r.src.ratio - ratio) < 1e-6 && r.bufferId !== id ? { ...r, bufferId: id, bufRatio: ratio } : r;
  return { ...p, regions: p.regions.map(fix), takes: p.takes?.map(fix) };
}

// ---------- esticar (num worker) ----------

let worker: Worker | null | undefined;
let seq = 0;
const waiting = new Map<number, (ch: Float32Array[]) => void>();

function getWorker(): Worker | null {
  if (worker !== undefined) return worker;
  try {
    worker = new Worker(new URL('./stretch.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (e: MessageEvent<{ id: number; channels: Float32Array[] }>) => {
      waiting.get(e.data.id)?.(e.data.channels);
      waiting.delete(e.data.id);
    };
  } catch {
    worker = null;
  }
  return worker;
}

/** Áudio esticado para durar `ratio` vezes o original, na mesma altura. */
export async function stretchBuffer(buf: AudioBuffer, ratio: number): Promise<AudioBuffer> {
  const input = Array.from({ length: buf.numberOfChannels }, (_, c) => buf.getChannelData(c).slice());
  const w = getWorker();
  const out = w
    ? await new Promise<Float32Array[]>((resolve) => {
        const id = ++seq;
        waiting.set(id, resolve);
        w.postMessage({ id, channels: input, ratio, sampleRate: buf.sampleRate }, input.map((c) => c.buffer));
      })
    : wsola(input, ratio, buf.sampleRate);
  const res = new AudioBuffer({ length: out[0].length, numberOfChannels: out.length, sampleRate: buf.sampleRate });
  out.forEach((c, i) => res.getChannelData(i).set(c));
  return res;
}
