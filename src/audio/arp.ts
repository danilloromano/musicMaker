// Arpejador: transforma as notas seguradas (um acorde) numa sequência de notas no ritmo da música.
// É um efeito da trilha: as notas gravadas continuam sendo o acorde, e o arpejo é gerado ao tocar.
import { Arp, ArpMode, Note, Region, Track } from '../types';

export const DEFAULT_ARP: Arp = { on: true, mode: 'up', rate: 0.25, octaves: 1, gate: 0.6 };

export const ARP_MODES: { id: ArpMode; name: string; title: string }[] = [
  { id: 'up', name: 'Sobe', title: 'Da nota mais grave para a mais aguda' },
  { id: 'down', name: 'Desce', title: 'Da mais aguda para a mais grave' },
  { id: 'updown', name: 'Sobe e desce', title: 'Sobe e volta descendo (sem repetir as pontas)' },
  { id: 'order', name: 'Ordem tocada', title: 'Na ordem em que as notas foram tocadas' },
  { id: 'random', name: 'Aleatório', title: 'Uma nota do acorde ao acaso a cada passo' },
  { id: 'chord', name: 'Acorde', title: 'O acorde inteiro repetido no ritmo (stabs)' },
];

export const ARP_RATES: { beats: number; name: string }[] = [
  { beats: 1, name: '1/4' },
  { beats: 0.5, name: '1/8' },
  { beats: 1 / 3, name: '1/8 tercina' },
  { beats: 0.25, name: '1/16' },
  { beats: 1 / 6, name: '1/16 tercina' },
  { beats: 0.125, name: '1/32' },
];

/** Uma nota segurada: altura, força e a ordem em que começou. */
export interface Held {
  pitch: number;
  vel: number;
  order: number;
}

/** "Aleatório" repetível: o mesmo passo sorteia sempre a mesma nota (a música toca igual toda vez). */
function hash(n: number) {
  let x = (n + 0x9e3779b9) | 0;
  x = Math.imul(x ^ (x >>> 16), 0x85ebca6b);
  x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35);
  return ((x ^ (x >>> 16)) >>> 0) / 4294967296;
}

/** Notas que soam no passo `count` (o contador recomeça quando todas as notas são soltas). */
export function arpStep(held: Held[], arp: Arp, count: number, seed: number): { pitch: number; vel: number }[] {
  if (!held.length) return [];
  const base = arp.mode === 'order' ? [...held].sort((a, b) => a.order - b.order) : [...held].sort((a, b) => a.pitch - b.pitch);
  if (arp.mode === 'chord') return base.map((h) => ({ pitch: h.pitch, vel: h.vel }));
  const octaves = Math.max(1, Math.min(4, Math.round(arp.octaves)));
  const ext: { pitch: number; vel: number }[] = [];
  for (let k = 0; k < octaves; k++) for (const h of base) if (h.pitch + 12 * k <= 127) ext.push({ pitch: h.pitch + 12 * k, vel: h.vel });
  let seq = ext;
  if (arp.mode === 'down') seq = [...ext].reverse();
  else if (arp.mode === 'updown' && ext.length > 2) seq = [...ext, ...ext.slice(1, -1).reverse()];
  if (arp.mode === 'random') return [seq[Math.floor(hash(seed) * seq.length)]];
  return [seq[count % seq.length]];
}

const EPS = 0.02; // tempos: nota que começa um tiquinho depois do passo (humanizada) ainda conta para ele

/** As notas de uma região arpejadas: a cada passo, olha quais notas estão seguradas e toca a da vez. */
export function arpeggiate(notes: Note[], arp: Arp, length: number): Note[] {
  const step = Math.max(1 / 16, arp.rate);
  const out: Note[] = [];
  const order = new Map([...notes].sort((a, b) => a.start - b.start || a.pitch - b.pitch).map((n, i) => [n.id, i]));
  let count = 0;
  for (let i = 0; i * step < length - 1e-6; i++) {
    const t = i * step;
    const held = notes
      .filter((n) => n.start <= t + EPS && n.start + n.duration > t + EPS && n.start < length)
      .map((n) => ({ pitch: n.pitch, vel: n.velocity, order: order.get(n.id) ?? 0 }));
    if (!held.length) {
      count = 0;
      continue;
    }
    // a mesma altura segurada duas vezes (notas sobrepostas) conta uma vez só
    const uniq = [...new Map(held.map((h) => [h.pitch, h])).values()];
    const dur = Math.min(step * Math.max(0.05, Math.min(1, arp.gate)), length - t);
    for (const n of arpStep(uniq, arp, count, i)) out.push({ id: `arp${i}:${n.pitch}`, pitch: n.pitch, start: t, duration: dur, velocity: n.vel });
    count++;
  }
  return out;
}

const cache = new WeakMap<Note[], { key: string; notes: Note[] }>();

/** As notas que a região toca de fato: arpejadas se a trilha (de instrumento) tem o arpejador ligado. */
export function playedNotes(r: Region, t: Track): Note[] {
  const notes = r.notes ?? [];
  const arp = t.arp;
  if (!arp?.on || t.kind !== 'instrument' || !notes.length) return notes;
  const key = `${arp.mode}|${arp.rate}|${arp.octaves}|${arp.gate}|${r.length}`;
  const hit = cache.get(notes);
  if (hit?.key === key) return hit.notes;
  const out = arpeggiate(notes, arp, r.length);
  cache.set(notes, { key, notes: out });
  return out;
}
