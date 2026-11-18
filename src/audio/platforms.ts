// Loudness por plataforma: cada serviço toca as músicas num volume de referência (normalização). Uma
// música mais alta que a referência é abaixada; mais baixa, depende do serviço — uns aumentam (até onde o
// pico deixa), outros não. Os valores são as referências publicadas pelos serviços e podem mudar.

/** Como a plataforma ajusta o volume: só abaixa, abaixa e aumenta (sem passar do pico), ou nada. */
export type NormMode = 'down' | 'both' | 'none';

export interface Platform {
  id: string;
  name: string;
  /** volume de referência (LUFS integrado); null = não normaliza */
  target: number | null;
  mode: NormMode;
  /** pico real recomendado (dBTP) */
  peak: number;
  note: string;
}

export const PLATFORMS: Platform[] = [
  { id: 'spotify', name: 'Spotify', target: -14, mode: 'both', peak: -1, note: 'Abaixa as mais altas; aumenta as mais baixas só até o pico chegar a −1 dBTP. Recomenda −2 dBTP para masters acima de −14 LUFS.' },
  { id: 'youtube', name: 'YouTube', target: -14, mode: 'down', peak: -1, note: 'Só abaixa: uma música mais baixa que −14 LUFS fica mais baixa que as outras.' },
  { id: 'apple', name: 'Apple Music', target: -16, mode: 'both', peak: -1, note: 'Sound Check: abaixa e aumenta (sem estourar o pico).' },
  { id: 'amazon', name: 'Amazon Music', target: -14, mode: 'down', peak: -1, note: 'Só abaixa.' },
  { id: 'deezer', name: 'Deezer', target: -15, mode: 'down', peak: -1, note: 'Só abaixa.' },
  { id: 'tidal', name: 'Tidal', target: -14, mode: 'down', peak: -1, note: 'Só abaixa (normaliza por álbum).' },
  { id: 'soundcloud', name: 'SoundCloud', target: null, mode: 'none', peak: -1, note: 'Não normaliza: a música toca no volume em que foi enviada.' },
  { id: 'podcast', name: 'Podcast', target: -16, mode: 'both', peak: -1, note: 'Referência comum dos agregadores de podcast (voz).' },
  { id: 'broadcast', name: 'Rádio e TV', target: -23, mode: 'both', peak: -1, note: 'EBU R128 (−23 LUFS), adotado por emissoras na Europa e no Brasil.' },
];

/** Serviços de música (onde masterizar alto demais só faz a música ser abaixada). */
const STREAMING = new Set(['spotify', 'youtube', 'apple', 'amazon', 'deezer', 'tidal']);

export type Verdict = 'ok' | 'quieter' | 'turned-down' | 'peak';

export interface PlatformResult {
  /** ajuste que a plataforma aplica (dB) */
  gain: number;
  /** volume e pico como a música vai tocar lá */
  playedLufs: number;
  playedPeak: number;
  verdict: Verdict;
  text: string;
}

const f1 = (v: number) => (Math.round(v * 10) / 10).toFixed(1).replace('.', ',').replace('-0,0', '0,0');

/** Como a música (`lufs` integrado, `truePeak` em dBTP) vai tocar na plataforma. */
export function onPlatform(lufs: number, truePeak: number, p: Platform): PlatformResult {
  let gain = 0;
  if (p.target !== null) {
    const want = p.target - lufs;
    if (want < 0 || p.mode === 'both') gain = want;
    if (gain > 0) gain = Math.max(0, Math.min(gain, p.peak - truePeak)); // aumentar só até o pico deixar
    if (p.mode === 'down') gain = Math.min(0, want);
  }
  const playedLufs = lufs + gain;
  const playedPeak = truePeak + gain;
  // Spotify recomenda mais folga de pico para masters altos (a conversão para o formato com perda cria picos)
  const peakMax = p.id === 'spotify' && lufs > -14 ? -2 : p.peak;
  let verdict: Verdict = 'ok';
  let text: string;
  if (truePeak > peakMax + 0.05) {
    verdict = 'peak';
    text = `Pico em ${f1(truePeak)} dBTP: acima de ${f1(peakMax)} pode distorcer quando a plataforma converte o arquivo.`;
  } else if (p.target !== null && playedLufs < p.target - 1) {
    verdict = 'quieter';
    text =
      p.mode === 'down'
        ? `Vai tocar ${f1(p.target - playedLufs)} dB mais baixa que as outras músicas (a plataforma não aumenta).`
        : `Vai tocar ${f1(p.target - playedLufs)} dB mais baixa: aumentar mais passaria do pico.`;
  } else if (gain < -3 && STREAMING.has(p.id)) {
    verdict = 'turned-down';
    text = `A plataforma abaixa ${f1(-gain)} dB: o volume extra só custou dinâmica (dá para masterizar menos alto).`;
  } else {
    text = p.target === null ? 'Toca como foi enviada (sem normalização).' : gain > 0.05 ? `No ponto (a plataforma aumenta ${f1(gain)} dB).` : gain < -0.05 ? `No ponto (a plataforma abaixa ${f1(-gain)} dB).` : 'No ponto.';
  }
  return { gain, playedLufs, playedPeak, verdict, text };
}
