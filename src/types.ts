/** 'bus' = trilha de grupo: não tem regiões; outras trilhas mandam a saída para ela (ver Track.output). */
export type TrackKind = 'instrument' | 'drums' | 'audio' | 'bus';

export interface Note {
  id: string;
  pitch: number; // número MIDI
  start: number; // em tempos (beats), relativo ao início da região
  duration: number; // em tempos
  velocity: number; // 1..127
}

export interface Region {
  id: string;
  trackId: string;
  name: string;
  start: number; // em tempos, posição na timeline
  // regiões MIDI
  length: number; // em tempos
  notes?: Note[];
  // regiões de áudio
  bufferId?: string;
  offset?: number; // segundos dentro do buffer
  duration?: number; // segundos
  gain?: number; // volume da região (linear, 1 = original)
  fadeIn?: number; // segundos
  fadeOut?: number; // segundos
}

/** Trecho tocado em repetição (em tempos). */
export interface LoopRange {
  start: number;
  end: number;
  on: boolean;
}

export interface TrackFx {
  /** EQ antigo (graves/médios/agudos fixos): só vale enquanto `eq` não existir */
  low: number; // dB
  mid: number;
  high: number;
  reverb: number; // 0..1
  delay: number; // 0..1
  /** compressor antigo (liga/desliga): só vale enquanto `compressor` não existir */
  comp: boolean;
  /** EQ paramétrico (ver trackfx.ts: eqOf converte os projetos antigos) */
  eq?: TrackEq;
  /** compressor completo (ver trackfx.ts: compOf) */
  compressor?: TrackComp;
  /** sidechain: outra trilha abaixa o volume desta (ex.: o bumbo abaixando o baixo) */
  sidechain?: Sidechain;
}

/** O volume desta trilha cai quando a trilha `source` toca ("ducking"/bombeado). */
export interface Sidechain {
  source: string | null;
  /** quanto abaixa no máximo (dB) */
  depth: number;
  /** sensibilidade (0 a 1): quanto sinal da origem basta para abaixar tudo */
  sens: number;
  /** tempo para voltar (ms) */
  release: number;
}

/** Ponto de automação: valor do parâmetro (na unidade dele) num tempo da música. */
export interface AutoPoint {
  beat: number;
  value: number;
}

/** Automação de um parâmetro: 'volume', 'pan' ou 'send:<id do envio>'. */
export interface AutoLane {
  param: string;
  points: AutoPoint[];
}

/** Efeito de envio (reverb ou delay) compartilhado: cada trilha decide quanto manda para ele. */
export interface SendFx {
  id: string;
  name: string;
  type: 'reverb' | 'delay';
  /** volume do retorno (0 a 1) */
  level: number;
  reverb?: { space: 'room' | 'hall' | 'plate' | 'cathedral'; predelay: number; tone: number };
  delay?: { division: '1/4' | '1/8' | '1/8d' | '1/16' | '1/4t' | '1/8t'; feedback: number; tone: number; pingpong: boolean };
}

/** Banda do EQ: frequência (Hz), ganho (dB) e Q (largura; as prateleiras ignoram). */
export interface EqBand {
  on: boolean;
  freq: number;
  gain: number;
  q: number;
}

export interface TrackEq {
  /** passa-altas: corta abaixo da frequência, 12 ou 24 dB por oitava */
  hp: { on: boolean; freq: number; slope: 12 | 24 };
  /** passa-baixas: corta acima da frequência */
  lp: { on: boolean; freq: number };
  /** prateleira de graves, médio 1, médio 2, prateleira de agudos */
  bands: EqBand[];
}

/** Compressor: limiar e joelho (dB), razão, ataque e recuperação (ms), compensação (dB). */
export interface TrackComp {
  on: boolean;
  threshold: number;
  ratio: number;
  attack: number;
  release: number;
  knee: number;
  makeup: number;
}

/** Um pedal da pedaleira: ligado/desligado e os botões (0..1, na ordem definida em amp.ts). */
export interface PedalState {
  on: boolean;
  p: number[];
}

/** Rack de guitarra/baixo: pedais → amplificador → caixa (impulse response) → pedais de modulação/tempo. */
export interface AmpRig {
  on: boolean;
  pedals: Record<string, PedalState>;
  amp: string; // modelo do amplificador ('none' = sem amp)
  knobs: { gain: number; bass: number; mid: number; treble: number; presence: number; master: number }; // 0..1
  cab: string; // caixa: 'none', uma das embutidas ou 'user' (IR carregado pelo usuário)
  cabMix: number; // 0..1
  irId?: string; // buffer do IR do usuário
  irName?: string;
}

