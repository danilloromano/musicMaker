// Quantizar áudio: acha os ataques (o começo de cada nota/batida) e puxa cada um para a grade, cortando a
// região em fatias. Cada fatia vai do seu ataque até o próximo; se o próximo ataque chegou mais cedo, a
// fatia é encurtada (com um fade curto); se foi para depois, fica um silêncio pequeno no lugar (esticar a
// fatia faria o ataque seguinte soar duas vezes).
import { Project, Region, uid } from '../types';
import { onsetsOf } from './wsola';

/** Grades da quantização (em tempos). */
export const AUDIO_GRIDS: { beats: number; name: string }[] = [
  { beats: 1, name: '1/4' },
  { beats: 0.5, name: '1/8' },
  { beats: 1 / 3, name: '1/8 tercina' },
  { beats: 0.25, name: '1/16' },
];

const PRE = 0.003; // s: o corte fica um pouco antes do ataque (não corta o começo da nota)

/**
 * Ataques num trecho do áudio (segundos a partir de `from`). `sens` 0..1: quanto mais alto, mais ataques
 * fracos entram (notas ligadas, ghost notes).
 */
export function detectOnsets(buf: AudioBuffer, from: number, dur: number, sens = 0.5): number[] {
  const sr = buf.sampleRate;
  const a = Math.max(0, Math.floor(from * sr));
  const n = Math.min(buf.length - a, Math.floor(dur * sr));
  const chs = Array.from({ length: buf.numberOfChannels }, (_, c) => buf.getChannelData(c));
  return onsetsOf(chs, a, n, sr, sens).map((i) => i / sr);
}

/**
 * Quantiza a região de áudio `regionId`: os ataques vão para a grade (`grid` tempos), com `strength` (0..1)
 * do caminho. Devolve o projeto novo e quantas fatias a região virou.
 */
export function quantizeAudioRegion(
  p: Project,
  regionId: string,
  buf: AudioBuffer,
  grid: number,
  strength: number,
  sens = 0.5,
): { project: Project; slices: number } {
  const r = p.regions.find((x) => x.id === regionId);
  if (!r?.bufferId) return { project: p, slices: 0 };
  const bpm = p.bpm;
  const spb = 60 / bpm;
  const dur = r.duration ?? 0;
  const onsets = detectOnsets(buf, r.offset ?? 0, dur, sens).filter((t) => t > PRE && t < dur - 0.02);

  // pontos de corte: (posição no áudio da região, s) → (novo começo na timeline, tempos)
  const cuts: { src: number; at: number }[] = [{ src: 0, at: r.start }];
  for (const t of onsets) {
    const beat = r.start + t / spb;
    const target = Math.round(beat / grid) * grid;
    const at = Math.max(0, beat + (target - beat) * strength - PRE / spb);
    const prev = cuts[cuts.length - 1];
    // dois ataques que caem no mesmo lugar: fica o primeiro
    if (at <= prev.at + 0.02) continue;
    cuts.push({ src: t - PRE, at });
  }
  // a primeira fatia (antes do primeiro ataque) pode ter sido engolida pelo ataque puxado para trás
  if (cuts.length > 1 && cuts[1].at <= r.start + 1e-4) cuts.shift();

  const pieces: Region[] = [];
  cuts.forEach((c, i) => {
    const next = cuts[i + 1];
    const srcLen = (next ? next.src : dur) - c.src;
    const room = next ? (next.at - c.at) * spb : Infinity;
    const d = Math.min(srcLen, room);
    if (d < 0.005) return;
    const first = pieces.length === 0;
    pieces.push({
      ...r,
      id: first ? r.id : uid(),
      start: c.at,
      offset: (r.offset ?? 0) + c.src,
      duration: d,
      fadeIn: first ? r.fadeIn : 0.002,
      fadeOut: !next ? r.fadeOut : d < srcLen - 1e-4 ? 0.006 : 0.002,
    });
  });
  if (pieces.length <= 1 && onsets.length === 0) return { project: p, slices: 0 };
  return {
    project: { ...p, regions: p.regions.flatMap((x) => (x.id === r.id ? pieces : [x])) },
    slices: pieces.length,
  };
}
