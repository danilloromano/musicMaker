// Takes e comping: várias passadas gravadas no mesmo trecho de uma trilha de áudio, e a montagem da versão
// final (o "comp") escolhendo o melhor pedaço de cada uma.
//
// Cada gravação é um take numerado (`Region.take`). O que toca fica em `project.regions`, como qualquer
// região; os pedaços dos takes que não estão em uso ficam guardados em `project.takes` (fora da
// reprodução, da exportação e do congelamento). Escolher um trecho de um take divide as regiões nas bordas
// do trecho: o pedaço daquele take entra no comp e os pedaços dos outros saem para a gaveta.
import { Project, Region, fitFades, uid } from '../types';

const EPS = 1e-6;

const endOf = (r: Region, bpm: number) => r.start + ((r.duration ?? 0) * bpm) / 60;
const isAudioOf = (trackId: string) => (r: Region) => r.trackId === trackId && !!r.bufferId;

/** Corta uma região de áudio no tempo `beat` (estritamente dentro dela): esquerda e direita, sem fade no corte. */
function cut(r: Region, beat: number, bpm: number): [Region, Region] {
  const sec = ((beat - r.start) * 60) / bpm;
  const left = fitFades({ ...r, duration: sec, fadeOut: 0 });
  const right = fitFades({ ...r, id: uid(), start: beat, offset: (r.offset ?? 0) + sec, duration: (r.duration ?? 0) - sec, fadeIn: 0 });
  return [left, right];
}

/** Divide `r` em antes / dentro / depois do trecho [a, b]. */
function pieces(r: Region, a: number, b: number, bpm: number) {
  let rest: Region | undefined = r;
  let before: Region | undefined, after: Region | undefined;
  if (a > r.start + EPS && a < endOf(r, bpm) - EPS) [before, rest] = cut(r, a, bpm);
  else if (a >= endOf(r, bpm) - EPS) return { before: r };
  if (rest && b > rest.start + EPS && b < endOf(rest, bpm) - EPS) [rest, after] = cut(rest, b, bpm);
  else if (rest && b <= rest.start + EPS) return { before, after: rest };
  return { before, inside: rest, after };
}

/** Junta pedaços vizinhos do mesmo take que continuam o mesmo áudio (sobram depois de várias escolhas). */
function merge(list: Region[], bpm: number): Region[] {
  const out: Region[] = [];
  for (const r of [...list].sort((x, y) => x.start - y.start)) {
    const prev = out[out.length - 1];
    if (
      prev &&
      prev.trackId === r.trackId &&
      prev.bufferId === r.bufferId &&
      prev.take === r.take &&
      (prev.gain ?? 1) === (r.gain ?? 1) &&
      Math.abs(endOf(prev, bpm) - r.start) < 1e-4 &&
      Math.abs((prev.offset ?? 0) + (prev.duration ?? 0) - (r.offset ?? 0)) < 1e-4
    ) {
      out[out.length - 1] = { ...prev, duration: (prev.duration ?? 0) + (r.duration ?? 0), fadeOut: r.fadeOut };
    } else out.push(r);
  }
  return out;
}

/** Números dos takes de uma trilha (em uso ou guardados), em ordem. */
export function trackTakes(p: Project, trackId: string): number[] {
  const all = [...p.regions, ...(p.takes ?? [])].filter(isAudioOf(trackId));
  return [...new Set(all.map((r) => r.take).filter((n): n is number => n !== undefined))].sort((a, b) => a - b);
}

/** Pedaços do take `n` (em uso e guardados), com a marca de qual está tocando. */
export function takePieces(p: Project, trackId: string, n: number): { region: Region; active: boolean }[] {
  return [
    ...p.regions.filter((r) => isAudioOf(trackId)(r) && r.take === n).map((region) => ({ region, active: true })),
    ...(p.takes ?? []).filter((r) => r.trackId === trackId && r.take === n).map((region) => ({ region, active: false })),
  ].sort((x, y) => x.region.start - y.region.start);
}

/** Trecho que o take ocupa na timeline (do começo do primeiro pedaço ao fim do último). */
export function takeSpan(p: Project, trackId: string, n: number): [number, number] | null {
  const ps = takePieces(p, trackId, n);
  if (!ps.length) return null;
  return [Math.min(...ps.map((x) => x.region.start)), Math.max(...ps.map((x) => endOf(x.region, p.bpm)))];
}

/** Regiões de áudio da trilha ainda sem número de take viram takes (cada arquivo de áudio, um take). */
function numberUntagged(p: Project, trackId: string, only?: (r: Region) => boolean): Project {
  const untagged = p.regions.filter((r) => isAudioOf(trackId)(r) && r.take === undefined && (!only || only(r)));
  if (!untagged.length) return p;
  let next = Math.max(0, ...trackTakes(p, trackId)) + 1;
  const num = new Map<string, number>();
  for (const r of [...untagged].sort((a, b) => a.start - b.start)) if (!num.has(r.bufferId!)) num.set(r.bufferId!, next++);
  return {
    ...p,
    regions: p.regions.map((r) => (untagged.includes(r) ? { ...r, take: num.get(r.bufferId!), name: `Take ${num.get(r.bufferId!)}` } : r)),
  };
}

