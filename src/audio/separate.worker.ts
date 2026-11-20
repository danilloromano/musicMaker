// Worker da separação de instrumentos (alguns segundos por minuto de música).
import { separate } from './separate';

self.onmessage = (e: MessageEvent<{ L: Float32Array; R: Float32Array; sampleRate: number }>) => {
  const { L, R, sampleRate } = e.data;
  const post = (m: unknown, t: Transferable[] = []) => (self as unknown as Worker).postMessage(m, t);
  const s = separate(L, R, sampleRate, (p) => post({ progress: p }));
  post({ stems: s }, [s.drumsL.buffer, s.drumsR.buffer, s.bass.buffer, s.vocals.buffer]);
};
