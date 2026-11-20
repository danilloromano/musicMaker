import { withLoading } from '../loading';
import { engine } from './engine';
import { importMidi } from './midiProject';

const isMidi = (f: File) => /\.(mid|midi|kar)$/i.test(f.name) || f.type === 'audio/midi' || f.type === 'audio/x-midi';

/**
 * Importa arquivos de áudio e MIDI mostrando a nave; com vários arquivos, ela avança um trecho por arquivo.
 * MIDI vira trilhas de instrumento/bateria com as notas; áudio vira regiões de áudio.
 */
export function importFiles(files: File[], beat: number, trackId?: string) {
  if (!files.length) return Promise.resolve();
  const label = files.length === 1 ? `Importando "${files[0].name}"…` : `Importando ${files.length} arquivos…`;
  return withLoading(label, async (progress) => {
    for (let i = 0; i < files.length; i++) {
      if (isMidi(files[i])) await importMidi(files[i], beat, trackId);
      else await engine.importAudio(files[i], beat, trackId);
      if (files.length > 1) progress((i + 1) / files.length);
    }
  });
}
