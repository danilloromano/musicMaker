// Worker do esticamento de áudio (o cálculo leva alguns décimos de segundo por minuto de áudio).
import { wsola } from './wsola';

self.onmessage = (e: MessageEvent<{ id: number; channels: Float32Array[]; ratio: number; sampleRate: number }>) => {
  const { id, channels, ratio, sampleRate } = e.data;
  const out = wsola(channels, ratio, sampleRate);
  (self as unknown as Worker).postMessage({ id, channels: out }, out.map((c) => c.buffer));
};
