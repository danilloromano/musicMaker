// Cadeia de master: EQ → compressor de "cola" → saturação → limitador de pico real (+ medidores).
// Ao vivo o limitador e os medidores rodam num AudioWorklet; na exportação o limitador roda depois da
// renderização (ver export.ts), para poder acertar o alvo de loudness.
import { driveCurve } from './fxutil';
import { MultibandComp, StereoImager } from './multiband';
import workletUrl from './dsp/master.worklet.ts?worker&url';
import type { MasterReading, MasterWorkletSettings } from './dsp/master.worklet';
import type { MasterSettings } from '../types';

export type { MasterReading };

export const DEFAULT_MULTIBAND: NonNullable<MasterSettings['multiband']> = {
  on: false,
  lowFreq: 150,
  highFreq: 3000,
  bands: [
    { threshold: -20, ratio: 2.5, gain: 0 },
    { threshold: -18, ratio: 2, gain: 0 },
    { threshold: -20, ratio: 2, gain: 0 },
  ],
};
export const DEFAULT_STEREO: NonNullable<MasterSettings['stereo']> = { width: 1, monoBass: false, monoFreq: 120 };

export const DEFAULT_MASTER: MasterSettings = {
  eq: { low: 0, lowMid: 0, highMid: 0, high: 0 },
  comp: { on: false, threshold: -18, ratio: 2, attack: 30, release: 200, makeup: 0 },
  saturation: 0,
  limiter: { on: true, gain: 0, ceiling: -1, release: 120 },
  exportTarget: 'none',
  exportBits: 24,
  multiband: DEFAULT_MULTIBAND,
  stereo: DEFAULT_STEREO,
  exportFormat: 'wav',
  exportKbps: 320,
};

/** Ajustes do master do projeto, com os campos que projetos antigos não têm preenchidos pelo padrão. */
export function masterOf(m?: MasterSettings): Required<MasterSettings> {
  const full = { ...DEFAULT_MASTER, ...m } as Required<MasterSettings>;
  // formato desconhecido: exporta em WAV
  if (!['wav', 'flac', 'mp3'].includes(full.exportFormat)) full.exportFormat = 'wav';
  if (![128, 192, 256, 320].includes(full.exportKbps)) full.exportKbps = 320;
  return full;
}

/** Alvos de loudness da exportação (LUFS integrado). */
export const EXPORT_TARGETS: { id: MasterSettings['exportTarget']; label: string; lufs: number | null }[] = [
  { id: 'none', label: 'Sem alvo (usa o ajuste do limitador)', lufs: null },
  { id: 'streaming', label: 'Spotify / YouTube / Deezer (-14 LUFS)', lufs: -14 },
  { id: 'apple', label: 'Apple Music (-16 LUFS)', lufs: -16 },
  { id: 'loud', label: 'Alto: CD, pista (-9 LUFS)', lufs: -9 },
];

type Preset = Omit<MasterSettings, 'exportTarget' | 'exportBits' | 'exportFormat'>;

/** Multibanda segurando só os graves (grave firme, sem embolar): `thr` dB, razão `ratio`, corte em `freq` Hz. */
const tightLows = (thr: number, ratio: number, freq = 150): NonNullable<MasterSettings['multiband']> => ({
  ...DEFAULT_MULTIBAND,
  on: true,
  lowFreq: freq,
  bands: [{ threshold: thr, ratio, gain: 0 }, DEFAULT_MULTIBAND.bands[1], DEFAULT_MULTIBAND.bands[2]],
});
const stereo = (width: number, monoFreq?: number): NonNullable<MasterSettings['stereo']> => ({
  width,
  monoBass: monoFreq !== undefined,
  monoFreq: monoFreq ?? DEFAULT_STEREO.monoFreq,
});

/**
 * O que um preset muda no master: tudo menos a exportação. Multibanda e imagem estéreo que o preset não
 * define voltam ao padrão (desligado / largura original), para o estilo anterior não ficar "grudado".
 */
export function applyPreset(m: MasterSettings, s: Preset): MasterSettings {
  return { ...m, multiband: DEFAULT_MULTIBAND, stereo: DEFAULT_STEREO, ...s };
}