/**
 * Comp: no trecho [a, b], passa a tocar o take `n` (onde ele tem áudio) e os outros takes saem desse trecho
 * (ficam guardados). Fora do trecho nada muda.
 */
export function compRange(p: Project, trackId: string, n: number, a: number, b: number): Project {
  if (b - a < EPS) return p;
  const bpm = p.bpm;
  let active = p.regions.filter(isAudioOf(trackId));
  let stored = (p.takes ?? []).filter((r) => r.trackId === trackId);
  // trechos onde o take n tem áudio, dentro de [a, b]
  const segs = [...active, ...stored]
    .filter((r) => r.take === n && r.start < b - EPS && endOf(r, bpm) > a + EPS)
    .map((r) => [Math.max(a, r.start), Math.min(b, endOf(r, bpm))] as [number, number]);
  if (!segs.length) return p;
  for (const [s, e] of segs) {
    const nextActive: Region[] = [];
    const nextStored: Region[] = [];
    for (const [list, wasActive] of [[active, true], [stored, false]] as const) {
      for (const r of list) {
        if (r.start >= e - EPS || endOf(r, bpm) <= s + EPS) {
          (wasActive ? nextActive : nextStored).push(r);
          continue;
        }
        const { before, inside, after } = pieces(r, s, e, bpm);
        for (const x of [before, after]) if (x) (wasActive ? nextActive : nextStored).push(x);
        if (inside) (inside.take === n ? nextActive : nextStored).push(inside);
      }
    }
    active = nextActive;
    stored = nextStored;
  }
  const keep = (r: Region) => !isAudioOf(trackId)(r);
  return {
    ...p,
    regions: [...p.regions.filter(keep), ...merge(active, bpm)],
    takes: [...(p.takes ?? []).filter((r) => r.trackId !== trackId), ...merge(stored, bpm)],
  };
}

/** Usa o take `n` inteiro (onde ele tem áudio, os outros saem). */
export function pickWholeTake(p: Project, trackId: string, n: number): Project {
  const span = takeSpan(p, trackId, n);
  return span ? compRange(p, trackId, n, span[0], span[1]) : p;
}

/**
 * Apaga o take `n`. Onde ele estava tocando, entra o take mais recente que tem áudio ali (para o comp não
 * ficar com buracos).
 */
export function deleteTake(p: Project, trackId: string, n: number): Project {
  const holes = p.regions.filter((r) => isAudioOf(trackId)(r) && r.take === n).map((r) => [r.start, endOf(r, p.bpm)] as const);
  let out: Project = {
    ...p,
    regions: p.regions.filter((r) => !(isAudioOf(trackId)(r) && r.take === n)),
    takes: (p.takes ?? []).filter((r) => !(r.trackId === trackId && r.take === n)),
  };
  const others = trackTakes(out, trackId).reverse();
  for (const [s, e] of holes) {
    for (const m of others) {
      // preenche só o que ainda está vazio: do mais novo para o mais velho
      const free = gaps(out, trackId, s, e);
      for (const [gs, ge] of free) out = compRange(out, trackId, m, gs, ge);
    }
  }
  return out;
}

/** Partes de [s, e] em que a trilha não tem áudio tocando. */
function gaps(p: Project, trackId: string, s: number, e: number): [number, number][] {
  const busy = p.regions
    .filter((r) => isAudioOf(trackId)(r) && r.start < e && endOf(r, p.bpm) > s)
    .map((r) => [r.start, endOf(r, p.bpm)] as const)
    .sort((x, y) => x[0] - y[0]);
  const out: [number, number][] = [];
  let at = s;
  for (const [a, b] of busy) {
    if (a > at + EPS) out.push([at, a]);
    at = Math.max(at, b);
  }
  if (at < e - EPS) out.push([at, e]);
  return out;
}

/** Descarta os pedaços guardados (fica só o comp que está tocando). */
export function clearUnusedTakes(p: Project, trackId: string): Project {
  return { ...p, takes: (p.takes ?? []).filter((r) => r.trackId !== trackId) };
}

/**
 * Gravações novas viram takes: o áudio que já estava no trecho vira take também (se ainda não era), e cada
 * passada nova entra no comp por cima do que havia (a última passada fica tocando).
 */
export function addRecordedTakes(p: Project, trackId: string, recs: Region[]): Project {
  if (!recs.length) return p;
  const bpm = p.bpm;
  const lo = Math.min(...recs.map((r) => r.start));
  const hi = Math.max(...recs.map((r) => endOf(r, bpm)));
  let out = numberUntagged(p, trackId, (r) => r.start < hi && endOf(r, bpm) > lo);
  let next = Math.max(0, ...trackTakes(out, trackId)) + 1;
  for (const rec of recs) {
    const n = next++;
    const r: Region = { ...rec, id: uid(), trackId, take: n, name: `Take ${n}` };
    // entra guardado e é escolhido no trecho dele (isso tira o que estava por baixo)
    out = { ...out, takes: [...(out.takes ?? []), r] };
    out = compRange(out, trackId, n, r.start, endOf(r, bpm));
  }
  return out;
}