export interface Track {
  id: string;
  name: string;
  kind: TrackKind;
  instrument: string;
  volume: number; // 0..1
  pan: number; // -1..1
  mute: boolean;
  solo: boolean;
  color: string;
  fx: TrackFx;
  amp?: AmpRig;
  /** grupo para onde vai a saída (id de uma trilha 'bus'); ausente = master */
  output?: string;
  /** quanto vai para cada efeito de envio (0 a 1); os antigos fx.reverb/fx.delay valem para 'reverb'/'delay' */
  sends?: Record<string, number>;
  automation?: AutoLane[];
  /** parâmetro mostrado na faixa de automação da timeline (ausente = faixa fechada) */
  autoView?: string;
}

/** Master: EQ, compressor de "cola", saturação, limitador e como exportar. */
export interface MasterSettings {
  /** dB: graves (prateleira 100 Hz), médio-graves (400 Hz), presença (3 kHz), brilho (prateleira 10 kHz) */
  eq: { low: number; lowMid: number; highMid: number; high: number };
  /** limiar (dB), razão, ataque e recuperação (ms), ganho de compensação (dB) */
  comp: { on: boolean; threshold: number; ratio: number; attack: number; release: number; makeup: number };
  /** saturação suave (0 a 1) */
  saturation: number;
  /** ganho de entrada (dB), teto de pico real (dBTP), recuperação (ms) */
  limiter: { on: boolean; gain: number; ceiling: number; release: number };
  /** alvo de loudness da exportação (ver EXPORT_TARGETS) */
  exportTarget: 'none' | 'streaming' | 'apple' | 'loud';
  exportBits: 16 | 24;
  /** compressor multibanda: cortes graves/médios e agudos (Hz) e limiar/razão/ganho de cada banda */
  multiband?: { on: boolean; lowFreq: number; highFreq: number; bands: { threshold: number; ratio: number; gain: number }[] };
  /** imagem estéreo: largura (0 = mono, 1 = original, 2 = aberto) e graves em mono abaixo de monoFreq */
  stereo?: { width: number; monoBass: boolean; monoFreq: number };
  /** formato do arquivo exportado (os dois com codificador próprio, sem bibliotecas de terceiros) */
  exportFormat?: 'wav' | 'flac';
}

export interface Project {
  name: string;
  bpm: number;
  metronome: boolean;
  loop?: LoopRange;
  tracks: Track[];
  regions: Region[];
  /** ajustes do master (projetos antigos não têm: usam o padrão) */
  master?: MasterSettings;
  /** efeitos de envio (projetos antigos não têm: reverb + delay padrão) */
  sends?: SendFx[];
  /** música de referência para comparar (A/B) com a mix */
  reference?: { bufferId: string; name: string };
}

export const BEATS_PER_BAR = 4;

export const uid = () => Math.random().toString(36).slice(2, 10);

/** Comprimento da região em tempos (áudio depende do BPM). */
export function regionLen(r: Region, bpm: number): number {
  return r.bufferId ? ((r.duration ?? 0) * bpm) / 60 : r.length;
}

/** Mantém os fades de uma região de áudio dentro da duração dela (sem se sobreporem). */
export function fitFades(r: Region): Region {
  if (!r.bufferId) return r;
  const d = r.duration ?? 0;
  const fadeIn = Math.min(Math.max(0, r.fadeIn ?? 0), d);
  const fadeOut = Math.min(Math.max(0, r.fadeOut ?? 0), d - fadeIn);
  return fadeIn === (r.fadeIn ?? 0) && fadeOut === (r.fadeOut ?? 0) ? r : { ...r, fadeIn, fadeOut };
}

/** Volume (linear) de uma região de áudio a `x` segundos do início dela, com ganho e fades. */
export function regionGainAt(r: Region, x: number): number {
  const d = r.duration ?? 0;
  const fi = r.fadeIn ?? 0;
  const fo = r.fadeOut ?? 0;
  let g = r.gain ?? 1;
  if (fi > 0 && x < fi) g *= Math.max(0, x / fi);
  if (fo > 0 && x > d - fo) g *= Math.max(0, (d - x) / fo);
  return g;
}

export function projectEnd(p: Project): number {
  return p.regions.reduce((m, r) => Math.max(m, r.start + regionLen(r, p.bpm)), 0);
}