/** O preset que está valendo agora (todos os ajustes iguais), se houver. */
export function activePreset(m: MasterSettings) {
  const pick = (x: MasterSettings) => JSON.stringify([x.eq, x.comp, x.saturation, x.limiter, x.multiband ?? DEFAULT_MULTIBAND, x.stereo ?? DEFAULT_STEREO]);
  const now = pick(m);
  return MASTER_PRESETS.find((p) => pick(applyPreset(m, p.s)) === now);
}
export const MASTER_PRESETS: { id: string; name: string; desc: string; s: Preset }[] = [
  {
    id: 'neutral', name: 'Neutro', desc: 'Só o limitador protegendo os picos',
    s: { eq: { low: 0, lowMid: 0, highMid: 0, high: 0 }, comp: { ...DEFAULT_MASTER.comp, on: false }, saturation: 0, limiter: { on: true, gain: 0, ceiling: -1, release: 120 } },
  },
  {
    id: 'pop', name: 'Pop alto', desc: 'Brilhante, encorpado e alto',
    s: {
      eq: { low: 1.5, lowMid: -1, highMid: 1, high: 2 },
      comp: { on: true, threshold: -18, ratio: 2, attack: 30, release: 200, makeup: 1 },
      saturation: 0.2,
      limiter: { on: true, gain: 3, ceiling: -1, release: 80 },
    },
  },
  {
    id: 'acoustic', name: 'Acústico', desc: 'Natural, com dinâmica preservada',
    s: {
      eq: { low: 0, lowMid: -0.5, highMid: 0.5, high: 1 },
      comp: { on: true, threshold: -20, ratio: 1.5, attack: 50, release: 300, makeup: 0.5 },
      saturation: 0,
      limiter: { on: true, gain: 0, ceiling: -1, release: 150 },
    },
  },
  {
    id: 'electronic', name: 'Eletrônico', desc: 'Grave forte, agudos abertos, bem alto',
    s: {
      eq: { low: 2.5, lowMid: -1.5, highMid: 0.5, high: 2.5 },
      comp: { on: true, threshold: -16, ratio: 3, attack: 10, release: 120, makeup: 2 },
      saturation: 0.3,
      limiter: { on: true, gain: 4, ceiling: -1, release: 50 },
    },
  },
  {
    id: 'lofi', name: 'Lo-fi', desc: 'Quente, abafado e saturado',
    s: {
      eq: { low: 2, lowMid: 1, highMid: -2, high: -6 },
      comp: { on: true, threshold: -22, ratio: 3, attack: 20, release: 250, makeup: 1.5 },
      saturation: 0.5,
      limiter: { on: true, gain: 1, ceiling: -1, release: 150 },
    },
  },
  {
    id: 'rock', name: 'Rock', desc: 'Guitarras na frente: médios presentes, bateria com punch (ataque lento deixa a pancada passar) e um pouco de calor',
    s: {
      eq: { low: 1, lowMid: -1.5, highMid: 1.5, high: 1 },
      comp: { on: true, threshold: -18, ratio: 2, attack: 30, release: 150, makeup: 1 },
      saturation: 0.25,
      limiter: { on: true, gain: 3, ceiling: -1, release: 80 },
      stereo: stereo(1.1),
    },
  },
  {
    id: 'metal', name: 'Metal', desc: 'Pesado e apertado: grave controlado pelo multibanda (o bumbo não some no meio das guitarras), médio-grave limpo, bem alto',
    s: {
      eq: { low: 1.5, lowMid: -2.5, highMid: 1, high: 1.5 },
      comp: { on: true, threshold: -16, ratio: 3, attack: 10, release: 100, makeup: 1.5 },
      saturation: 0.3,
      limiter: { on: true, gain: 5, ceiling: -1, release: 50 },
      multiband: tightLows(-22, 3, 140),
      stereo: stereo(1.15, 120),
    },
  },
  {
    id: 'hiphop', name: 'Hip hop', desc: 'Boom bap: grave gordo, caixa estalando, agudo arredondado e saturação de sampler',
    s: {
      eq: { low: 2, lowMid: 0.5, highMid: 0.5, high: -1 },
      comp: { on: true, threshold: -18, ratio: 3, attack: 25, release: 200, makeup: 1.5 },
      saturation: 0.35,
      limiter: { on: true, gain: 3.5, ceiling: -1, release: 80 },
      stereo: stereo(1, 120),
    },
  },
  {
    id: 'trap', name: 'Trap', desc: '808 enorme e firme (graves em mono, multibanda segurando), chimbal brilhante, muito alto',
    s: {
      eq: { low: 3.5, lowMid: -2, highMid: 1, high: 3 },
      comp: { on: true, threshold: -16, ratio: 2.5, attack: 30, release: 120, makeup: 1 },
      saturation: 0.3,
      limiter: { on: true, gain: 5.5, ceiling: -1, release: 40 },
      multiband: tightLows(-20, 2.5, 120),
      stereo: stereo(1.15, 110),
    },
  },
  {
    id: 'funk', name: 'Funk / Groove', desc: 'Baixo e bateria grudados: compressão rápida no groove, presença para a guitarra de base e os metais',
    s: {
      eq: { low: 2, lowMid: -1, highMid: 1.5, high: 1 },
      comp: { on: true, threshold: -17, ratio: 2.5, attack: 15, release: 120, makeup: 1 },
      saturation: 0.2,
      limiter: { on: true, gain: 3.5, ceiling: -1, release: 70 },
      stereo: stereo(1.05, 100),
    },
  },
  {
    id: 'reggae', name: 'Reggae', desc: 'O baixo manda: grave cheio e em mono, agudos suaves, compressão lenta que respira com o one drop',
    s: {
      eq: { low: 2.5, lowMid: 0.5, highMid: -0.5, high: -0.5 },
      comp: { on: true, threshold: -20, ratio: 2, attack: 40, release: 250, makeup: 1 },
      saturation: 0.2,
      limiter: { on: true, gain: 2, ceiling: -1, release: 120 },
      stereo: stereo(1.05, 120),
    },
  },
  {
    id: 'psych', name: 'Psicodélico 70', desc: 'Som de fita dos anos 70: quente, agudo arredondado, estéreo aberto e bastante saturação',
    s: {
      eq: { low: 1, lowMid: 1, highMid: 0.5, high: -2.5 },
      comp: { on: true, threshold: -20, ratio: 2.5, attack: 30, release: 300, makeup: 1 },
      saturation: 0.45,
      limiter: { on: true, gain: 1.5, ceiling: -1, release: 150 },
      stereo: stereo(1.25),
    },
  },
  {
    id: 'mpb', name: 'MPB / Bossa', desc: 'Voz e violão em primeiro plano: leve, aberto, dinâmica quase intacta',
    s: {
      eq: { low: 0.5, lowMid: -0.5, highMid: 0.5, high: 1.5 },
      comp: { on: true, threshold: -22, ratio: 1.5, attack: 50, release: 300, makeup: 0.5 },
      saturation: 0.1,
      limiter: { on: true, gain: 1, ceiling: -1, release: 150 },
    },
  },
  {
    id: 'jazz', name: 'Jazz', desc: 'Natural e acústico: compressão bem suave, toda a dinâmica da banda preservada',
    s: {
      eq: { low: 0.5, lowMid: 0, highMid: 0, high: 0.5 },
      comp: { on: true, threshold: -26, ratio: 1.3, attack: 60, release: 400, makeup: 0 },
      saturation: 0.05,
      limiter: { on: true, gain: 0, ceiling: -1, release: 200 },
      stereo: stereo(1.05),
    },
  },
  {
    id: 'orchestral', name: 'Orquestral', desc: 'Trilha e música clássica: nada de compressão, só o limitador nos picos para não perder os crescendos',
    s: {
      eq: { low: 0, lowMid: -0.5, highMid: 0, high: 0.5 },
      comp: { ...DEFAULT_MASTER.comp, on: false },
      saturation: 0,
      limiter: { on: true, gain: 0, ceiling: -1, release: 250 },
      stereo: stereo(1.1),
    },
  },
  {
    id: 'punk', name: 'Punk / Hardcore', desc: 'Cru e na cara: médios agressivos, compressão rápida, bem alto',
    s: {
      eq: { low: 1, lowMid: -1, highMid: 2, high: 1 },
      comp: { on: true, threshold: -16, ratio: 3, attack: 15, release: 100, makeup: 1.5 },
      saturation: 0.35,
      limiter: { on: true, gain: 5, ceiling: -1, release: 50 },
      stereo: stereo(1.1),
    },
  },
  {
    id: 'indie', name: 'Indie / Alternativo', desc: 'Aberto e natural: estéreo largo, médios limpos, alto sem esmagar',
    s: {
      eq: { low: 0.5, lowMid: -0.5, highMid: 1, high: 1.5 },
      comp: { on: true, threshold: -20, ratio: 2, attack: 30, release: 200, makeup: 1 },
      saturation: 0.2,
      limiter: { on: true, gain: 2, ceiling: -1, release: 100 },
      stereo: stereo(1.2),
    },
  },
  {
    id: 'rnb', name: 'R&B / Soul', desc: 'Suave e encorpado: grave redondo, agudo sedoso, voz na frente',
    s: {
      eq: { low: 2, lowMid: -1, highMid: 0, high: 1.5 },
      comp: { on: true, threshold: -20, ratio: 2, attack: 40, release: 250, makeup: 1 },
      saturation: 0.15,
      limiter: { on: true, gain: 3, ceiling: -1, release: 100 },
      stereo: stereo(1.1, 110),
    },
  },
  {
    id: 'vintage', name: 'Anos 60 / Motown', desc: 'Som de rádio antigo: médios na frente, agudo e grave contidos, estéreo estreito e saturação de fita',
    s: {
      eq: { low: -1, lowMid: 1.5, highMid: 1.5, high: -2 },
      comp: { on: true, threshold: -20, ratio: 3, attack: 20, release: 300, makeup: 1.5 },
      saturation: 0.4,
      limiter: { on: true, gain: 5, ceiling: -1, release: 150 },
      stereo: stereo(0.8),
    },
  },
  {
    id: 'samba', name: 'Samba / Pagode', desc: 'Percussão viva e brilhante, cavaco presente, grave do surdo firme',
    s: {
      eq: { low: 1.5, lowMid: -1, highMid: 1, high: 2 },
      comp: { on: true, threshold: -18, ratio: 2, attack: 25, release: 150, makeup: 1 },
      saturation: 0.15,
      limiter: { on: true, gain: 2.5, ceiling: -1, release: 80 },
      stereo: stereo(1.1, 120),
    },
  },
  {
    id: 'sertanejo', name: 'Sertanejo', desc: 'Moderno e alto: voz e violão na frente, grave cheio, brilho de rádio',
    s: {
      eq: { low: 1.5, lowMid: -1, highMid: 1.5, high: 1.5 },
      comp: { on: true, threshold: -18, ratio: 2.5, attack: 30, release: 180, makeup: 1 },
      saturation: 0.2,
      limiter: { on: true, gain: 4, ceiling: -1, release: 70 },
      stereo: stereo(1.1, 120),
    },
  },
  {
    id: 'funk-carioca', name: 'Funk Carioca', desc: 'Grave gigante segurado pelo multibanda (em mono), batida estalando, muito alto',
    s: {
      eq: { low: 4, lowMid: -2, highMid: 1, high: 1.5 },
      comp: { on: true, threshold: -16, ratio: 3, attack: 10, release: 100, makeup: 1.5 },
      saturation: 0.4,
      limiter: { on: true, gain: 6, ceiling: -1, release: 40 },
      multiband: tightLows(-20, 3, 130),
      stereo: stereo(1.05, 120),
    },
  },
  {
    id: 'axe', name: 'Axé', desc: 'Festivo: percussão e metais brilhantes, estéreo aberto, alto',
    s: {
      eq: { low: 1.5, lowMid: -1, highMid: 1.5, high: 2.5 },
      comp: { on: true, threshold: -17, ratio: 2.5, attack: 20, release: 120, makeup: 1 },
      saturation: 0.2,
      limiter: { on: true, gain: 4, ceiling: -1, release: 60 },
      stereo: stereo(1.15, 120),
    },
  },
  {
    id: 'forro', name: 'Forró / Baião', desc: 'Sanfona e zabumba na frente: médios presentes, grave da zabumba firme',
    s: {
      eq: { low: 1, lowMid: 0, highMid: 2, high: 1 },
      comp: { on: true, threshold: -19, ratio: 2, attack: 25, release: 180, makeup: 1 },
      saturation: 0.15,
      limiter: { on: true, gain: 2.5, ceiling: -1, release: 90 },
      stereo: stereo(1.05, 120),
    },
  },
  {
    id: 'latin', name: 'Salsa / Cumbia', desc: 'Metais e percussão brilhantes, piano claro, compressão leve que deixa o swing respirar',
    s: {
      eq: { low: 1, lowMid: -1, highMid: 1.5, high: 2 },
      comp: { on: true, threshold: -18, ratio: 2, attack: 20, release: 150, makeup: 1 },
      saturation: 0.15,
      limiter: { on: true, gain: 3, ceiling: -1, release: 80 },
      stereo: stereo(1.15, 120),
    },
  },
  {
    id: 'reggaeton', name: 'Reggaeton', desc: 'Dembow pesado: grave forte e em mono (multibanda segurando), caixa na cara, muito alto',
    s: {
      eq: { low: 3.5, lowMid: -1.5, highMid: 1, high: 2 },
      comp: { on: true, threshold: -16, ratio: 3, attack: 15, release: 100, makeup: 1.5 },
      saturation: 0.3,
      limiter: { on: true, gain: 5.5, ceiling: -1, release: 40 },
      multiband: tightLows(-20, 2.5, 120),
      stereo: stereo(1.1, 110),
    },
  },
  {
    id: 'bachata', name: 'Bachata / Bolero', desc: 'Romântico: quente, violões e voz em primeiro plano, dinâmica preservada',
    s: {
      eq: { low: 1, lowMid: 0, highMid: 0.5, high: 1.5 },
      comp: { on: true, threshold: -20, ratio: 1.8, attack: 40, release: 250, makeup: 0.5 },
      saturation: 0.1,
      limiter: { on: true, gain: 2, ceiling: -1, release: 120 },
      stereo: stereo(1.15),
    },
  },
  {
    id: 'afro', name: 'Afrobeats / Amapiano', desc: 'Log drum e bumbo encorpados (grave em mono), percussão aberta e larga',
    s: {
      eq: { low: 3, lowMid: -1.5, highMid: 0.5, high: 2 },
      comp: { on: true, threshold: -18, ratio: 2.5, attack: 25, release: 150, makeup: 1 },
      saturation: 0.25,
      limiter: { on: true, gain: 4.5, ceiling: -1, release: 60 },
      multiband: tightLows(-21, 2.5, 120),
      stereo: stereo(1.2, 120),
    },
  },
  {
    id: 'house', name: 'House / Techno', desc: 'Bumbo 4x4 firme e em mono, médio-grave limpo, agudos abertos para a pista',
    s: {
      eq: { low: 2.5, lowMid: -1.5, highMid: 0, high: 2 },
      comp: { on: true, threshold: -16, ratio: 3, attack: 10, release: 80, makeup: 1.5 },
      saturation: 0.25,
      limiter: { on: true, gain: 5, ceiling: -1, release: 40 },
      multiband: tightLows(-20, 2.5, 140),
      stereo: stereo(1.1, 130),
    },
  },
  {
    id: 'dnb', name: 'Drum and Bass / Dubstep', desc: 'Sub-grave enorme e controlado, caixa estalando, compressão rápida, o mais alto possível',
    s: {
      eq: { low: 3, lowMid: -2, highMid: 1, high: 2.5 },
      comp: { on: true, threshold: -15, ratio: 3, attack: 5, release: 60, makeup: 2 },
      saturation: 0.35,
      limiter: { on: true, gain: 6, ceiling: -1, release: 30 },
      multiband: tightLows(-22, 3, 120),
      stereo: stereo(1.2, 120),
    },
  },
  {
    id: 'synthwave', name: 'Synthwave / Anos 80', desc: 'Largo e brilhante como nos anos 80: estéreo bem aberto, agudo cintilante, saturação leve',
    s: {
      eq: { low: 1.5, lowMid: -1, highMid: 0.5, high: 2.5 },
      comp: { on: true, threshold: -18, ratio: 2.5, attack: 30, release: 200, makeup: 1 },
      saturation: 0.25,
      limiter: { on: true, gain: 3.5, ceiling: -1, release: 80 },
      stereo: stereo(1.35, 120),
    },
  },
  {
    id: 'country', name: 'Country / Folk', desc: 'Violão e voz naturais: médios claros, compressão suave, pouca saturação',
    s: {
      eq: { low: 0.5, lowMid: -1, highMid: 1.5, high: 1.5 },
      comp: { on: true, threshold: -20, ratio: 1.8, attack: 40, release: 250, makeup: 0.5 },
      saturation: 0.1,
      limiter: { on: true, gain: 1.5, ceiling: -1, release: 120 },
      stereo: stereo(1.1),
    },
  },
  {
    id: 'ambient', name: 'Ambient', desc: 'Espaçoso: estéreo bem largo, sem compressão, só o limitador nos picos',
    s: {
      eq: { low: 0, lowMid: -1, highMid: -0.5, high: 1 },
      comp: { ...DEFAULT_MASTER.comp, on: false },
      saturation: 0,
      limiter: { on: true, gain: 0, ceiling: -1, release: 300 },
      stereo: stereo(1.4),
    },
  },
  {
    id: 'podcast', name: 'Voz / Podcast', desc: 'Fala clara e constante: corta o grave embolado, realça a inteligibilidade, compressão firme',
    s: {
      eq: { low: -2, lowMid: -1, highMid: 2.5, high: 1 },
      comp: { on: true, threshold: -24, ratio: 3, attack: 10, release: 150, makeup: 3 },
      saturation: 0,
      limiter: { on: true, gain: 2, ceiling: -1, release: 100 },
      stereo: stereo(1, 150),
    },
  },
];

