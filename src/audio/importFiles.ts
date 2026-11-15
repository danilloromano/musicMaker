import { withLoading } from '../loading';
import { engine } from './engine';

/** Importa arquivos de áudio mostrando a nave; com vários arquivos, ela avança um trecho por arquivo. */
export function importFiles(files: File[], beat: number, trackId?: string) {
  if (!files.length) return Promise.resolve();
  const label = files.length === 1 ? `Importando "${files[0].name}"…` : `Importando ${files.length} arquivos de áudio…`;
  return withLoading(label, async (progress) => {
    for (let i = 0; i < files.length; i++) {
      await engine.importAudio(files[i], beat, trackId);
      if (files.length > 1) progress((i + 1) / files.length);
    }
  });
}
