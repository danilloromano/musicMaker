// Ponte entre arquivos MIDI e o projeto: exportar as notas da música e importar um .mid como trilhas.
import { newTrack, useStore } from '../store';
import { Region, Track, barBeats, uid } from '../types';
import { playedNotes } from './arp';
import { PRESETS } from './instruments';
import { MidiTrackOut, instrumentOfGm, parseMidi, writeMidi } from './midiFile';
import { download } from './persist';

/**
 * Exporta a música em MIDI: as notas como tocam (seguindo a trilha de acordes e o arpejador), uma trilha
 * por trilha de instrumento/bateria. Trilhas de áudio não entram (não têm notas). Devolve quantas trilhas foram.
 */
export function exportMidi(): number {
  const p = useStore.getState().project;
  const out: MidiTrackOut[] = [];
  for (const t of p.tracks) {
    if (t.kind !== 'instrument' && t.kind !== 'drums') continue;
    const notes = p.regions
      .filter((r) => r.trackId === t.id && r.notes?.length)
      .flatMap((r) =>
        playedNotes(r, t, p.bpm, p.chords)
          .filter((n) => n.start < r.length)
          .map((n) => ({ pitch: n.pitch, start: r.start + n.start, duration: Math.min(n.duration, r.length - n.start), velocity: n.velocity })),
      );
    if (notes.length) out.push({ name: t.name, drums: t.kind === 'drums', instrument: t.instrument, volume: t.volume, pan: t.pan, notes });
  }
  if (!out.length) return 0;
  const bytes = writeMidi(p, out);
  download(new Blob([bytes], { type: 'audio/midi' }), `${p.name || 'musica'}.mid`);
  return out.length;
}

/**
 * Importa um arquivo .mid a partir de \`beat\` (o começo do arquivo cai ali). Cada parte vira uma trilha
 * (bateria no canal 10, os outros com o instrumento mais parecido). Num projeto vazio, o andamento, o
 * compasso e os marcadores vêm do arquivo. Soltar um MIDI de uma parte só numa trilha de instrumento põe as
 * notas nela. Tudo vira um único passo de desfazer.
 */
export async function importMidi(file: File, beat: number, trackId?: string) {
  let song;
  try {
    song = parseMidi(await file.arrayBuffer());
  } catch (e) {
    alert(`Não foi possível ler "${file.name}" como MIDI: ${(e as Error).message}.`);
    return;
  }
  if (!song.parts.length) {
    alert(`"${file.name}" não tem notas.`);
    return;
  }
  const st = useStore.getState();
  const p0 = st.project;
  const empty = !p0.tracks.length && !p0.regions.length;
  const base = file.name.replace(/\.[^.]+$/, '');
  const target = p0.tracks.find((t) => t.id === trackId);

  st.update((p) => {
    const meter = empty ? song.meter ?? p.meter : p.meter;
    const bb = barBeats({ meter });
    const at = empty ? 0 : Math.max(0, beat);
    const tracks: Track[] = [...p.tracks];
    const regions: Region[] = [...p.regions];
    const single = song.parts.length === 1;
    for (const part of song.parts) {
      // nome: o da trilha no arquivo; um MIDI de uma parte sem nome leva o nome do arquivo
      const name = single && part.name.startsWith('MIDI') ? base : part.name;
      // MIDI de uma parte só solto numa trilha do mesmo tipo: entra nela
      const into = single && target && (target.kind === 'drums') === part.drums && target.kind !== 'audio' && target.kind !== 'bus' ? target : null;
      let t = into;
      if (!t) {
        const inst = part.drums ? 'drums' : instrumentOfGm(part.program);
        t = newTrack(part.drums ? 'drums' : 'instrument', tracks.length, {
          name,
          ...(part.drums ? {} : { instrument: PRESETS[inst] ? inst : 'grand' }),
        });
        tracks.push(t);
      }
      const end = Math.max(...part.notes.map((n) => n.start + n.duration));
      const length = Math.max(bb, Math.ceil(end / bb - 1e-6) * bb);
      regions.push({
        id: uid(),
        trackId: t.id,
        name: single ? base : name,
        start: at,
        length,
        notes: part.notes.map((n) => ({ ...n, id: uid() })),
      });
    }
    return {
      ...p,
      ...(empty && song.bpm ? { bpm: Math.max(40, Math.min(240, Math.round(song.bpm))) } : {}),
      ...(empty ? { meter: meter && (meter.num !== 4 || meter.den !== 4) ? meter : undefined } : {}),
      ...(empty && song.markers.length ? { markers: song.markers.map((m) => ({ id: uid(), beat: m.beat, name: m.name })) } : {}),
      tracks,
      regions,
    };
  });
  const added = useStore.getState().project.tracks.slice(p0.tracks.length);
  useStore.getState().set({ selectedTrackId: added[0]?.id ?? trackId ?? null });
}