/** Presets agrupados por gênero (para o seletor do painel do master). */
export const MASTER_GROUPS: { group: string; ids: string[] }[] = [
  { group: 'Básicos', ids: ['neutral', 'pop', 'acoustic', 'electronic', 'lofi'] },
  { group: 'Rock e pesado', ids: ['rock', 'metal', 'punk', 'indie', 'psych'] },
  { group: 'Groove e urbano', ids: ['hiphop', 'trap', 'funk', 'rnb', 'reggae', 'vintage'] },
  { group: 'Brasileiros', ids: ['mpb', 'samba', 'sertanejo', 'funk-carioca', 'axe', 'forro'] },
  { group: 'Latinos e africanos', ids: ['latin', 'reggaeton', 'bachata', 'afro'] },
  { group: 'Eletrônicos', ids: ['house', 'dnb', 'synthwave'] },
  { group: 'Acústicos e outros', ids: ['jazz', 'orchestral', 'country', 'ambient', 'podcast'] },
];

const db = (v: number) => 10 ** (v / 20);

/** Ajustes do limitador no formato do processador (lineares, em segundos). */
export function limiterParams(m: MasterSettings): MasterWorkletSettings {
  return { on: m.limiter.on, gain: db(m.limiter.gain), ceiling: db(m.limiter.ceiling), release: m.limiter.release / 1000 };
}

/** Compensação da saturação: a curva tanh(kx)/tanh(k) amplifica sinais pequenos em k/tanh(k). */
const satComp = (amount: number) => {
  const k = 1 + amount * 4;
  return Math.tanh(k) / k;
};

const loaded = new WeakMap<BaseAudioContext, Promise<void>>();
const ready = new WeakSet<BaseAudioContext>();

/** Carrega (uma vez por contexto) o módulo dos AudioWorklets (master e sidechain). */
export function ensureWorklets(ctx: BaseAudioContext): Promise<void> {
  if (!loaded.has(ctx)) loaded.set(ctx, ctx.audioWorklet.addModule(workletUrl).then(() => void ready.add(ctx)));
  return loaded.get(ctx)!;
}
/** Os AudioWorklets já estão disponíveis neste contexto? */
export const workletsReady = (ctx: BaseAudioContext) => ready.has(ctx);

export class MasterChain {
  /** entrada do master (o que antes era o "master" do mixer) */
  readonly input: GainNode;
  /** saída final (depois do limitador) */
  readonly output: GainNode;
  /** última leitura dos medidores (só ao vivo) */
  reading: MasterReading | null = null;
  /** maior pico real desde o último reset (dBTP) */
  maxTruePeak = -Infinity;
  private eq: BiquadFilterNode[];
  private comp: DynamicsCompressorNode;
  private makeup: GainNode;
  private shaper: WaveShaperNode;
  private satOut: GainNode;
  /** compressor multibanda e imagem estéreo, depois da saturação */
  readonly multiband: MultibandComp;
  private imager: StereoImager;
  /** saída da imagem estéreo (entra no limitador) */
  private post!: AudioNode;
  private fallback: DynamicsCompressorNode | null = null;
  private worklet: AudioWorkletNode | null = null;
  private settings: MasterSettings = DEFAULT_MASTER;

  /** `live`: carrega o limitador/medidores (AudioWorklet); na exportação o limitador é aplicado depois. */
  constructor(private ctx: BaseAudioContext, dest: AudioNode, live: boolean) {
    this.input = ctx.createGain();
    this.input.gain.value = 0.75; // folga para a soma das trilhas
    const mk = (type: BiquadFilterType, f: number, q = 0.8) => {
      const b = ctx.createBiquadFilter();
      b.type = type;
      b.frequency.value = f;
      b.Q.value = q;
      return b;
    };
    this.eq = [mk('lowshelf', 100), mk('peaking', 400), mk('peaking', 3000), mk('highshelf', 10000)];
    this.comp = ctx.createDynamicsCompressor();
    this.comp.knee.value = 6;
    this.makeup = ctx.createGain();
    this.shaper = ctx.createWaveShaper();
    this.shaper.oversample = '4x';
    this.satOut = ctx.createGain();
    this.output = ctx.createGain();
    this.input.connect(this.eq[0]).connect(this.eq[1]).connect(this.eq[2]).connect(this.eq[3]);
    this.eq[3].connect(this.comp).connect(this.makeup).connect(this.shaper).connect(this.satOut);
    this.multiband = new MultibandComp(ctx);
    this.imager = new StereoImager(ctx);
    this.satOut.connect(this.multiband.input);
    this.multiband.output.connect(this.imager.input);
    const post = this.imager.output;
    this.output.connect(dest);

    this.post = post;
    if (!live) {
      post.connect(this.output);
      return;
    }
    // até o AudioWorklet carregar (ou se ele falhar), um limitador simples protege a saída
    this.fallback = ctx.createDynamicsCompressor();
    this.fallback.threshold.value = -3;
    this.fallback.knee.value = 0;
    this.fallback.ratio.value = 20;
    this.fallback.attack.value = 0.002;
    this.fallback.release.value = 0.1;
    post.connect(this.fallback).connect(this.output);
    void this.loadWorklet();
  }

  private async loadWorklet() {
    const ctx = this.ctx;
    try {
      await ensureWorklets(ctx);
      const node = new AudioWorkletNode(ctx, 'mm-master', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [2],
        channelCount: 2,
        channelCountMode: 'explicit',
      });
      node.port.onmessage = (e: MessageEvent<MasterReading>) => {
        this.reading = e.data;
        if (e.data.truePeak > this.maxTruePeak) this.maxTruePeak = e.data.truePeak;
      };
      node.port.postMessage({ type: 'settings', settings: limiterParams(this.settings) });
      this.post.disconnect();
      this.fallback?.disconnect();
      this.fallback = null;
      this.post.connect(node).connect(this.output);
      this.worklet = node;
    } catch (e) {
      console.warn('Limitador/medidores do master indisponíveis; usando o limitador simples.', e);
    }
  }

  /** Zera o LUFS integrado e o pico máximo (ao começar a tocar). */
  reset() {
    this.worklet?.port.postMessage({ type: 'reset' });
    this.maxTruePeak = -Infinity;
    this.reading = null;
  }

  /** Redução de ganho do compressor de cola (dB, ≤ 0). */
  compReduction() {
    return this.settings.comp.on ? this.comp.reduction : 0;
  }

  update(m: MasterSettings) {
    this.settings = m;
    const now = this.ctx.currentTime;
    const smooth = (p: AudioParam, v: number) => p.setTargetAtTime(v, now, 0.02);
    const { low, lowMid, highMid, high } = m.eq;
    [low, lowMid, highMid, high].forEach((g, i) => smooth(this.eq[i].gain, g));
    const c = m.comp;
    this.comp.threshold.value = c.on ? c.threshold : 0;
    this.comp.ratio.value = c.on ? c.ratio : 1;
    this.comp.attack.value = c.attack / 1000;
    this.comp.release.value = c.release / 1000;
    smooth(this.makeup.gain, c.on ? db(c.makeup) : 1);
    this.shaper.curve = m.saturation > 0 ? driveCurve(m.saturation) : null;
    smooth(this.satOut.gain, m.saturation > 0 ? satComp(m.saturation) : 1);
    const full = masterOf(m);
    this.multiband.update(full.multiband);
    this.imager.update(full.stereo);
    this.worklet?.port.postMessage({ type: 'settings', settings: limiterParams(m) });
  }
}
