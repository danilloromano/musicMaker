// Rack de guitarra/baixo: pedais → amplificador → caixa (impulse response) → pedais de modulação e tempo.
// Tudo roda no canal da trilha, então a gravação continua seca e o timbre pode ser trocado depois (re-amp).
import { AmpRig, PedalState } from '../types';
import { workletsReady } from './master';
import { AMPS, AmpModel, ToneStackParts, gainPot, magnitude, outGain, powerDrive, powerTube, toneStackZ, triode } from './ampCircuits';

// ---------- Definições ----------

export interface PedalDef {
  id: string;
  name: string;
  color: string;
  /** true = entra depois do amp e da caixa (modulação/tempo), como no loop de efeitos */
  post: boolean;
  /** descrição curta do timbre, mostrada no pedal */
  desc?: string;
  /** `fmt` mostra o valor do botão na unidade dele (ex.: semitons) em vez da escala 0–10 */
  params: { label: string; def: number; fmt?: (v: number, all: number[]) => string; short?: string }[];
  /** chave de dois lados (como as mini-chaves de pedal): guardada como 0/1 logo depois dos botões */
  toggles?: { labels: [string, string]; titles: [string, string]; def: 0 | 1 }[];
  /** pedal com vários circuitos: cada modelo tem nome, cor, descrição e botões próprios (`params` acima = os do 1º) */
  models?: PedalModel[];
  /** desenha os botões como faders verticais (equalizador gráfico), com `short` embaixo de cada um */
  faders?: boolean;
  /** desenha as chaves como menus suspensos (pedais com muitas chaves, como o delay) */
  dropdowns?: boolean;
}

export interface PedalModel {
  /** id do circuito (é o id do pedal separado que ele substituiu: os projetos antigos são convertidos) */
  id: string;
  name: string;
  color: string;
  desc?: string;
  params: PedalDef['params'];
}

/** Tons do harmonizador e intervalos (em graus da escala: 2 = terça, 4 = quinta, 7 = oitava). */
const KEY_NAMES = ['Dó', 'Dó#', 'Ré', 'Ré#', 'Mi', 'Fá', 'Fá#', 'Sol', 'Sol#', 'Lá', 'Lá#', 'Si'];
const HARMONY_STEPS = [
  { name: '-8ª', deg: -7 }, { name: '-6ª', deg: -5 }, { name: '-5ª', deg: -4 }, { name: '-4ª', deg: -3 }, { name: '-3ª', deg: -2 },
  { name: '+3ª', deg: 2 }, { name: '+4ª', deg: 3 }, { name: '+5ª', deg: 4 }, { name: '+6ª', deg: 5 }, { name: '+8ª', deg: 7 },
];
const harmonyKey = (v: number) => Math.min(11, Math.round(v * 11));
const harmonyStep = (v: number) => Math.min(HARMONY_STEPS.length - 1, Math.round(v * (HARMONY_STEPS.length - 1)));
const HARMONY_DEF = 5 / (HARMONY_STEPS.length - 1); // terça acima

/** Botão de intervalo do pedal de pitch (0..1) → semitons inteiros de -12 a +12. */
export const pitchSemis = (v: number) => Math.round(v * 24 - 12);
const fmtSemis = (s: number) => (s === 12 ? '+8ª' : s === -12 ? '-8ª' : `${s > 0 ? '+' : ''}${s} st`);

/** Tipos do pedal de reverb (ordem do botão Tipo) e a faixa de tempo (s) de cada um. */
const REVERB_TYPES = [
  { id: 'spring', name: 'Mola', min: 0.8, max: 3.5 },
  { id: 'plate', name: 'Placa', min: 0.6, max: 5 },
  { id: 'shimmer', name: 'Shimmer', min: 2, max: 9 },
  { id: 'hall', name: 'Hall', min: 1.5, max: 8 },
  { id: 'room', name: 'Sala', min: 0.8, max: 5 },
] as const;
type ReverbType = (typeof REVERB_TYPES)[number]['id'];
const reverbType = (v: number) => Math.min(REVERB_TYPES.length - 1, Math.round(v * (REVERB_TYPES.length - 1)));

/** Figuras do delay sincronizado (em tempos de semínima). */
const DELAY_DIVS = [
  { name: '1/16', beats: 0.25 },
  { name: '1/8 tercina', beats: 1 / 3 },
  { name: '1/16 pont.', beats: 0.375 },
  { name: '1/8', beats: 0.5 },
  { name: '1/4 tercina', beats: 2 / 3 },
  { name: '1/8 pont.', beats: 0.75 },
  { name: '1/4', beats: 1 },
  { name: '1/4 pont.', beats: 1.5 },
  { name: '1/2', beats: 2 },
];
const delayDiv = (v: number) => DELAY_DIVS[Math.min(DELAY_DIVS.length - 1, Math.round(v * (DELAY_DIVS.length - 1)))];
/** Tempo livre do delay (s): normal 60 ms a 1 s; reverso, trechos de 0,15 a 1,5 s. */
const freeDelay = (v: number, reverse: boolean) => (reverse ? 0.15 + v * 1.35 : 0.06 + v * 0.94);
function delayTimeLabel(v: number, all: number[]) {
  if ((all[7] ?? 0) >= 0.5) return delayDiv(v).name;
  return `${Math.round(freeDelay(v, (all[6] ?? 0) >= 0.5) * 1000)} ms`;
}

/** Pedal com vários modelos (antes da pedaleira; os botões do pedal são os do modelo escolhido). */
function group(id: string, name: string, models: PedalModel[]): PedalDef {
  return { id, name, color: models[0].color, post: false, params: models[0].params, models };
}

/** Bandas do equalizador gráfico (uma oitava entre elas, como nos pedais de EQ de 7 bandas). */
const EQ_BANDS = [100, 200, 400, 800, 1600, 3200, 6400];
const fmtHz = (f: number) => (f >= 1000 ? `${(f / 1000).toString().replace('.', ',')}k` : `${f}`);
const fmtDb = (db: number) => `${db > 0.05 ? '+' : ''}${db.toFixed(1).replace('.', ',')} dB`;

/** Valores padrão de um pedal: botões e, se houver, a chave. */
/** Modelo atual de um pedal com modelos (o 1º se nada foi escolhido); undefined nos pedais comuns. */
export const modelOf = (d: PedalDef, model?: string) => (d.models ? d.models.find((m) => m.id === model) ?? d.models[0] : undefined);
/** Botões de um pedal (os do modelo escolhido, nos pedais com modelos). */
export const paramsOf = (d: PedalDef, model?: string) => modelOf(d, model)?.params ?? d.params;
export const pedalDefaults = (d: PedalDef, model?: string) => [...paramsOf(d, model).map((x) => x.def), ...(d.toggles ?? []).map((t) => t.def)];

export const PEDALS: PedalDef[] = [
  { id: 'gate', name: 'Noise Gate', color: '#c8c8bd', post: false, params: [{ label: 'Limiar', def: 0.4 }, { label: 'Release', def: 0.3 }] },
  { id: 'comp', name: 'Compressor', color: '#38d9c0', post: false,
    desc: 'Ataque: devagar deixa passar a palhetada antes de comprimir · Blend: mistura o som limpo (compressão paralela) · Pedal: o "squash" clássico, mais escuro · Estúdio: transparente',
    params: [{ label: 'Sustain', def: 0.5 }, { label: 'Nível', def: 0.5 }, { label: 'Ataque', def: 0.35 }, { label: 'Blend', def: 0.85 }],
    toggles: [{ labels: ['Pedal', 'Estúdio'], titles: ['Pedal: compressão forte e rápida, agudo um pouco arredondado (estilo Dyna Comp)', 'Estúdio: compressão suave, joelho largo, som transparente'], def: 0 }] },
  { id: 'octave', name: 'Octaver', color: '#6a5acd', post: false,
    desc: 'Oitava e duas oitavas abaixo, como os octavers analógicos: grave gordo, toque uma nota por vez',
    params: [{ label: 'Direto', def: 0.7 }, { label: '-1 Oit.', def: 0.6 }, { label: '-2 Oit.', def: 0 }] },
  { id: 'pitch', name: 'Pitch', color: '#d2457a', post: false,
    desc: 'Muda a afinação: oitava acima/abaixo, quinta, terça… Mix no máximo = só o som transposto; no meio = harmonia',
    params: [
      { label: 'Intervalo', def: 1, fmt: (v) => fmtSemis(pitchSemis(v)) },
      { label: 'Fino', def: 0.5, fmt: (v) => `${Math.round((v - 0.5) * 100)} ct` },
      { label: 'Mix', def: 0.5 },
    ] },
  { id: 'harmony', name: 'Harmonizer', color: '#4fc3a1', post: false,
    desc: 'Segunda voz no intervalo escolhido, dentro da escala do tom (terça maior ou menor conforme a nota). Uma nota por vez',
    params: [
      { label: 'Tom', def: 0, fmt: (v) => KEY_NAMES[harmonyKey(v)] },
      { label: 'Intervalo', def: HARMONY_DEF, fmt: (v) => HARMONY_STEPS[harmonyStep(v)].name },
      { label: 'Voz', def: 0.6 },
    ],
    toggles: [{ labels: ['Maior', 'Menor'], titles: ['Escala maior', 'Escala menor natural'], def: 0 }] },
  { id: 'wah', name: 'Wah', color: '#9bd94a', post: false,
    desc: 'Pedal: o filtro fica parado na posição escolhida · Auto: abre sozinho com a força da palhetada',
    params: [{ label: 'Posição', def: 0.5 }, { label: 'Sensib.', def: 0.5 }, { label: 'Resson.', def: 0.5 }],
    toggles: [{ labels: ['Pedal', 'Auto'], titles: ['Wah parado na posição do botão (como o pedal meio aberto)', 'Auto-wah: a palhetada abre o filtro e ele fecha quando a nota cai'], def: 0 }] },
  group('boost', 'Booster', [
    { id: 'boostClean', name: 'Clean', color: '#e0b48a', desc: 'Aumento limpo e transparente: empurra o amp ou um drive sem mudar o timbre; Graves e Brilho para ajustar',
      params: [
        { label: 'Ganho', def: 0.4, fmt: (v) => fmtDb(20 * Math.log10(1 + v * 7)) },
        { label: 'Brilho', def: 0.3, fmt: (v) => fmtDb(v * 10) },
        { label: 'Graves', def: 0.5, fmt: (v) => fmtDb((v - 0.5) * 12) },
      ] },
    { id: 'boostFet', name: 'FET', color: '#c98a5a', desc: 'Transistor JFET: aumento quente, um pouco de compressão e harmônicos pares; com ganho alto já começa a saturar',
      params: [
        { label: 'Ganho', def: 0.45 },
        { label: 'Tom', def: 0.55 },
        { label: 'Nível', def: 0.5 },
      ] },
  ]),
  // Overdrive, distorção e fuzz: um pedal de cada, com vários circuitos clássicos dentro (os nomes na tela
  // são genéricos de propósito). Dourado ≈ Klon Centaur, Verde ≈ Ibanez TS808, Amarelo ≈ Boss SD-1;
  // Preta ≈ ProCo RAT, Britânica ≈ Marshall Guv'nor, Metal ≈ Boss MT-2; Muff ≈ Big Muff Pi, Germânio ≈ Fuzz Face.
  group('overdrive', 'Overdrive', [
    { id: 'odGold', name: 'Dourado', color: '#d9b44a', desc: 'Transparente: mistura o limpo com o sujo, mantém os graves',
      params: [{ label: 'Ganho', def: 0.35 }, { label: 'Agudos', def: 0.5 }, { label: 'Nível', def: 0.55 }] },
    { id: 'odGreen', name: 'Verde', color: '#5cc25a', desc: 'Médios na frente, grave enxuto, saturação macia',
      params: [{ label: 'Drive', def: 0.4 }, { label: 'Tom', def: 0.5 }, { label: 'Nível', def: 0.5 }] },
    { id: 'odYellow', name: 'Amarelo', color: '#f2d33c', desc: 'Clipagem assimétrica: mais brilho e harmônicos pares',
      params: [{ label: 'Drive', def: 0.45 }, { label: 'Tom', def: 0.5 }, { label: 'Nível', def: 0.5 }] },
  ]),
  group('distortion', 'Distorção', [
    { id: 'dist', name: 'Clássica', color: '#ff9a3c', desc: 'Distorção dura e direta, de rock',
      params: [{ label: 'Drive', def: 0.5 }, { label: 'Tom', def: 0.5 }, { label: 'Nível', def: 0.5 }] },
    { id: 'distBlack', name: 'Preta', color: '#3a3a3a', desc: 'Op-amp com diodos de silício: muito ganho, médios cheios; o Filtro escurece girando para a direita',
      params: [{ label: 'Distorção', def: 0.5 }, { label: 'Filtro', def: 0.4 }, { label: 'Volume', def: 0.5 }] },
    { id: 'distBrit', name: 'Britânica', color: '#c9a35c', desc: 'Amp valvulado britânico num pedal: crocante, médios na frente, ótimo em amp limpo',
      params: [{ label: 'Ganho', def: 0.5 }, { label: 'Tom', def: 0.5 }, { label: 'Nível', def: 0.5 }] },
    { id: 'distMetal', name: 'Metal', color: '#9aa0a6', desc: 'Dois estágios de ganho altíssimo e EQ ativo: médios cavados para metal, ou no máximo para solos',
      params: [{ label: 'Drive', def: 0.6 }, { label: 'Médios', def: 0.3 }, { label: 'Agudos', def: 0.55 }, { label: 'Nível', def: 0.5 }] },
  ]),
  group('fuzzbox', 'Fuzz', [
    { id: 'fuzz', name: 'Clássico', color: '#e8564a', desc: 'Fuzz de silício áspero e cheio',
      params: [{ label: 'Fuzz', def: 0.6 }, { label: 'Tom', def: 0.5 }, { label: 'Nível', def: 0.5 }] },
    { id: 'fuzzMuff', name: 'Muff', color: '#5b6fa8', desc: 'Sustain enorme e parede de som; o Tom passa de grave gordo a agudo, com os médios cavados no meio',
      params: [{ label: 'Sustain', def: 0.6 }, { label: 'Tom', def: 0.5 }, { label: 'Volume', def: 0.5 }] },
    { id: 'fuzzGerm', name: 'Germânio', color: '#b0412e', desc: 'Fuzz redondo e quente dos anos 60; limpa quando você toca mais leve',
      params: [{ label: 'Fuzz', def: 0.65 }, { label: 'Volume', def: 0.5 }] },
  ]),
  { id: 'univibe', name: 'Univibe', color: '#8a6e4b', post: false,
    desc: 'O pulso "latejante" do fim dos anos 60: quatro fases em frequências diferentes varridas por uma lâmpada · Chorus: soma com o som direto (redemoinho) · Vibrato: só o som ondulado (a afinação balança)',
    params: [{ label: 'Velocidade', def: 0.35 }, { label: 'Intens.', def: 0.65 }, { label: 'Volume', def: 0.5 }],
    toggles: [{ labels: ['Chorus', 'Vibrato'], titles: ['Chorus: o som direto somado ao defasado, o "redemoinho" clássico', 'Vibrato: só o som defasado, a afinação ondula'], def: 0 }] },
  { id: 'eq', name: 'Equalizador', color: '#e9e9e4', post: false, faders: true,
    desc: 'Equalizador gráfico de 7 bandas (±15 dB) e volume: depois dos drives, molda o timbre antes do amp (ex.: médios para solos, graves cortados para limpar)',
    params: [
      ...EQ_BANDS.map((f) => ({ label: `${fmtHz(f)}Hz`, short: fmtHz(f), def: 0.5, fmt: (v: number) => fmtDb((v - 0.5) * 30) })),
      { label: 'Nível', short: 'Nív', def: 0.5, fmt: (v: number) => fmtDb((v - 0.5) * 30) },
    ] },
  { id: 'chorus', name: 'Chorus', color: '#5fb4ff', post: true,
    desc: 'Três vozes defasadas, abertas no estéreo · Analógico: quente e escuro como os chips BBD · Digital: brilhante e cristalino',
    params: [{ label: 'Velocidade', def: 0.3 }, { label: 'Profund.', def: 0.5 }, { label: 'Mix', def: 0.5 }],
    toggles: [
      { labels: ['Analógico', 'Digital'], titles: ['Chorus analógico: quente, escuro, onda triangular', 'Chorus digital: limpo e brilhante, onda senoidal'], def: 0 },
      { labels: ['Mono', 'Estéreo'], titles: ['Mono: vozes no centro', 'Estéreo: uma voz de cada lado e uma no centro'], def: 1 },
    ] },
  { id: 'phaser', name: 'Phaser', color: '#b98cff', post: true,
    desc: '4 estágios: o "whoosh" suave clássico · 8 estágios: mais vales, mais intenso · Realim.: ressonância, o som fica "falado"',
    params: [{ label: 'Velocidade', def: 0.25 }, { label: 'Profund.', def: 0.6 }, { label: 'Intens.', def: 0.6 }, { label: 'Realim.', def: 0.3 }],
    toggles: [
      { labels: ['4', '8'], titles: ['4 estágios: suave e clássico', '8 estágios: mais vales, varredura mais intensa'], def: 0 },
      { labels: ['Mono', 'Estéreo'], titles: ['Mono: os dois lados juntos', 'Estéreo: o lado direito varre defasado do esquerdo'], def: 1 },
    ] },
  { id: 'flanger', name: 'Flanger', color: '#7fd6e8', post: true, desc: 'O "avião a jato": eco curtíssimo que varre, com realimentação para ficar mais metálico',
    params: [{ label: 'Velocidade', def: 0.25 }, { label: 'Profund.', def: 0.6 }, { label: 'Realim.', def: 0.5 }] },
  { id: 'vibrato', name: 'Vibrato', color: '#e8a33c', post: true, desc: 'Ondula a afinação (não o volume, como o tremolo): só o sinal modulado, sem o direto',
    params: [{ label: 'Velocidade', def: 0.35 }, { label: 'Profund.', def: 0.35 }] },
  { id: 'rotary', name: 'Rotary', color: '#a0522d', post: true,
    desc: 'Caixa rotativa: corneta (agudos) e tambor (graves) girando · Lento/Rápido acelera e freia aos poucos, como a de verdade',
    params: [{ label: 'Drive', def: 0.2 }, { label: 'Balanço', def: 0.5 }, { label: 'Mix', def: 1 }],
    toggles: [{ labels: ['Lento', 'Rápido'], titles: ['Lento (coral): giro calmo, ondulação larga', 'Rápido (tremolo): giro rápido, o som "gira" pela sala'], def: 0 }] },
  { id: 'tremolo', name: 'Tremolo', color: '#ff5fa2', post: true,
    desc: 'Forma: de ondulação suave a corte seco (o "helicóptero") · Harmônico: graves e agudos pulsam alternados, como nos amps americanos dos anos 60 · Estéreo: o som passeia de um lado ao outro',
    params: [{ label: 'Velocidade', def: 0.4 }, { label: 'Profund.', def: 0.5 }, { label: 'Forma', def: 0.15 }],
    toggles: [
      { labels: ['Clássico', 'Harmônico'], titles: ['Clássico: o volume todo sobe e desce', 'Harmônico: graves e agudos se alternam (som mais "líquido", quase um phaser)'], def: 0 },
      { labels: ['Mono', 'Estéreo'], titles: ['Mono: os dois lados juntos', 'Estéreo: os lados se alternam (auto-pan)'], def: 0 },
    ] },
  { id: 'delay', name: 'Delay', color: '#a3b1c2', post: true, dropdowns: true, desc: 'Fita: repetições quentes que oscilam e escurecem · Digital: limpas e exatas · Estéreo: ping-pong · Reverso: cada trecho volta de trás para frente',
    params: [
      { label: 'Tempo', def: 0.35, fmt: (v, all) => delayTimeLabel(v, all) },
      { label: 'Ecos', def: 0.35 },
      { label: 'Mix', def: 0.3 },
      { label: 'Mod.', def: 0.15 },
    ],
    toggles: [
      { labels: ['Fita', 'Digital'], titles: ['Delay de fita', 'Delay digital'], def: 0 },
      { labels: ['Mono', 'Estéreo'], titles: ['Mono: repetições no centro', 'Estéreo: repetições alternando entre esquerda e direita'], def: 0 },
      { labels: ['Normal', 'Reverso'], titles: ['Repetições normais', 'Reverso: o som volta de trás para frente, com tempo = tamanho de cada trecho invertido'], def: 0 },
      { labels: ['Livre', 'BPM'], titles: ['Livre: o Tempo vai em milissegundos', 'BPM: o Tempo escolhe a figura (colcheia, pontuada, tercina…) no andamento da música'], def: 0 },
    ] },
  { id: 'reverb', name: 'Reverb', color: '#3f8fe0', post: true,
    desc: 'Mola: o "boing" dos amps antigos · Placa: denso e brilhante, de estúdio · Shimmer: cauda que sobe uma oitava, etérea · Hall: sala de concerto, longo e escuro · Sala: ambiente menor, cauda lisa',
    params: [
      { label: 'Tempo', def: 0.4 },
      { label: 'Tom', def: 0.5 },
      { label: 'Mix', def: 0.35 },
      { label: 'Tipo', def: 0, fmt: (v) => REVERB_TYPES[reverbType(v)].name },
    ] },
];

type Curve = 'soft' | 'hard' | 'asym' | 'germ' | 'tape' | 'diode' | 'germAsym' | 'fet';

export { AMPS } from './ampCircuits';

interface CabSpec {
  id: string;
  name: string;
  hp: number;
  lp: number;
  lpOrder: number;
  peaks: [number, number, number][]; // [Hz, dB, Q]
  taps: [number, number][]; // reflexões dentro da caixa: [ms, ganho]
}

export const CABS: CabSpec[] = [
  { id: '1x12', name: '1x12 Aberta', hp: 85, lp: 5500, lpOrder: 2, peaks: [[115, 3, 1], [900, -2, 1], [2500, 4, 1.4]], taps: [[0.7, 0.25], [1.6, -0.15]] },
  { id: '2x12', name: '2x12 Combo', hp: 75, lp: 5000, lpOrder: 3, peaks: [[100, 4, 1.1], [1800, 3, 1.2], [3200, 2, 2]], taps: [[0.5, 0.3], [1.2, -0.2], [2.3, 0.1]] },
  { id: '4x12', name: '4x12 Fechada', hp: 70, lp: 4500, lpOrder: 4, peaks: [[90, 6, 1.2], [400, -3, 1], [3000, 5, 1.5]], taps: [[0.4, 0.35], [1.1, -0.25], [2.6, 0.15]] },
  { id: '1x8', name: '1x8 Pequena', hp: 220, lp: 3500, lpOrder: 3, peaks: [[1200, 6, 1], [2600, 3, 2]], taps: [[0.3, 0.3], [0.8, -0.2]] },
  { id: '4x10b', name: '4x10 Baixo', hp: 40, lp: 4000, lpOrder: 2, peaks: [[65, 4, 1], [800, 2, 1], [2500, 2, 1.5]], taps: [[0.6, 0.25], [1.5, -0.15]] },
  { id: '8x10b', name: '8x10 Baixo', hp: 35, lp: 3000, lpOrder: 3, peaks: [[80, 5, 1], [500, -2, 1]], taps: [[0.5, 0.3], [1.3, -0.2], [2.2, 0.12]] },
];

export function defaultRig(): AmpRig {
  return {
    on: true,
    pedals: Object.fromEntries(PEDALS.map((p) => [p.id, { on: false, p: pedalDefaults(p), ...(p.models ? { model: p.models[0].id } : {}) }])),
    amp: 'clean',
    knobs: { gain: 0.3, bass: 0.5, mid: 0.5, treble: 0.5, presence: 0.5, master: 0.5 },
    cab: '2x12',
    cabMix: 1,
  };
}

/** Monta um timbre a partir do padrão: amp, botões, caixa e pedais ligados (com valores opcionais). */
function preset(
  amp: string,
  knobs: Partial<AmpRig['knobs']>,
  cab: string,
  pedals: Record<string, number[] | true | { model: string; p: number[] }> = {},
): AmpRig {
  const r = defaultRig();
  r.amp = amp;
  r.knobs = { ...r.knobs, ...knobs };
  r.cab = cab;
  for (const [id, v] of Object.entries(pedals)) {
    r.pedals[id] = v === true ? { ...r.pedals[id], on: true } : Array.isArray(v) ? { on: true, p: v } : { on: true, p: v.p, model: v.model };
  }
  return r;
}

export const RIG_PRESETS: { name: string; make: () => AmpRig }[] = [
  { name: 'Limpo Cristalino', make: () => preset('clean', { gain: 0.2, treble: 0.6 }, '2x12', { comp: [0.4, 0.5], chorus: [0.25, 0.4, 0.35, 1, 1], reverb: [0.5, 0.55, 0.3, 1] }) },
  { name: 'Funk', make: () => preset('clean', { gain: 0.15, bass: 0.4, mid: 0.45, treble: 0.7, presence: 0.65 }, '1x12', { comp: [0.75, 0.5] }) },
  { name: 'Reggae Skank', make: () => preset('clean', { gain: 0.15, bass: 0.3, mid: 0.6, treble: 0.65 }, '1x12', { delay: [0.4, 0.25, 0.2, 0, 0, 0, 0, 0], reverb: [0.35, 0.5, 0.25, 0] }) },
  { name: 'Surf', make: () => preset('clean', { gain: 0.3, bass: 0.45, treble: 0.7 }, '2x12', { reverb: [0.65, 0.6, 0.6, 0], tremolo: [0.45, 0.3] }) },
  { name: 'Blues', make: () => preset('crunch', { gain: 0.35, mid: 0.6 }, '2x12', { overdrive: { model: 'odGreen', p: [0.3, 0.45, 0.6] }, reverb: [0.3, 0.45, 0.2, 0] }) },
  { name: 'Rock Clássico', make: () => preset('crunch', { gain: 0.6, mid: 0.55, treble: 0.55 }, '4x12') },
  { name: 'Hard Rock', make: () => preset('crunch', { gain: 0.8, bass: 0.55, mid: 0.6 }, '4x12', { gate: [0.45, 0.25], boost: [0.5, 0.2] }) },
  { name: 'Hardcore / Metal', make: () => preset('high', { gain: 0.7, bass: 0.6, mid: 0.4, treble: 0.6 }, '4x12', { gate: [0.55, 0.2], overdrive: { model: 'odGreen', p: [0, 0.6, 0.9] } }) },
  { name: 'Fuzz Anos 60', make: () => preset('clean', { gain: 0.3 }, '2x12', { fuzzbox: { model: 'fuzz', p: [0.7, 0.45, 0.5] } }) },
  // Psicodélico anos 70: fuzz de germânio, phaser lento, delay de fita na colcheia pontuada e mola
  { name: 'Psicodélico 70', make: () => preset('crunch', { gain: 0.45, bass: 0.5, mid: 0.6, treble: 0.55 }, '2x12', {
    fuzzbox: { model: 'fuzzGerm', p: [0.7, 0.5] },
    phaser: [0.15, 0.65, 0.6, 0.35, 0, 1],
    delay: [0.625, 0.4, 0.25, 0.35, 0, 1, 0, 1],
    reverb: [0.5, 0.5, 0.3, 0],
  }) },
  // órgão pelo rack: um pouco de crunch e a caixa rotativa no rápido
  { name: 'Órgão Psicodélico', make: () => preset('crunch', { gain: 0.25, bass: 0.55, mid: 0.55, treble: 0.5 }, '1x12', {
    rotary: [0.3, 0.5, 1, 1],
    reverb: [0.45, 0.45, 0.25, 0],
  }) },
  { name: 'Lo-fi', make: () => preset('crunch', { gain: 0.4, bass: 0.3 }, '1x8', { tremolo: [0.35, 0.35] }) },
  { name: 'Baixo', make: () => preset('bass', { gain: 0.25, bass: 0.55 }, '8x10b', { comp: [0.5, 0.5] }) },
];

// ---------- Impulse responses das caixas (geradas: filtros aplicados a um impulso) ----------

function biquad(x: Float32Array, type: 'lowpass' | 'highpass' | 'peaking', f: number, sr: number, q = Math.SQRT1_2, db = 0) {
  const w = (2 * Math.PI * Math.min(f, sr * 0.45)) / sr;
  const cos = Math.cos(w), alpha = Math.sin(w) / (2 * q), A = 10 ** (db / 40);
  let b0, b1, b2, a0, a1, a2;
  if (type === 'lowpass') [b0, b1, b2, a0, a1, a2] = [(1 - cos) / 2, 1 - cos, (1 - cos) / 2, 1 + alpha, -2 * cos, 1 - alpha];
  else if (type === 'highpass') [b0, b1, b2, a0, a1, a2] = [(1 + cos) / 2, -(1 + cos), (1 + cos) / 2, 1 + alpha, -2 * cos, 1 - alpha];
  else [b0, b1, b2, a0, a1, a2] = [1 + alpha * A, -2 * cos, 1 - alpha * A, 1 + alpha / A, -2 * cos, 1 - alpha / A];
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const y = (b0 * x[i] + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2) / a0;
    x2 = x1; x1 = x[i]; y2 = y1; y1 = y;
    x[i] = y;
  }
}

const irCache = new WeakMap<BaseAudioContext, Map<string, AudioBuffer>>();

export function cabIR(ctx: BaseAudioContext, id: string): AudioBuffer | null {
  const spec = CABS.find((c) => c.id === id);
  if (!spec) return null;
  let cache = irCache.get(ctx);
  if (!cache) irCache.set(ctx, (cache = new Map()));
  const hit = cache.get(id);
  if (hit) return hit;

  const sr = ctx.sampleRate;
  const len = Math.floor(sr * 0.08);
  const d = new Float32Array(len);
  d[0] = 1;
  for (const [ms, g] of spec.taps) d[Math.round((ms / 1000) * sr)] += g;
  biquad(d, 'highpass', spec.hp, sr);
  for (const [f, db, q] of spec.peaks) biquad(d, 'peaking', f, sr, q, db);
  for (let i = 0; i < spec.lpOrder; i++) biquad(d, 'lowpass', spec.lp, sr, 0.6);
  for (let i = Math.floor(len * 0.6); i < len; i++) d[i] *= (len - i) / (len * 0.4); // fim suave
  const buf = ctx.createBuffer(1, len, sr);
  buf.getChannelData(0).set(d);
  cache.set(id, buf);
  return buf;
}

/** O ConvolverNode exige o IR na mesma taxa do contexto (a exportação roda a 44,1 kHz). */
function fitRate(ctx: BaseAudioContext, b: AudioBuffer): AudioBuffer {
  if (b.sampleRate === ctx.sampleRate) return b;
  const ratio = b.sampleRate / ctx.sampleRate;
  const len = Math.max(1, Math.floor(b.length / ratio));
  const out = ctx.createBuffer(b.numberOfChannels, len, ctx.sampleRate);
  for (let c = 0; c < b.numberOfChannels; c++) {
    const src = b.getChannelData(c), dst = out.getChannelData(c);
    for (let i = 0; i < len; i++) {
      const x = i * ratio, j = Math.floor(x), f = x - j;
      dst[i] = src[j] * (1 - f) + (src[j + 1] ?? 0) * f;
    }
  }
  return out;
}

// ---------- Blocos de áudio ----------

const curves = new Map<Curve, Float32Array<ArrayBuffer>>();
function curve(kind: Curve) {
  let c = curves.get(kind);
  if (!c) {
    const n = 4096;
    c = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1)) * 2 - 1;
      c[i] =
        kind === 'soft' ? Math.tanh(2.5 * x) / Math.tanh(2.5)
        : kind === 'hard' ? (7 * x) / (1 + 6 * Math.abs(x))
        // fita: ganho 1 nos sinais baixos (não realimenta o laço do delay), comprime só os picos
        : kind === 'tape' ? Math.tanh(1.5 * x) / 1.5
        : kind === 'germ' ? Math.tanh(1.4 * x) / Math.tanh(1.4) // diodo de germânio: joelho baixo e bem macio
        // diodos de silício para a terra (op-amp com clipagem dura, mas com joelho arredondado)
        : kind === 'diode' ? (4 * x) / (1 + Math.abs(4 * x) ** 2.5) ** 0.4 / 0.988
        // transistor de germânio polarizado: o lado negativo satura antes (assimetria → harmônicos pares)
        : kind === 'germAsym' ? (x >= 0 ? Math.tanh(1.2 * x) / Math.tanh(1.2) : (-0.8 * Math.tanh(-2.5 * x)) / Math.tanh(2.5))
        // JFET: lei quadrática (x + x²) → curva levemente torta, harmônicos pares; satura bem devagar
        : kind === 'fet' ? Math.tanh(1.4 * x + 0.35 * x * x) / Math.tanh(1.75)
        : x >= 0 ? Math.tanh(3 * x) / Math.tanh(3) : (-0.7 * Math.tanh(-6 * x)) / Math.tanh(6);
    }
    curves.set(kind, c);
  }
  return c;
}

/** Um efeito: caminho processado de `in` até `out`; `set` recebe os botões (0..1). */
interface Fx {
  in: AudioNode;
  out: AudioNode;
  set(p: number[]): void;
  oscs?: AudioScheduledSourceNode[];
  /** recebe o andamento da música (BPM) antes do set; só os pedais que sincronizam usam */
  tempo?(bpm: number): void;
  /** recebe o modelo escolhido antes do set; só os pedais com modelos usam */
  model?(id: string | undefined): void;
}

type Put = (param: AudioParam, v: number) => void;

function filter(ctx: BaseAudioContext, type: BiquadFilterType, f: number, q = Math.SQRT1_2, db = 0) {
  const n = ctx.createBiquadFilter();
  n.type = type;
  n.frequency.value = f;
  n.Q.value = q;
  n.gain.value = db;
  return n;
}

function shaper(ctx: BaseAudioContext, kind: Curve) {
  const s = ctx.createWaveShaper();
  s.curve = curve(kind);
  s.oversample = '4x';
  return s;
}

function lfo(ctx: BaseAudioContext) {
  const o = ctx.createOscillator();
  const depth = ctx.createGain();
  o.connect(depth);
  o.start(0);
  return { o, depth };
}

const expMap = (v: number, a: number, b: number) => a * (b / a) ** v;

function drivePedal(ctx: BaseAudioContext, put: Put, hp: number, range: number, kind: Curve, toneA: number, toneB: number, outScale: number): Fx {
  const h = filter(ctx, 'highpass', hp);
  const pre = ctx.createGain();
  const sh = shaper(ctx, kind);
  const dc = filter(ctx, 'highpass', 25);
  const tone = filter(ctx, 'lowpass', 3000);
  const out = ctx.createGain();
  h.connect(pre).connect(sh).connect(dc).connect(tone).connect(out);
  return {
    in: h,
    out,
    set: ([drive, t, level]) => {
      put(pre.gain, 1 + drive * range);
      put(tone.frequency, expMap(t, toneA, toneB));
      put(out.gain, outScale * level * 2);
    },
  };
}

/**
 * Noise gate com nós nativos (funciona igual ao vivo e na exportação):
 * sinal → ganho (põe o limiar em ~0,4) → retificador |x| → passa-baixas (envelope) → curva de abertura.
 * A abertura segue por dois caminhos: um rápido (ataque, ~3,5 ms medido em simulação) e um lento (release). A soma, limitada
 * em 1, se comporta como o maior dos dois: abre na hora da palhetada e fecha devagar quando a nota morre.
 */
function noiseGate(ctx: BaseAudioContext, put: Put): Fx {
  const inp = ctx.createGain();
  const vca = ctx.createGain();
  vca.gain.value = 0;
  const pre = ctx.createGain();
  const rect = ctx.createWaveShaper();
  rect.curve = gateCurve('rect');
  const env = filter(ctx, 'lowpass', 150);
  const open = ctx.createWaveShaper();
  open.curve = gateCurve('open');
  const fast = filter(ctx, 'lowpass', 1 / (2 * Math.PI * 0.001));
  const rel = filter(ctx, 'lowpass', 5);
  const sum = ctx.createGain();
  const clamp = ctx.createWaveShaper();
  clamp.curve = gateCurve('clamp');
  inp.connect(vca);
  inp.connect(pre).connect(rect).connect(env).connect(open);
  open.connect(fast).connect(sum);
  open.connect(rel).connect(sum);
  sum.connect(clamp).connect(vca.gain);
  return {
    in: inp,
    out: vca,
    set: ([thr, release]) => {
      const db = -80 + thr * 50; // -80 dB a -30 dB
      put(pre.gain, 0.4 / 10 ** (db / 20));
      put(rel.frequency, 1 / (2 * Math.PI * (0.02 + release * 0.38))); // release de 20 ms a 400 ms
    },
  };
}

const gateCurves = new Map<string, Float32Array<ArrayBuffer>>();
function gateCurve(kind: 'rect' | 'open' | 'clamp') {
  let c = gateCurves.get(kind);
  if (!c) {
    const n = 2048;
    c = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1)) * 2 - 1;
      if (kind === 'rect') c[i] = Math.abs(x);
      // entradas acima de 1 ficam no último ponto da curva (1): é o limite da soma dos caminhos
      else if (kind === 'clamp') c[i] = Math.max(0, x);
      else {
        // fechado abaixo de 0,15, aberto acima de 0,35, transição suave no meio
        const t = Math.min(1, Math.max(0, (x - 0.15) / 0.2));
        c[i] = t * t * (3 - 2 * t);
      }
    }
    gateCurves.set(kind, c);
  }
  return c;
}

/** Passa-altas de 1ª ordem (um capacitor + um resistor): gira bem menos a fase que o biquad de 2ª ordem. */
function highpass1(ctx: BaseAudioContext, fc: number) {
  const k = Math.tan((Math.PI * fc) / ctx.sampleRate);
  return ctx.createIIRFilter([1 / (1 + k), -1 / (1 + k)], [1, (k - 1) / (1 + k)]);
}

/**
 * Overdrive com os diodos na realimentação do amplificador operacional (estilo TS808 / SD-1):
 * a saída é o sinal limpo + a parte clipada. Antes de clipar, um passa-altas em ~720 Hz tira os graves
 * só do caminho sujo, o que dá o "calombo" de médios e deixa o grave limpo e firme.
 */
function feedbackDrive(
  ctx: BaseAudioContext,
  put: Put,
  o: { min: number; range: number; curve: Curve; bassCut: number; hump: [number, number]; toneA: number; toneB: number; out: number },
): Fx {
  const inp = ctx.createGain();
  const sum = ctx.createGain();
  const hp = highpass1(ctx, 720);
  const pre = ctx.createGain();
  const sh = shaper(ctx, o.curve);
  const clipLevel = ctx.createGain();
  clipLevel.gain.value = 0.5; // os diodos limitam a parte suja a ~0,5 do sinal cheio
  inp.connect(sum); // caminho limpo
  inp.connect(hp).connect(pre).connect(sh).connect(clipLevel).connect(sum);
  const dc = filter(ctx, 'highpass', 30);
  const bass = filter(ctx, 'lowshelf', 250, 0.7, -o.bassCut); // grave enxuto na saída
  const hump = filter(ctx, 'peaking', o.hump[0], 0.7, o.hump[1]);
  const tone = filter(ctx, 'lowpass', 3000, 0.6);
  const out = ctx.createGain();
  sum.connect(dc).connect(bass).connect(hump).connect(tone).connect(out);
  return {
    in: inp,
    out,
    set: ([drive, t, level]) => {
      put(pre.gain, o.min + drive * o.range);
      put(tone.frequency, expMap(t, o.toneA, o.toneB));
      put(out.gain, o.out * level * 2);
    },
  };
}

/**
 * Overdrive transparente (estilo Klon Centaur): o botão de ganho é duplo, baixa o caminho limpo
 * (banda cheia, graves intactos) enquanto sobe o caminho sujo (diodos de germânio, bem macios).
 * Com pouco ganho funciona quase como um boost limpo.
 */
function transparentDrive(ctx: BaseAudioContext, put: Put): Fx {
  const inp = ctx.createGain();
  const clean = ctx.createGain();
  const hp = highpass1(ctx, 250);
  const pre = ctx.createGain();
  const sh = shaper(ctx, 'germ');
  const lp = filter(ctx, 'lowpass', 6500);
  const dirty = ctx.createGain();
  const sum = ctx.createGain();
  inp.connect(clean).connect(sum);
  inp.connect(hp).connect(pre).connect(sh).connect(lp).connect(dirty).connect(sum);
  const mid = filter(ctx, 'peaking', 1000, 0.8, 0.5);
  const treble = filter(ctx, 'highshelf', 1500);
  const dc = filter(ctx, 'highpass', 30);
  const out = ctx.createGain();
  sum.connect(mid).connect(treble).connect(dc).connect(out);
  return {
    in: inp,
    out,
    set: ([gain, tr, level]) => {
      put(clean.gain, 1 - gain * 0.5);
      put(pre.gain, 1 + gain * 50);
      put(dirty.gain, 0.1 + gain * 0.35);
      put(treble.gain, (tr - 0.5) * 20);
      put(out.gain, 0.5 * level * 2);
    },
  };
}

/** Estado de um pedal no rack (convertendo o que foi salvo em formatos antigos). */
export function pedalOf(rig: AmpRig, d: PedalDef): PedalState {
  if (d.models) return rig.pedals[d.id] ?? fromSeparate(rig, d);
  const st = rig.pedals[d.id] ?? { on: false, p: pedalDefaults(d) };
  return d.id === 'delay' ? { ...st, p: migrateDelay(st.p, d) } : st;
}

/**
 * Projetos de antes dos pedais com modelos tinham um pedal separado por circuito (e, bem antes, um
 * overdrive genérico 'od', que virou o Verde). O pedal novo fica ligado se algum deles estava, no
 * circuito do primeiro ligado (na ordem dos modelos); os ajustes de todos ficam guardados.
 */
function fromSeparate(rig: AmpRig, d: PedalDef): PedalState {
  const models = d.models!;
  const old = (id: string) => rig.pedals[id] ?? (id === 'odGreen' ? rig.pedals.od : undefined);
  const saved: Record<string, number[]> = {};
  for (const m of models) {
    const o = old(m.id);
    if (o) saved[m.id] = o.p;
  }
  const active = models.find((m) => old(m.id)?.on) ?? models.find((m) => old(m.id)) ?? models[0];
  return { on: models.some((m) => old(m.id)?.on), model: active.id, p: saved[active.id] ?? pedalDefaults(d, active.id), saved };
}

/**
 * Delay salvo antes do botão Mod.: eram 3 botões e até 3 chaves (no máximo 6 valores). Insere o Mod.
 * (desligado, como o som antigo) na 4ª posição e completa o resto com os padrões. O resultado sempre
 * tem todos os valores, então nunca é convertido de novo.
 */
function migrateDelay(p: number[], d: PedalDef): number[] {
  const full = pedalDefaults(d);
  if (p.length >= full.length) return p;
  const fixed = [...p.slice(0, 3), 0, ...p.slice(3)];
  return full.map((v, i) => fixed[i] ?? v);
}

// ---------- Chorus ----------

/**
 * LFO com fase própria: onda de um ciclo (senoide ou quase-triangular) deslocada de `phase` (0..1).
 * Osciladores com a mesma frequência, ligados no mesmo instante, ficam travados com essa defasagem.
 */
function phasedWave(ctx: BaseAudioContext, phase: number, triangle: boolean) {
  const harmonics = triangle ? [1, 0, -1 / 9, 0, 1 / 25, 0, -1 / 49] : [1];
  const real = new Float32Array(harmonics.length + 1), imag = new Float32Array(harmonics.length + 1);
  harmonics.forEach((a, i) => {
    const k = i + 1, ph = 2 * Math.PI * phase * k;
    real[k] = a * Math.sin(ph);
    imag[k] = a * Math.cos(ph);
  });
  return ctx.createPeriodicWave(real, imag, { disableNormalization: false });
}

/**
 * Chorus de três vozes: cada voz é um atraso curto (base diferente para não se alinharem) varrido por um
 * LFO defasado 120° dos outros, então a soma não "pulsa" junto como num chorus de uma voz. Estéreo:
 * uma voz em cada lado e uma no centro, o som direto no meio (o efeito abre sem perder o centro).
 * Analógico: LFO triangular, vozes escuras (filtro como o dos chips BBD) e um leve arredondamento;
 * Digital: LFO senoidal e vozes com o agudo inteiro.
 */
function chorusPedal(ctx: BaseAudioContext, put: Put): Fx {
  const inp = ctx.createGain(), out = ctx.createGain(), wet = ctx.createGain();
  inp.connect(out); // direto
  wet.connect(out);
  const bases = [0.0072, 0.0094, 0.0118]; // bases diferentes: as vozes nunca se alinham
  const pans = [-1, 1, 0];
  // as duas redes (analógica e digital) existem juntas; a chave só troca qual delas soa
  const nets = [true, false].map((analog) => {
    const g = ctx.createGain();
    g.gain.value = 0;
    g.connect(wet);
    const voices = bases.map((base, k) => {
      const d = ctx.createDelay(0.05);
      d.delayTime.value = base;
      const o = ctx.createOscillator();
      o.setPeriodicWave(phasedWave(ctx, k / 3, analog));
      const depth = ctx.createGain();
      o.connect(depth).connect(d.delayTime);
      o.start(0);
      const tone = filter(ctx, 'lowpass', analog ? 5500 : 16000, 0.6); // analógico: escuro como o BBD
      const pan = ctx.createStereoPanner();
      inp.connect(d).connect(tone).connect(pan).connect(g);
      return { o, depth, pan };
    });
    return { g, voices };
  });
  return {
    in: inp,
    out,
    oscs: nets.flatMap((n) => n.voices.map((v) => v.o)),
    set: ([rate, depth, mix, kind, side]) => {
      const analog = (kind ?? 0) < 0.5;
      const stereo = (side ?? 1) >= 0.5;
      const f = expMap(rate ?? 0.3, 0.08, 6);
      const amt = 0.0004 + (depth ?? 0.5) * 0.0035;
      nets.forEach((n, i) => {
        put(n.g.gain, (i === 0) === analog ? 0.5 : 0);
        n.voices.forEach((v, k) => {
          put(v.o.frequency, f);
          put(v.depth.gain, amt);
          put(v.pan.pan, stereo ? pans[k] : 0);
        });
      });
      put(wet.gain, mix ?? 0.5);
      put(out.gain, 1 / (1 + (mix ?? 0.5) * 0.6));
    },
  };
}

// ---------- Rotary ----------

/** Velocidades (Hz) e inércia (constante de tempo, s) de cada rotor: a corneta é leve, o tambor pesado. */
const ROTORS = {
  horn: { slow: 0.83, fast: 6.7, tau: 0.35, xover: 'highpass' as const, doppler: 0.00035, am: 0.45, mics: 0.25 },
  drum: { slow: 0.67, fast: 5.8, tau: 1.3, xover: 'lowpass' as const, doppler: 0.00012, am: 0.3, mics: 0.25 },
};

/**
 * Rotary (caixa Leslie): pré com leve saturação valvulada → divisor em 800 Hz → corneta (agudos) e tambor
 * (graves). Cada rotor gira: o som se aproxima e se afasta do microfone (efeito Doppler = atraso varrido)
 * e fica mais alto quando aponta para ele (modulação de volume, 90° adiantada em relação ao Doppler).
 * Dois microfones, um de cada lado, captam o rotor em fases diferentes: o estéreo "gira".
 * Trocar Lento/Rápido não pula de velocidade: a corneta acelera em ~1 s e o tambor em ~4 s.
 */
/** Velocidade do rotary vinda da automação: número (≥ 0,5 = rápido) parado no cursor; 'scheduled' = a automação agenda as trocas. */
export type SpeedOverride = number | 'scheduled' | undefined;

interface RotaryFx extends Fx {
  override(v: SpeedOverride): void;
  /** agenda a velocidade: começa indo para `startFast` em `at` e troca em cada instante de `changes` (com a inércia de cada rotor) */
  schedule(startFast: boolean, at: number, changes: { time: number; fast: boolean }[]): void;
  /** congela as rampas onde estão (ao parar a música) */
  hold(now: number): void;
}

function rotaryPedal(ctx: BaseAudioContext, put: Put): RotaryFx {
  const inp = ctx.createGain(), out = ctx.createGain(), dry = ctx.createGain(), wet = ctx.createGain();
  inp.connect(dry).connect(out);
  const drive = ctx.createGain();
  const sat = shaper(ctx, 'soft');
  const satOut = ctx.createGain();
  inp.connect(drive).connect(sat).connect(satOut);
  const merge = ctx.createChannelMerger(2);
  merge.connect(wet).connect(out);
  const oscs: OscillatorNode[] = [];
  const rotors = (Object.keys(ROTORS) as (keyof typeof ROTORS)[]).map((name) => {
    const r = ROTORS[name];
    const x1 = filter(ctx, r.xover, 800), x2 = filter(ctx, r.xover, 800); // 24 dB/oitava
    const level = ctx.createGain();
    satOut.connect(x1).connect(x2).connect(level);
    // a corneta não reproduz o agudo extremo
    const src: AudioNode = name === 'horn' ? level.connect(filter(ctx, 'lowpass', 6500)) : level;
    const rotorOscs: OscillatorNode[] = [];
    const osc = (phase: number) => {
      const o = ctx.createOscillator();
      o.setPeriodicWave(phasedWave(ctx, phase, false));
      o.frequency.value = r.slow;
      o.start(0);
      oscs.push(o);
      rotorOscs.push(o);
      return o;
    };
    [0, 1].forEach((side) => {
      const ph = side * r.mics;
      // Doppler: atraso varrido
      const d = ctx.createDelay(0.01);
      d.delayTime.value = 0.002;
      const dep = ctx.createGain();
      dep.gain.value = r.doppler;
      osc(ph).connect(dep).connect(d.delayTime);
      // volume: 1 - am/2 ± am/2, adiantado 90°
      const vca = ctx.createGain();
      vca.gain.value = 1 - r.am / 2;
      const amG = ctx.createGain();
      amG.gain.value = r.am / 2;
      osc(ph + 0.25).connect(amG).connect(vca.gain);
      src.connect(d).connect(vca).connect(merge, 0, side);
    });
    return { name, r, level, oscs: rotorOscs };
  });
  /** última velocidade pedida (null = ainda não ajustada; undefined = a automação mexeu, não se sabe) */
  let fast: boolean | null | undefined = null;
  let over: SpeedOverride;
  let last: number[] = [];
  /** leva os rotores para a velocidade com a inércia de cada um, a partir de `t` */
  const rampTo = (want: boolean, t: number) => {
    for (const rt of rotors) {
      const f = want ? rt.r.fast : rt.r.slow;
      // todos os osciladores do rotor recebem a mesma curva: continuam travados nas fases deles
      for (const o of rt.oscs) o.frequency.setTargetAtTime(f, t, rt.r.tau);
    }
  };
  const fx: RotaryFx = {
    in: inp,
    out,
    oscs,
    override: (v) => {
      over = v;
      fx.set(last);
    },
    schedule: (startFast, at, changes) => {
      for (const o of oscs) o.frequency.cancelScheduledValues(at);
      rampTo(startFast, at);
      for (const c of changes) rampTo(c.fast, c.time);
      fast = undefined;
    },
    hold: (now) => {
      for (const o of oscs) {
        if (o.frequency.cancelAndHoldAtTime) o.frequency.cancelAndHoldAtTime(now);
        else o.frequency.cancelScheduledValues(now);
      }
      fast = undefined;
    },
    set: (p) => {
      last = p;
      const [drv, bal, mix, knob] = p;
      // a curva soft amplifica ~2,5x os sinais baixos: a saída compensa, então o Drive muda o caráter e não o volume
      const dg = 0.4 + (drv ?? 0.2) * 6;
      put(drive.gain, dg);
      put(satOut.gain, 1 / (dg * 2.5));
      const b = bal ?? 0.5;
      for (const rt of rotors) put(rt.level.gain, rt.name === 'horn' ? Math.min(1, 2 * b) : Math.min(1, 2 * (1 - b)));
      const m = mix ?? 1;
      put(dry.gain, 1 - m);
      put(wet.gain, m * 0.9);
      // automação tocando: as trocas já estão agendadas (mexer aqui brigaria com elas)
      if (over === 'scheduled') return;
      const want = (typeof over === 'number' ? over : knob ?? 0) >= 0.5;
      if (want === fast) return;
      const first = fast === null;
      fast = want;
      if (first) {
        for (const rt of rotors) for (const o of rt.oscs) o.frequency.value = want ? rt.r.fast : rt.r.slow;
        return;
      }
      const now = ctx.currentTime;
      for (const o of oscs) {
        o.frequency.cancelScheduledValues(now);
        o.frequency.setValueAtTime(o.frequency.value, now);
      }
      rampTo(want, now);
    },
  };
  return fx;
}

// ---------- Compressor ----------

/** Nível de referência de uma palhetada (dBFS) usado na compensação automática de volume. */
const COMP_REF = -12;

/**
 * Compressor de pedal com quatro botões e dois caracteres:
 * - Sustain: limiar e razão juntos (mais sustain = comprime mais cedo e mais forte);
 * - Ataque: de 1 a 40 ms; devagar, o começo da nota passa antes da compressão (palhetada com "estalo");
 * - Blend: compressão paralela, mistura o som limpo de volta (dinâmica natural + sustain);
 * - Nível: volume de saída; no meio, uma palhetada sai no mesmo volume que entrou (compensação automática).
 * Pedal (estilo Dyna Comp): razão alta, joelho curto, recuperação rápida e agudo arredondado.
 * Estúdio: razão baixa, joelho largo, recuperação mais lenta, sem mexer no timbre.
 */
function compPedal(ctx: BaseAudioContext, put: Put): Fx {
  const inp = ctx.createGain(), out = ctx.createGain(), dry = ctx.createGain(), wet = ctx.createGain();
  const c = ctx.createDynamicsCompressor();
  const tone = filter(ctx, 'lowpass', 20000, 0.5);
  inp.connect(dry).connect(out);
  inp.connect(c).connect(tone).connect(wet).connect(out);
  return {
    in: inp,
    out: out,
    set: ([sus, lvl, att, blend, mode]) => {
      const studio = (mode ?? 0) >= 0.5;
      const s = sus ?? 0.5;
      const threshold = studio ? -6 - s * 34 : -10 - s * 40;
      const ratio = studio ? 2 + s * 4 : 6 + s * 14;
      put(c.threshold, threshold);
      put(c.ratio, ratio);
      put(c.knee, studio ? 12 : 3);
      put(c.attack, expMap(att ?? 0.35, 0.001, 0.04));
      put(c.release, studio ? 0.3 : 0.1);
      put(tone.frequency, studio ? 20000 : 6500);
      // compensação: o quanto uma palhetada no nível de referência é reduzida. O compressor do Web Audio já
      // aplica sozinho um ganho de ~60% da redução de um sinal em 0 dBFS; aqui entra só a diferença.
      const slope = 1 - 1 / ratio;
      const reduction = Math.max(0, (COMP_REF - threshold) * slope);
      const builtIn = 0.6 * -threshold * slope;
      const b = blend ?? 0.85;
      put(wet.gain, b * 10 ** ((reduction - builtIn) / 20));
      put(dry.gain, 1 - b);
      put(out.gain, (lvl ?? 0.5) * 2);
    },
  };
}

// ---------- Phaser ----------

/** Phaser do AudioWorklet 'mm-phaser' (ver master.worklet.ts): direto + sinal defasado = os vales que andam. */
/**
 * Univibe (AudioWorklet 'mm-univibe', ver master.worklet.ts) com o pré do circuito original: um pouco de
 * ganho e saturação suave na entrada. Sem os worklets carregados, só passa o som (com o volume).
 */
function univibePedal(ctx: BaseAudioContext, put: Put): Fx {
  const inp = ctx.createGain(), out = ctx.createGain(), dry = ctx.createGain(), wet = ctx.createGain();
  const pre = ctx.createGain();
  pre.gain.value = 1.4;
  const sat = shaper(ctx, 'tape');
  inp.connect(pre).connect(sat);
  sat.connect(dry).connect(out);
  const node = workletsReady(ctx)
    ? new AudioWorkletNode(ctx, 'mm-univibe', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] })
    : null;
  if (node) sat.connect(node).connect(wet).connect(out);
  return {
    in: inp,
    out,
    set: ([rate, depth, vol, mode]) => {
      const vibrato = (mode ?? 0) >= 0.5;
      if (node) {
        put(node.parameters.get('rate')!, expMap(rate ?? 0.35, 0.4, 12));
        put(node.parameters.get('depth')!, depth ?? 0.65);
      }
      // Chorus: direto + defasado (meio a meio); Vibrato: só o defasado; sem worklet: só o direto
      put(dry.gain, !node ? 1 : vibrato ? 0 : 0.5);
      put(wet.gain, vibrato ? 1 : 0.5);
      put(out.gain, ((vol ?? 0.5) * 2) / 1.4 * (vibrato ? 1 : 1.3));
    },
  };
}

function phaserPedal(ctx: BaseAudioContext, put: Put): Fx {
  const inp = ctx.createGain(), out = ctx.createGain(), wet = ctx.createGain();
  const node = new AudioWorkletNode(ctx, 'mm-phaser', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2] });
  inp.connect(out);
  inp.connect(node).connect(wet).connect(out);
  const param = (name: string) => node.parameters.get(name)!;
  return {
    in: inp,
    out,
    set: ([rate, depth, amt, fb, stages, side]) => {
      put(param('rate'), expMap(rate ?? 0.25, 0.05, 8));
      put(param('depth'), depth ?? 0.6);
      const feedback = (fb ?? 0.3) * 0.85;
      put(param('feedback'), feedback);
      param('stages').value = (stages ?? 0) >= 0.5 ? 8 : 4; // número de estágios não pode passar por valores intermediários
      param('stereo').value = (side ?? 1) >= 0.5 ? 1 : 0;
      const m = amt ?? 0.6;
      put(wet.gain, m * (1 - feedback * 0.7)); // a ressonância sobe o volume do defasado: compensa
      put(out.gain, 1 / (1 + m * 0.5));
    },
  };
}

// ---------- Tremolo ----------

const tremCurves = new Map<number, Float32Array<ArrayBuffer>>();
/** Curva que deforma a senoide do LFO: passo 0 = senoide pura, passo 20 = quase quadrada (corte seco). */
function tremCurve(step: number) {
  let c = tremCurves.get(step);
  if (!c) {
    const k = 0.3 + (step / 20) ** 2 * 30;
    const n = 1024;
    c = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1)) * 2 - 1;
      c[i] = Math.tanh(k * x) / Math.tanh(k);
    }
    tremCurves.set(step, c);
  }
  return c;
}

/**
 * Tremolo: um LFO (senoide deformada pela Forma) mexe no volume. Clássico: o sinal inteiro. Harmônico:
 * o sinal é dividido em 650 Hz e graves e agudos recebem o LFO com fases opostas (um sobe quando o
 * outro desce). Estéreo: o lado direito recebe o LFO invertido, o som passeia entre os lados.
 * Cada "VCA" tem a sua polaridade (+1/-1), então trocar o modo só ajusta ganhos, sem religar nada.
 */
function tremoloPedal(ctx: BaseAudioContext, put: Put): Fx {
  const inp = ctx.createGain(), merge = ctx.createChannelMerger(2);
  const o = ctx.createOscillator();
  o.start(0);
  const shape = ctx.createWaveShaper();
  shape.curve = tremCurve(3);
  const depth = ctx.createGain();
  o.connect(shape).connect(depth);
  const classic = ctx.createGain(), harm = ctx.createGain();
  inp.connect(classic);
  inp.connect(harm);
  // agudos = sinal - graves (complementares: somados dão o sinal original, sem vale em 650 Hz)
  const lp = filter(ctx, 'lowpass', 650), hp = ctx.createGain(), neg = ctx.createGain();
  neg.gain.value = -1;
  harm.connect(lp);
  harm.connect(hp);
  lp.connect(neg).connect(hp);
  // VCAs: [fonte, canal, banda] → polaridade definida no set
  const vcas = ([
    [classic, 0, 'all'], [classic, 1, 'all'],
    [lp, 0, 'low'], [lp, 1, 'low'],
    [hp, 0, 'high'], [hp, 1, 'high'],
  ] as const).map(([src, ch, band]) => {
    const vca = ctx.createGain();
    const pol = ctx.createGain();
    depth.connect(pol).connect(vca.gain);
    src.connect(vca).connect(merge, 0, ch);
    return { vca, pol, ch, band };
  });
  let step = 3;
  return {
    in: inp,
    out: merge,
    oscs: [o],
    set: ([rate, dep, form, mode, side]) => {
      const harmonic = (mode ?? 0) >= 0.5;
      const stereo = (side ?? 0) >= 0.5;
      const d = dep ?? 0.5;
      put(o.frequency, 1 + (rate ?? 0.4) * 11);
      const st = Math.round((form ?? 0.15) * 20);
      if (st !== step) {
        step = st;
        shape.curve = tremCurve(st);
      }
      put(depth.gain, d / 2);
      put(classic.gain, harmonic ? 0 : 1);
      put(harm.gain, harmonic ? 1 : 0);
      for (const v of vcas) {
        put(v.vca.gain, 1 - d / 2);
        // agudos ao contrário dos graves; no estéreo, o lado direito ao contrário do esquerdo
        const sign = (v.band === 'high' ? -1 : 1) * (stereo && v.ch === 1 ? -1 : 1);
        put(v.pol.gain, sign);
      }
    },
  };
}

// ---------- Mais distorções ----------

/** Distorção Preta (estilo RAT): op-amp com ganho até ~400x, diodos de silício, filtro passa-baixas na saída. */
function blackDist(ctx: BaseAudioContext, put: Put): Fx {
  const hp = highpass1(ctx, 60);
  const emph = filter(ctx, 'peaking', 1000, 0.6, 3); // o op-amp perde agudos com ganho alto: médios na frente
  const pre = ctx.createGain();
  const sh = shaper(ctx, 'diode');
  const dc = filter(ctx, 'highpass', 30);
  const flt = filter(ctx, 'lowpass', 3000, 0.5);
  const out = ctx.createGain();
  hp.connect(emph).connect(pre).connect(sh).connect(dc).connect(flt).connect(out);
  return {
    in: hp,
    out,
    set: ([dist, f, vol]) => {
      put(pre.gain, 2 + dist ** 2 * 400);
      put(flt.frequency, expMap(1 - f, 600, 14000)); // Filtro para a direita = mais escuro
      put(out.gain, 0.3 * vol * 2);
    },
  };
}

/** Distorção Britânica (estilo amp num pedal): dois estágios assimétricos, como pré-amp valvulado, com médios. */
function britDist(ctx: BaseAudioContext, put: Put): Fx {
  const hp = highpass1(ctx, 90);
  const g1 = ctx.createGain();
  const s1 = shaper(ctx, 'asym');
  const between = filter(ctx, 'lowpass', 5500);
  const g2 = ctx.createGain();
  const s2 = shaper(ctx, 'soft');
  const dc = filter(ctx, 'highpass', 30);
  const mid = filter(ctx, 'peaking', 750, 0.8, 4);
  const tone = filter(ctx, 'highshelf', 2200);
  const cut = filter(ctx, 'lowpass', 7000);
  const out = ctx.createGain();
  hp.connect(g1).connect(s1).connect(between).connect(g2).connect(s2).connect(dc).connect(mid).connect(tone).connect(cut).connect(out);
  return {
    in: hp,
    out,
    set: ([gain, t, level]) => {
      put(g1.gain, 1.5 + gain * 12);
      put(g2.gain, 1 + gain * 6);
      put(tone.gain, (t - 0.5) * 18);
      put(out.gain, 0.32 * level * 2);
    },
  };
}

/** Distorção Metal (estilo MT-2): dois estágios duros em cascata e EQ ativo (grave forte, médios e agudos ajustáveis). */
function metalDist(ctx: BaseAudioContext, put: Put): Fx {
  const hp = highpass1(ctx, 100); // aperta o grave antes de distorcer: palm mute definido
  const g1 = ctx.createGain();
  const s1 = shaper(ctx, 'hard');
  const between = filter(ctx, 'lowpass', 6000);
  const g2 = ctx.createGain();
  const s2 = shaper(ctx, 'diode');
  const dc = filter(ctx, 'highpass', 30);
  const low = filter(ctx, 'lowshelf', 120, 0.7, 6);
  const mid = filter(ctx, 'peaking', 800, 0.9);
  const high = filter(ctx, 'highshelf', 3000);
  const fizz = filter(ctx, 'lowpass', 8000, 0.7); // corta o chiado de cima
  const out = ctx.createGain();
  hp.connect(g1).connect(s1).connect(between).connect(g2).connect(s2).connect(dc).connect(low).connect(mid).connect(high).connect(fizz).connect(out);
  return {
    in: hp,
    out,
    set: ([drive, m, h, level]) => {
      put(g1.gain, 5 + drive * 40);
      put(g2.gain, 2 + drive * 10);
      put(mid.gain, (m - 0.5) * 30); // -15 dB (cavado) a +15 dB
      put(high.gain, (h - 0.5) * 24);
      put(out.gain, 0.22 * (level ?? 0.5) * 2);
    },
  };
}

/**
 * Fuzz Muff (estilo Big Muff): dois estágios de clipagem com passa-baixas entre eles (o sustain longo e
 * liso) e o controle de tom clássico, que mistura um passa-baixas e um passa-altas: no meio os dois
 * se somam com um vale nos médios (~1 kHz).
 */
function muffFuzz(ctx: BaseAudioContext, put: Put): Fx {
  const hp = highpass1(ctx, 80);
  const g1 = ctx.createGain();
  const s1 = shaper(ctx, 'soft');
  const f1 = filter(ctx, 'lowpass', 3500);
  const g2 = ctx.createGain();
  const s2 = shaper(ctx, 'soft');
  const dc = filter(ctx, 'highpass', 30);
  const lp = filter(ctx, 'lowpass', 700, 0.5), hpT = filter(ctx, 'highpass', 1400, 0.5);
  const lg = ctx.createGain(), hg = ctx.createGain();
  const out = ctx.createGain();
  hp.connect(g1).connect(s1).connect(f1).connect(g2).connect(s2).connect(dc);
  dc.connect(lp).connect(lg).connect(out);
  dc.connect(hpT).connect(hg).connect(out);
  return {
    in: hp,
    out,
    set: ([sus, t, vol]) => {
      put(g1.gain, 3 + sus * 30);
      put(g2.gain, 2 + sus * 12);
      put(lg.gain, 1 - t);
      put(hg.gain, t * 1.3);
      put(out.gain, 0.45 * vol * 2);
    },
  };
}

/**
 * Fuzz Germânio (estilo Fuzz Face): um estágio assimétrico de germânio, ganho moderado e quase sem filtro
 * na entrada, então a dinâmica da palhetada aparece: tocando leve o som limpa.
 */
function germFuzz(ctx: BaseAudioContext, put: Put): Fx {
  const hp = highpass1(ctx, 40);
  const pre = ctx.createGain();
  const sh = shaper(ctx, 'germAsym');
  const dc = filter(ctx, 'highpass', 30);
  const warm = filter(ctx, 'lowpass', 4500, 0.6);
  const out = ctx.createGain();
  hp.connect(pre).connect(sh).connect(dc).connect(warm).connect(out);
  return {
    in: hp,
    out,
    set: ([fuzz, vol]) => {
      put(pre.gain, 1 + fuzz * 60);
      put(out.gain, 0.35 * vol * 2);
    },
  };
}

// ---------- Reverb: respostas ao impulso de mola e de sala ----------

/**
 * Mola: o som vai e volta numa mola de aço. A cada ida e volta ele passa por uma cascata de filtros
 * passa-tudo, que atrasam mais os graves que os agudos (dispersão): é isso que produz o "boing" metálico.
 * Duas molas de comprimentos diferentes por canal, como nos tanques reais de 2 e 3 molas.
 */
function springIR(sr: number, seconds: number): Float32Array[] {
  const len = Math.ceil(sr * (seconds + 0.2));
  const springs = [
    { T: 0.0333, a: 0.62 },
    { T: 0.0417, a: 0.58 },
    { T: 0.0291, a: 0.66 },
  ];
  const chans = [[0, 1], [1, 2]].map((ids) => {
    const out = new Float32Array(len);
    for (const id of ids) {
      const { T, a } = springs[id];
      const g = 10 ** ((-3 * T) / seconds); // queda por ida e volta para chegar a -60 dB em `seconds`
      const S = Math.round(0.05 * sr);
      const chirp = new Float32Array(S);
      chirp[0] = 1;
      let amp = 1;
      for (let k = 0; ; k++) {
        // mais um trecho de mola: 24 passa-tudo de 1ª ordem em série
        for (let st = 0; st < 24; st++) {
          let x1 = 0, y1 = 0;
          for (let n = 0; n < S; n++) {
            const x = chirp[n];
            const y = -a * x + x1 + a * y1;
            x1 = x; y1 = y; chirp[n] = y;
          }
        }
        const off = Math.round((0.004 + k * T) * sr);
        if (off >= len || amp < 1e-3) break;
        const sign = k % 2 ? -1 : 1; // a reflexão na ponta da mola inverte a fase
        for (let n = 0; n < S && off + n < len; n++) out[off + n] += sign * amp * chirp[n];
        amp *= g;
      }
    }
    biquad(out, 'highpass', 220, sr);
    biquad(out, 'peaking', 1600, sr, 1.2, 4); // o "brilho" característico do tanque
    biquad(out, 'lowpass', 5200, sr);
    return out;
  });
  return chans;
}

/** Sala (sem mola): reflexões iniciais + cauda de ruído que escurece com o tempo, independente em cada canal. */
function hallIR(sr: number, seconds: number): Float32Array[] {
  const len = Math.ceil(sr * seconds);
  const pre = Math.round(0.014 * sr);
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
  return [0, 1].map((c) => {
    const bright = new Float32Array(len), dark = new Float32Array(len);
    for (let n = pre; n < len; n++) {
      const t = (n - pre) / sr;
      bright[n] = rnd() * Math.exp((-6.9 * t) / (seconds * 0.45));
      dark[n] = rnd() * Math.exp((-6.9 * t) / seconds);
    }
    biquad(dark, 'lowpass', 2200, sr);
    const out = new Float32Array(len);
    for (let n = 0; n < len; n++) out[n] = 0.6 * bright[n] + dark[n];
    // reflexões iniciais (paredes próximas), diferentes em cada canal
    for (const [ms, g] of c ? [[11, 0.5], [19, -0.35], [31, 0.28], [47, -0.2]] : [[9, 0.55], [23, -0.3], [37, 0.25], [53, 0.18]]) {
      out[Math.round(((pre / sr) + ms / 1000) * sr)] += g * 3;
    }
    biquad(out, 'highpass', 120, sr);
    return out;
  });
}

/** Ruído pseudoaleatório reprodutível (as IRs saem sempre iguais). */
function noiseGen(seed: number) {
  let x = seed;
  return () => ((x = (x * 16807) % 2147483647) / 2147483647) * 2 - 1;
}

/**
 * Placa: uma chapa de aço vibrando. Sem reflexões iniciais (não há paredes), densidade altíssima desde o
 * começo e cauda brilhante que escurece pouco. Canais independentes = estéreo largo.
 */
function plateIR(sr: number, seconds: number): Float32Array[] {
  const len = Math.ceil(sr * seconds);
  const rnd = noiseGen(11);
  return [0, 1].map(() => {
    const bright = new Float32Array(len), body = new Float32Array(len);
    for (let n = 0; n < len; n++) {
      const t = n / sr;
      const attack = 1 - Math.exp(-t / 0.002);
      bright[n] = rnd() * attack * Math.exp((-6.9 * t) / (seconds * 0.8));
      body[n] = rnd() * attack * Math.exp((-6.9 * t) / seconds);
    }
    biquad(body, 'lowpass', 4500, sr);
    const out = new Float32Array(len);
    for (let n = 0; n < len; n++) out[n] = 0.7 * bright[n] + body[n];
    biquad(out, 'highpass', 180, sr);
    biquad(out, 'lowpass', 11000, sr);
    return out;
  });
}

/**
 * Hall (sala de concerto): pré-atraso de ~25 ms, reflexões iniciais esparsas das paredes, cauda que
 * cresce devagar (~40 ms) e escurece com o tempo (o ar e as paredes absorvem os agudos antes dos graves).
 */
function concertIR(sr: number, seconds: number): Float32Array[] {
  const len = Math.ceil(sr * (seconds + 0.05));
  const pre = Math.round(0.025 * sr);
  const rnd = noiseGen(29);
  return [0, 1].map((c) => {
    const hi = new Float32Array(len), mid = new Float32Array(len), lo = new Float32Array(len);
    for (let n = pre; n < len; n++) {
      const t = (n - pre) / sr;
      const build = 1 - Math.exp(-t / 0.04);
      hi[n] = rnd() * build * Math.exp((-6.9 * t) / (seconds * 0.35));
      mid[n] = rnd() * build * Math.exp((-6.9 * t) / (seconds * 0.7));
      lo[n] = rnd() * build * Math.exp((-6.9 * t) / seconds);
    }
    biquad(mid, 'lowpass', 3500, sr);
    biquad(lo, 'lowpass', 900, sr);
    const out = new Float32Array(len);
    for (let n = 0; n < len; n++) out[n] = 0.45 * hi[n] + 0.8 * mid[n] + lo[n];
    const er = c
      ? [[12, 0.45], [21, -0.32], [34, 0.3], [49, -0.22], [63, 0.2], [81, -0.15]]
      : [[10, 0.5], [24, -0.3], [31, 0.28], [52, -0.24], [70, 0.18], [77, -0.14]];
    for (const [ms, g] of er) out[pre + Math.round((ms / 1000) * sr)] += g * 4;
    biquad(out, 'highpass', 90, sr);
    return out;
  });
}

const reverbCache = new WeakMap<BaseAudioContext, Map<string, AudioBuffer>>();
/** IR do reverb (em cache): `type` = tipo; `step` = tempo quantizado (0..15) para não recalcular a cada movimento. */
function reverbIR(ctx: BaseAudioContext, type: ReverbType, step: number): AudioBuffer {
  let cache = reverbCache.get(ctx);
  if (!cache) reverbCache.set(ctx, (cache = new Map()));
  const key = `${type}|${step}`;
  let buf = cache.get(key);
  if (!buf) {
    const spec = REVERB_TYPES.find((r) => r.id === type)!;
    const seconds = spec.min + (step / 15) * (spec.max - spec.min);
    const sr = ctx.sampleRate;
    const chans =
      type === 'spring' ? springIR(sr, seconds)
      : type === 'plate' ? plateIR(sr, seconds)
      : type === 'room' ? hallIR(sr, seconds)
      : concertIR(sr, seconds); // hall e shimmer (o shimmer soma a oitava acima no laço, ver reverbPedal)
    buf = ctx.createBuffer(2, chans[0].length, ctx.sampleRate);
    chans.forEach((d, c) => buf!.getChannelData(c).set(d));
    cache.set(key, buf);
  }
  return buf;
}

/**
 * Pedal de reverb: troca de IR (tipo/tempo) com crossfade entre dois convolvers, sem estalo.
 * Shimmer: a cauda do hall passa por um pitch shifter (+1 oitava) e volta para a entrada do reverb;
 * cada volta sobe mais uma oitava e vai sumindo, o "brilho" etéreo dos pads de ambiente. O laço tem
 * filtros e um limitador suave, então não dispara mesmo com tempo longo.
 */
function reverbPedal(ctx: BaseAudioContext, put: Put): Fx {
  const inp = ctx.createGain(), out = ctx.createGain(), wet = ctx.createGain();
  const hp = filter(ctx, 'highpass', 120);
  const sum = ctx.createGain(); // saída somada dos convolvers
  const tone = filter(ctx, 'lowpass', 5000);
  inp.connect(out); // sinal seco
  inp.connect(hp);
  sum.connect(tone).connect(wet).connect(out);
  // laço do shimmer: reverb → oitava acima → filtros → limitador suave → atraso curto → entrada do reverb
  const shift = pitchPedal(ctx, put);
  shift.set([1, 0.5, 1]); // +12 semitons, só o som transposto
  const loop = ctx.createGain();
  loop.gain.value = 0;
  const loopDelay = ctx.createDelay(0.2);
  loopDelay.delayTime.value = 0.08;
  sum.connect(shift.in);
  shift.out
    .connect(filter(ctx, 'highpass', 400))
    .connect(filter(ctx, 'lowpass', 7000))
    .connect(loop)
    .connect(shaper(ctx, 'tape')) // limitador suave com ganho 1 nos sinais baixos (não aumenta o laço)
    .connect(loopDelay)
    .connect(hp);
  let cur: { conv: ConvolverNode; g: GainNode } | null = null;
  let key = '';
  return {
    in: inp,
    out,
    oscs: shift.oscs,
    set: ([time, t, mix, kind]) => {
      put(tone.frequency, expMap(t, 1500, 9000));
      put(wet.gain, mix * 1.2);
      const type = REVERB_TYPES[reverbType(kind ?? 0)].id;
      put(loop.gain, type === 'shimmer' ? 0.32 : 0);
      const step = Math.round(time * 15);
      const k = `${type}|${step}`;
      if (k === key) return;
      key = k;
      const conv = ctx.createConvolver();
      conv.buffer = reverbIR(ctx, type, step);
      const g = ctx.createGain();
      hp.connect(conv).connect(g).connect(sum);
      const old = cur;
      cur = { conv, g };
      if (!old) return;
      const now = ctx.currentTime;
      g.gain.setValueAtTime(0, now);
      g.gain.linearRampToValueAtTime(1, now + 0.08);
      old.g.gain.setValueAtTime(1, now);
      old.g.gain.linearRampToValueAtTime(0, now + 0.08);
      setTimeout(() => { old.conv.disconnect(); old.g.disconnect(); }, 200);
    },
  };
}

// ---------- Delay: fita ou digital, mono ou estéreo (ping-pong) ----------

interface DelayNet {
  input: GainNode;
  output: GainNode;
  oscs: OscillatorNode[];
  /** `seconds` = tempo do eco; `mod` (0..1) = quanto as repetições ondulam */
  set(seconds: number, rep: number, mod: number, put: Put): void;
}

/**
 * Uma rede de delay. Fita: repetições cada vez mais escuras e finas, saturação da fita no laço e
 * variação de velocidade (wow lento + flutter rápido). Digital: repetições limpas e iguais.
 * Estéreo: ping-pong, a 1ª repetição na esquerda, a seguinte na direita e assim por diante.
 */
function delayNet(ctx: BaseAudioContext, tape: boolean, stereo: boolean): DelayNet {
  const input = ctx.createGain(), output = ctx.createGain();
  const oscs: OscillatorNode[] = [];
  const line = () => {
    const d = ctx.createDelay(2.5);
    const hp = filter(ctx, 'highpass', tape ? 140 : 20);
    const lp = filter(ctx, 'lowpass', tape ? 2600 : 12000);
    const fb = ctx.createGain();
    let node: AudioNode = d.connect(hp).connect(lp);
    if (tape) node = node.connect(shaper(ctx, 'tape')); // a fita satura e comprime as repetições
    return { d, out: node, fb };
  };
  const lines = stereo ? [line(), line()] : [line()];
  if (stereo) {
    const [L, R] = lines;
    const merge = ctx.createChannelMerger(2);
    input.connect(L.d);
    L.out.connect(merge, 0, 0);
    R.out.connect(merge, 0, 1);
    L.out.connect(L.fb).connect(R.d); // esquerda → direita
    R.out.connect(R.fb).connect(L.d); // direita → esquerda
    merge.connect(output);
  } else {
    const [M] = lines;
    input.connect(M.d);
    M.out.connect(M.fb).connect(M.d);
    M.out.connect(output);
  }
  // Mod.: um LFO lento (~0,7 Hz) faz as repetições ondularem como num chorus (o delay "analógico")
  const modOsc = ctx.createOscillator(), modDepth = ctx.createGain();
  modOsc.frequency.value = 0.7;
  modOsc.connect(modDepth);
  lines.forEach((l, i) => {
    if (i === 0) modDepth.connect(l.d.delayTime);
    else {
      // no estéreo o outro lado ondula ao contrário: as repetições se abrem
      const inv = ctx.createGain();
      inv.gain.value = -1;
      modDepth.connect(inv).connect(l.d.delayTime);
    }
  });
  modOsc.start(0);
  oscs.push(modOsc);
  // fita: wow (0,5 Hz) e flutter (6 Hz) mexem no tempo do delay → leve oscilação de afinação
  const wowDepth = ctx.createGain(), flutDepth = ctx.createGain();
  if (tape) {
    for (const [f, g] of [[0.5, wowDepth], [6.2, flutDepth]] as const) {
      const o = ctx.createOscillator();
      o.frequency.value = f;
      o.connect(g);
      for (const l of lines) g.connect(l.d.delayTime);
      o.start(0);
      oscs.push(o);
    }
  }
  return {
    input, output, oscs,
    set: (t, rep, mod, put) => {
      put(modDepth.gain, mod * 0.0025); // até ±2,5 ms
      for (const l of lines) {
        put(l.d.delayTime, t);
        put(l.fb.gain, rep * (tape ? 0.95 : 0.85)); // a saturação da fita segura o laço, então dá para ir mais longe
      }
      if (tape) {
        put(wowDepth.gain, 0.0012 + t * 0.002);
        put(flutDepth.gain, 0.00015);
      }
    },
  };
}

/**
 * Delay reverso (AudioWorklet 'mm-reverse', ver master.worklet.ts). Na fita as repetições saem mais
 * escuras e saturadas; no estéreo, abertas (um lado um pouco atrasado). Sem os worklets carregados,
 * cai para o delay comum.
 */
function reverseNet(ctx: BaseAudioContext, tape: boolean, stereo: boolean): DelayNet {
  if (!workletsReady(ctx)) return delayNet(ctx, tape, stereo);
  const input = ctx.createGain(), output = ctx.createGain();
  const node = new AudioWorkletNode(ctx, 'mm-reverse', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
  let tail: AudioNode = input.connect(node);
  if (tape) tail = tail.connect(filter(ctx, 'lowpass', 3200)).connect(shaper(ctx, 'tape'));
  if (stereo) {
    // abre o eco: esquerda direto, direita 12 ms depois
    const merge = ctx.createChannelMerger(2);
    const d = ctx.createDelay(0.05);
    d.delayTime.value = 0.012;
    tail.connect(merge, 0, 0);
    tail.connect(d).connect(merge, 0, 1);
    tail = merge;
  }
  tail.connect(output);
  return {
    input, output, oscs: [],
    set: (seconds, rep, _mod, put) => {
      put(node.parameters.get('time')!, Math.min(3, Math.max(0.15, seconds)));
      put(node.parameters.get('feedback')!, rep * 0.85);
    },
  };
}

/** Pedal de delay: troca de tipo/saída/sentido monta outra rede e faz crossfade com a anterior. */
function delayPedal(ctx: BaseAudioContext, put: Put): Fx {
  const inp = ctx.createGain(), out = ctx.createGain(), wet = ctx.createGain();
  let bpm = 120;
  inp.connect(out); // sinal seco
  wet.connect(out);
  let cur: { net: DelayNet; g: GainNode } | null = null;
  let key = '';
  const fx: Fx = {
    in: inp,
    out,
    oscs: [],
    tempo: (b) => {
      bpm = b;
    },
    set: ([time, rep, mix, mod, kind, side, dir, sync]) => {
      put(wet.gain, mix);
      const tape = (kind ?? 0) < 0.5;
      const stereo = (side ?? 0) >= 0.5;
      const reverse = (dir ?? 0) >= 0.5;
      const k = `${tape}|${stereo}|${reverse}`;
      if (k !== key) {
        key = k;
        const net = reverse ? reverseNet(ctx, tape, stereo) : delayNet(ctx, tape, stereo);
        const g = ctx.createGain();
        inp.connect(net.input);
        net.output.connect(g).connect(wet);
        const old = cur;
        cur = { net, g };
        fx.oscs = net.oscs;
        if (old) {
          // as repetições antigas morrem aos poucos enquanto as novas entram
          const now = ctx.currentTime;
          inp.disconnect(old.net.input);
          g.gain.setValueAtTime(0, now);
          g.gain.linearRampToValueAtTime(1, now + 0.05);
          old.g.gain.setTargetAtTime(0, now + 0.05, 0.25);
          setTimeout(() => {
            old.g.disconnect();
            old.net.output.disconnect();
            for (const o of old.net.oscs) o.stop();
          }, 2500);
        }
      }
      // sincronizado: a figura no andamento da música (no máximo 2,4 s, o limite da linha de atraso)
      const seconds = (sync ?? 0) >= 0.5 ? Math.min(2.4, (delayDiv(time).beats * 60) / bpm) : freeDelay(time, reverse);
      cur!.net.set(seconds, rep, mod ?? 0, put);
    },
  };
  return fx;
}

// ---------- Pitch shifter ----------

const PITCH_WINDOW = 0.05; // s: janela de cada "grão" (latência ~25 ms; menor = mais metálico, maior = mais eco)
const rampCache = new WeakMap<BaseAudioContext, { saw: AudioBuffer; win: AudioBuffer }>();

/** Ciclo de dente de serra (0→1) e janela sin² (zero nas pontas), tocados em loop como moduladores. */
function pitchRamps(ctx: BaseAudioContext) {
  let r = rampCache.get(ctx);
  if (!r) {
    const n = 4096;
    const saw = ctx.createBuffer(1, n, ctx.sampleRate), win = ctx.createBuffer(1, n, ctx.sampleRate);
    const s = saw.getChannelData(0), w = win.getChannelData(0);
    for (let i = 0; i < n; i++) {
      s[i] = i / n;
      w[i] = Math.sin((Math.PI * i) / n) ** 2;
    }
    rampCache.set(ctx, (r = { saw, win }));
  }
  return r;
}

/**
 * Pitch shifter de linha de atraso (nós nativos: funciona ao vivo e na exportação). Duas vozes leem o
 * sinal com um atraso que cresce ou encolhe em rampa: atraso encolhendo = lê mais rápido = mais agudo.
 * Quando a rampa chega ao fim ela salta de volta; nesse instante a janela daquela voz está em zero e a
 * outra voz (meio ciclo defasada, janela no máximo) cobre o salto. sin² + cos² = 1: volume constante.
 */
/**
 * Pedal de pitch com o pitch shifter WSOLA do AudioWorklet 'mm-pitch' (emendas em fase, sem o tremido;
 * ver master.worklet.ts). Mesmos botões do pitch nativo abaixo, que fica para quando os worklets ainda
 * não carregaram e para o laço do shimmer do reverb.
 */
function pitchPedalHQ(ctx: BaseAudioContext, put: Put): Fx {
  const inp = ctx.createGain(), out = ctx.createGain(), dry = ctx.createGain(), wet = ctx.createGain();
  const node = new AudioWorkletNode(ctx, 'mm-pitch', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
  const tone = filter(ctx, 'lowpass', 9000); // arredonda o chiado que sobe junto na transposição para cima
  inp.connect(dry).connect(out);
  inp.connect(node).connect(tone).connect(wet).connect(out);
  return {
    in: inp,
    out,
    set: ([interval, fine, mix]) => {
      put(node.parameters.get('ratio')!, 2 ** ((pitchSemis(interval ?? 1) + ((fine ?? 0.5) - 0.5)) / 12));
      const m = mix ?? 0.5;
      put(dry.gain, Math.min(1, 2 * (1 - m)));
      put(wet.gain, Math.min(1, 2 * m));
    },
  };
}

function pitchPedal(ctx: BaseAudioContext, put: Put): Fx {
  const inp = ctx.createGain(), out = ctx.createGain(), dry = ctx.createGain(), wet = ctx.createGain();
  const tone = filter(ctx, 'lowpass', 7000); // o som transposto para cima fica áspero: arredonda
  inp.connect(dry).connect(out);
  tone.connect(wet).connect(out);
  const { saw, win } = pitchRamps(ctx);
  const base = ctx.createConstantSource();
  base.start(0);
  const loops: AudioBufferSourceNode[] = [];
  const depths: GainNode[] = [];
  const looped = (buf: AudioBuffer, offset: number) => {
    const s = ctx.createBufferSource();
    s.buffer = buf;
    s.loop = true;
    s.start(0, offset * buf.duration);
    loops.push(s);
    return s;
  };
  for (const phase of [0, 0.5]) {
    const d = ctx.createDelay(PITCH_WINDOW * 2 + 0.02);
    d.delayTime.value = 0;
    const depth = ctx.createGain();
    looped(saw, phase).connect(depth).connect(d.delayTime);
    base.connect(d.delayTime);
    depths.push(depth);
    const vca = ctx.createGain();
    vca.gain.value = 0;
    looped(win, phase).connect(vca.gain);
    inp.connect(d).connect(vca).connect(tone);
  }
  return {
    in: inp,
    out,
    oscs: [base, ...loops],
    set: ([interval, fine, mix]) => {
      const ratio = 2 ** ((pitchSemis(interval ?? 1) + ((fine ?? 0.5) - 0.5)) / 12);
      // velocidade da rampa: o atraso muda (1 - ratio) segundos por segundo
      const rate = (saw.duration * Math.abs(1 - ratio)) / PITCH_WINDOW;
      for (const s of loops) put(s.playbackRate, rate);
      // acima: atraso de W até 0 (encolhendo) · abaixo: de 0 até W (crescendo)
      const up = ratio > 1;
      put(base.offset, 0.002 + (up ? PITCH_WINDOW : 0));
      // sem transposição as rampas param: as duas vozes ficam no mesmo atraso (sem filtro de pente)
      const still = Math.abs(1 - ratio) < 1e-4;
      for (const g of depths) put(g.gain, still ? 0 : up ? -PITCH_WINDOW : PITCH_WINDOW);
      const m = mix ?? 0.5;
      put(dry.gain, Math.min(1, 2 * (1 - m)));
      put(wet.gain, Math.min(1, 2 * m));
    },
  };
}

// ---------- Wah ----------

/**
 * Wah: passa-banda ressonante que varre de ~350 Hz (pedal fechado, som "abafado") a ~2,4 kHz (aberto,
 * "quack"). No modo Auto um seguidor de envelope (retificador + passa-baixas, como no noise gate) soma
 * a força do sinal à frequência: a palhetada abre o filtro e ele fecha conforme a nota morre.
 */
/** Frequência do wah (Hz) para uma posição 0..1 do pedal; no modo Auto a posição é só o ponto de partida. */
const wahFreq = (pos: number, auto: boolean) => expMap(pos, 350, 2400) * (auto ? 0.6 : 1);

/** Posição do wah vinda da automação: número = posição fixa (parado no cursor); 'scheduled' = a automação agenda a curva. */
export type WahOverride = number | 'scheduled' | undefined;

interface WahFx extends Fx {
  /** parâmetro (Hz) que a automação agenda e a conversão posição → Hz no modo atual */
  freq: AudioParam;
  toHz(pos: number): number;
  override(v: WahOverride): void;
}

function wahPedal(ctx: BaseAudioContext, put: Put): WahFx {
  const inp = ctx.createGain(), out = ctx.createGain(), wet = ctx.createGain(), dry = ctx.createGain();
  const bp = filter(ctx, 'bandpass', 800, 4);
  bp.frequency.value = 0; // a frequência vem toda das fontes abaixo (base + envelope)
  const base = ctx.createConstantSource();
  base.start(0);
  base.connect(bp.frequency);
  const rect = ctx.createWaveShaper();
  rect.curve = gateCurve('rect');
  const env = filter(ctx, 'lowpass', 9); // abre em ~20 ms e fecha devagar como a nota
  const amount = ctx.createGain();
  inp.connect(rect).connect(env).connect(amount).connect(bp.frequency);
  inp.connect(bp).connect(wet).connect(out);
  inp.connect(dry).connect(out); // um pouco do sinal direto mantém o corpo da nota
  let last: number[] = [];
  let over: WahOverride;
  let autoMode = false;
  const fx: WahFx = {
    in: inp,
    out,
    oscs: [base],
    freq: base.offset,
    toHz: (pos) => wahFreq(pos, autoMode),
    override: (v) => {
      over = v;
      fx.set(last);
    },
    set: (p) => {
      last = p;
      const [pos, sens, res, mode] = p;
      const auto = (autoMode = (mode ?? 0) >= 0.5);
      // automação tocando: a curva agendada manda na frequência (um put aqui brigaria com ela)
      if (over !== 'scheduled') put(base.offset, wahFreq(typeof over === 'number' ? over : pos ?? 0.5, auto));
      put(amount.gain, auto ? (sens ?? 0.5) * 9000 : 0);
      const q = 2 + (res ?? 0.5) * 8;
      put(bp.Q, q);
      put(wet.gain, 0.9 + q * 0.18); // o passa-banda estreito tira volume: compensa
      put(dry.gain, 0.12);
    },
  };
  return fx;
}

// ---------- Harmonizer ----------

/** Harmonizador: a voz de harmonia sai do AudioWorklet 'mm-harmony'; o sinal direto passa por fora. */
function harmonyPedal(ctx: BaseAudioContext, put: Put): Fx {
  const inp = ctx.createGain(), out = ctx.createGain();
  inp.connect(out);
  const node = workletsReady(ctx)
    ? new AudioWorkletNode(ctx, 'mm-harmony', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] })
    : null;
  if (node) inp.connect(node).connect(out);
  let sent = '';
  return {
    in: inp,
    out,
    set: ([key, step, voice, minor]) => {
      if (!node) return;
      put(node.parameters.get('level')!, (voice ?? 0.6) * 1.5);
      const msg = { key: harmonyKey(key ?? 0), minor: (minor ?? 0) >= 0.5, offset: HARMONY_STEPS[harmonyStep(step ?? HARMONY_DEF)].deg };
      const k = JSON.stringify(msg);
      if (k !== sent) {
        sent = k;
        node.port.postMessage(msg);
      }
    },
  };
}

// ---------- Octaver ----------

/**
 * Octaver: as oitavas abaixo saem do AudioWorklet 'mm-octave' (flip-flops, ver master.worklet.ts) e o
 * sinal direto passa por fora. Se os worklets ainda não carregaram, só o direto passa; o mixer remonta o
 * rack quando eles ficam prontos (ver rigKey no mixer).
 */
function octavePedal(ctx: BaseAudioContext, put: Put): Fx {
  const inp = ctx.createGain(), out = ctx.createGain(), dry = ctx.createGain();
  inp.connect(dry).connect(out);
  const node = workletsReady(ctx)
    ? new AudioWorkletNode(ctx, 'mm-octave', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] })
    : null;
  if (node) inp.connect(node).connect(out);
  return {
    in: inp,
    out,
    set: ([direct, sub1, sub2]) => {
      put(dry.gain, (direct ?? 0.7) * 1.4);
      if (!node) return;
      put(node.parameters.get('sub1')!, (sub1 ?? 0.6) * 3);
      put(node.parameters.get('sub2')!, (sub2 ?? 0) * 3);
    },
  };
}

/**
 * Pedal com vários modelos: cada circuito é montado uma vez, mas só o escolhido recebe sinal (os outros
 * ficam parados, sem gastar processamento). Trocar de modelo faz um crossfade curto, sem estalo.
 */
function modelPedal(ctx: BaseAudioContext, put: Put, d: PedalDef): Fx {
  const inp = ctx.createGain(), out = ctx.createGain();
  const fxs = new Map(
    d.models!.map((m) => {
      const fx = makePedal(ctx, m.id, put);
      const g = ctx.createGain();
      g.gain.value = 0;
      fx.out.connect(g).connect(out);
      return [m.id, { fx, g }] as const;
    }),
  );
  let cur: { fx: Fx; g: GainNode } | null = null;
  let first = true;
  return {
    in: inp,
    out,
    oscs: [...fxs.values()].flatMap((x) => x.fx.oscs ?? []),
    model: (id) => {
      const next = fxs.get(modelOf(d, id)!.id)!;
      if (next === cur) return;
      const old = cur;
      cur = next;
      inp.connect(next.fx.in);
      if (first) {
        next.g.gain.value = 1;
        first = false;
        return;
      }
      const now = ctx.currentTime;
      next.g.gain.setTargetAtTime(1, now, 0.01);
      if (old) {
        old.g.gain.setTargetAtTime(0, now, 0.01);
        // desliga a entrada do antigo depois do crossfade (se ele não tiver voltado a ser o atual)
        setTimeout(() => {
          if (cur !== old) inp.disconnect(old.fx.in);
        }, 150);
      }
    },
    set: (p) => cur?.fx.set(p),
  };
}

function makePedal(ctx: BaseAudioContext, id: string, put: Put): Fx {
  const def = PEDALS.find((x) => x.id === id);
  if (def?.models) return modelPedal(ctx, put, def);
  switch (id) {
    case 'pitch': return workletsReady(ctx) ? pitchPedalHQ(ctx, put) : pitchPedal(ctx, put);
    case 'octave': return octavePedal(ctx, put);
    case 'harmony': return harmonyPedal(ctx, put);
    case 'reverb': return reverbPedal(ctx, put);
    case 'gate': return noiseGate(ctx, put);
    case 'comp': return compPedal(ctx, put);
    case 'wah': return wahPedal(ctx, put);
    case 'eq': {
      // uma banda de pico por fader (largura de ~1 oitava, como os EQs gráficos) e o volume no fim
      const bands = EQ_BANDS.map((f) => filter(ctx, 'peaking', f, 1.4));
      const level = ctx.createGain();
      bands.reduce<AudioNode>((a, b) => a.connect(b), bands[0]);
      bands[bands.length - 1].connect(level);
      return {
        in: bands[0],
        out: level,
        set: (p) => {
          bands.forEach((b, i) => put(b.gain, ((p[i] ?? 0.5) - 0.5) * 30));
          put(level.gain, 10 ** ((((p[EQ_BANDS.length] ?? 0.5) - 0.5) * 30) / 20));
        },
      };
    }
    case 'boostClean': {
      // ganho linear (até ~+18 dB) e prateleiras: nenhuma saturação
      const g = ctx.createGain();
      const ls = filter(ctx, 'lowshelf', 120);
      const hs = filter(ctx, 'highshelf', 2500);
      g.connect(ls).connect(hs);
      return {
        in: g,
        out: hs,
        set: ([gain, bright, bass]) => {
          put(g.gain, 1 + gain * 7);
          put(hs.gain, bright * 10);
          put(ls.gain, ((bass ?? 0.5) - 0.5) * 12);
        },
      };
    }
    case 'boostFet': {
      // corta o grave embolado antes, satura de leve no transistor, presença e tom depois
      const hp = highpass1(ctx, 70);
      const pre = ctx.createGain();
      const sh = shaper(ctx, 'fet');
      const dc = filter(ctx, 'highpass', 25);
      const presence = filter(ctx, 'peaking', 2800, 0.8, 3);
      const tone = filter(ctx, 'lowpass', 8000, 0.6);
      const out = ctx.createGain();
      hp.connect(pre).connect(sh).connect(dc).connect(presence).connect(tone).connect(out);
      return {
        in: hp,
        out,
        set: ([gain, t, level]) => {
          const g = 1 + (gain ?? 0.45) * 14;
          put(pre.gain, g);
          put(tone.frequency, expMap(t ?? 0.55, 2500, 14000));
          // a curva amplifica ~1,5x os sinais baixos: compensa, e com o Nível no meio o ganho total é o do botão
          put(out.gain, ((level ?? 0.5) * 2) / 1.49);
        },
      };
    }
    case 'odGreen':
      return feedbackDrive(ctx, put, { min: 12, range: 106, curve: 'soft', bassCut: 9, hump: [720, 4], toneA: 800, toneB: 5000, out: 0.37 });
    case 'odYellow':
      return feedbackDrive(ctx, put, { min: 10, range: 120, curve: 'asym', bassCut: 6, hump: [900, 2], toneA: 1500, toneB: 9000, out: 0.4 });
    case 'odGold':
      return transparentDrive(ctx, put);
    case 'dist': return drivePedal(ctx, put, 120, 250, 'hard', 1200, 9000, 0.25);
    case 'distBlack': return blackDist(ctx, put);
    case 'distBrit': return britDist(ctx, put);
    case 'distMetal': return metalDist(ctx, put);
    case 'fuzzMuff': return muffFuzz(ctx, put);
    case 'fuzzGerm': return germFuzz(ctx, put);
    case 'fuzz': return drivePedal(ctx, put, 60, 600, 'asym', 700, 6000, 0.25);
    case 'chorus': return chorusPedal(ctx, put);
    case 'rotary': return rotaryPedal(ctx, put);
    case 'univibe': return univibePedal(ctx, put);
    case 'phaser': {
      if (workletsReady(ctx)) return phaserPedal(ctx, put);
      // sem os worklets (logo ao abrir): phaser simples de nós nativos até o rack ser remontado
      const inp = ctx.createGain(), out = ctx.createGain(), wet = ctx.createGain();
      const l = lfo(ctx);
      let node: AudioNode = inp;
      for (let i = 0; i < 4; i++) {
        const ap = filter(ctx, 'allpass', 1000, 0.5);
        l.depth.connect(ap.frequency);
        node = node.connect(ap);
      }
      node.connect(wet).connect(out);
      inp.connect(out);
      return {
        in: inp, out, oscs: [l.o],
        set: ([rate, depth, amt]) => {
          put(l.o.frequency, 0.05 + rate * 3);
          put(l.depth.gain, 100 + depth * 800);
          put(wet.gain, amt);
          put(out.gain, 1 / (1 + amt * 0.5));
        },
      };
    }
    case 'flanger': {
      // eco de 3 a ~11 ms varrido por um LFO lento; a realimentação reforça os picos do filtro de pente.
      // (num laço o Web Audio não deixa o atraso abaixo de 128 amostras, ~2,7 ms: o piso fica logo acima)
      const inp = ctx.createGain(), out = ctx.createGain(), wet = ctx.createGain(), fb = ctx.createGain();
      const d = ctx.createDelay(0.02);
      const dc = filter(ctx, 'highpass', 30); // o laço de realimentação não acumula grave/DC
      const l = lfo(ctx);
      l.depth.connect(d.delayTime);
      inp.connect(out);
      inp.connect(d);
      d.connect(wet).connect(out);
      d.connect(dc).connect(fb).connect(d);
      return {
        in: inp, out, oscs: [l.o],
        set: ([rate, depth, regen]) => {
          const sweep = 0.0005 + depth * 0.0035; // meia excursão do atraso
          put(l.o.frequency, 0.05 + rate * 2);
          put(d.delayTime, 0.003 + sweep);
          put(l.depth.gain, sweep);
          put(fb.gain, regen * 0.85);
          put(wet.gain, 0.8);
          put(out.gain, 0.75 * (1 - regen * 0.3)); // segura o volume quando a realimentação sobe
        },
      };
    }
    case 'vibrato': {
      // atraso varrido por um LFO, 100% molhado: a afinação sobe e desce. A profundidade fixa o desvio
      // de afinação (até ~±1 semitom); o quanto o atraso varia depende da velocidade (desvio = 2π·f·A).
      const d = ctx.createDelay(0.06);
      const l = lfo(ctx);
      l.depth.connect(d.delayTime);
      return {
        in: d, out: d, oscs: [l.o],
        set: ([rate, depth]) => {
          const f = expMap(rate, 0.5, 10);
          const amp = ((depth * 0.06) / (2 * Math.PI * f)); // segundos
          put(l.o.frequency, f);
          put(l.depth.gain, amp);
          put(d.delayTime, 0.001 + amp);
        },
      };
    }
    case 'tremolo': return tremoloPedal(ctx, put);
    default: return delayPedal(ctx, put);
  }
}

/** Curvas das válvulas (pré e potência), amostradas uma vez. */
const tubeCurves = new Map<string, Float32Array<ArrayBuffer>>();
function tubeShaper(ctx: BaseAudioContext, kind: 'triode' | 'power') {
  let c = tubeCurves.get(kind);
  if (!c) {
    const n = 4096, fn = kind === 'triode' ? triode : powerTube;
    c = new Float32Array(n);
    for (let i = 0; i < n; i++) c[i] = fn((i / (n - 1)) * 2 - 1);
    tubeCurves.set(kind, c);
  }
  const s = ctx.createWaveShaper();
  s.curve = c;
  s.oversample = '4x';
  return s;
}

/**
 * Tone stack passivo como filtro IIR de 3ª ordem. O IIRFilterNode não aceita trocar os coeficientes,
 * então cada mudança de botão cria um filtro novo e faz um crossfade curto com o anterior.
 */
class ToneStack {
  input: GainNode;
  output: GainNode;
  private cur: { f: IIRFilterNode; g: GainNode } | null = null;
  private last = '';
  private makeup: number;
  constructor(private ctx: BaseAudioContext, private parts: ToneStackParts) {
    this.input = ctx.createGain();
    this.output = ctx.createGain();
    // com os botões no meio, 1 kHz passa com ganho 1 (o circuito passivo real perde uns 20 dB)
    const z = toneStackZ(parts, 0.5, 0.5, 0.5, ctx.sampleRate);
    this.makeup = 1 / magnitude(z.b, z.a, 1000, ctx.sampleRate);
    this.output.gain.value = this.makeup;
  }
  set(bass: number, mid: number, treble: number) {
    const key = `${bass}|${mid}|${treble}`;
    if (key === this.last) return;
    this.last = key;
    const z = toneStackZ(this.parts, bass, mid, treble, this.ctx.sampleRate);
    const f = this.ctx.createIIRFilter(z.b, z.a);
    const g = this.ctx.createGain();
    this.input.connect(f).connect(g).connect(this.output);
    const old = this.cur;
    this.cur = { f, g };
    if (!old) return;
    const now = this.ctx.currentTime;
    g.gain.setValueAtTime(0, now);
    g.gain.linearRampToValueAtTime(1, now + 0.03);
    old.g.gain.setValueAtTime(1, now);
    old.g.gain.linearRampToValueAtTime(0, now + 0.03);
    setTimeout(() => { old.f.disconnect(); old.g.disconnect(); }, 100);
  }
}

/** Um triodo de pré: ganho → curva da válvula → capacitor de acoplamento → corte de agudos (Miller). */
function triodeStage(ctx: BaseAudioContext, m: AmpModel, gain: number) {
  const g = ctx.createGain();
  g.gain.value = gain;
  const sh = tubeShaper(ctx, 'triode');
  const hp = highpass1(ctx, m.stageHp);
  const lp = filter(ctx, 'lowpass', m.stageLp);
  g.connect(sh).connect(hp).connect(lp);
  return { in: g, out: lp };
}

/**
 * Amplificador: entrada → 1º triodo → [tone stack, se for "early"] → pot de ganho (+ capacitor bright)
 * → demais triodos → [tone stack, se for "late"] → potência push-pull (master) → presença → saída.
 */
function makeAmp(ctx: BaseAudioContext, m: AmpModel, put: Put) {
  const inHp = highpass1(ctx, m.inHp);
  const v1 = triodeStage(ctx, m, m.v1);
  inHp.connect(v1.in);
  let node: AudioNode = v1.out;
  const stack = new ToneStack(ctx, m.stack);
  if (m.stackPos === 'early') {
    node.connect(stack.input);
    node = stack.output;
  }
  const pot = ctx.createGain();
  const bright = filter(ctx, 'highshelf', 2500);
  node = node.connect(pot).connect(bright);
  for (const g of m.stages) {
    const st = triodeStage(ctx, m, g);
    node.connect(st.in);
    node = st.out;
  }
  if (m.stackPos === 'late') {
    node.connect(stack.input);
    node = stack.output;
  }
  const drive = ctx.createGain();
  const power = tubeShaper(ctx, 'power');
  const presence = filter(ctx, 'highshelf', 3500);
  const out = ctx.createGain();
  node = node.connect(drive).connect(power).connect(presence);
  if (m.postLp) node = node.connect(filter(ctx, 'lowpass', m.postLp));
  node.connect(out);
  return {
    in: inHp,
    out,
    set: (k: AmpRig['knobs']) => {
      stack.set(k.bass, k.mid, k.treble);
      put(pot.gain, gainPot(k.gain));
      put(bright.gain, m.bright * (1 - k.gain));
      put(drive.gain, powerDrive(m, k.master));
      put(presence.gain, (k.presence - 0.5) * 12);
      put(out.gain, outGain(m, k.gain));
    },
  };
}

/** Pedal com chave liga/desliga (true bypass com crossfade curto para não estalar). */
class Slot {
  input: GainNode;
  output: GainNode;
  private dry: GainNode;
  private wet: GainNode;
  constructor(ctx: BaseAudioContext, public fx: Fx) {
    this.input = ctx.createGain();
    this.output = ctx.createGain();
    this.dry = ctx.createGain();
    this.wet = ctx.createGain();
    this.input.connect(this.dry).connect(this.output);
    this.input.connect(fx.in);
    fx.out.connect(this.wet).connect(this.output);
  }
  set(on: boolean, p: number[], put: Put) {
    put(this.dry.gain, on ? 0 : 1);
    put(this.wet.gain, on ? 1 : 0);
    this.fx.set(p);
  }
}

/** Identifica a estrutura do rack: se mudar, o rack é remontado; o resto só ajusta parâmetros. */
export const rigKey = (r: AmpRig, hasIr: boolean) => `${r.amp}|${r.cab}|${r.cab === 'user' ? `${r.irId}:${hasIr}` : ''}`;

export class Rig {
  input: GainNode;
  output: GainNode;
  private slots = new Map<string, Slot>();
  private amp: ReturnType<typeof makeAmp> | null = null;
  private cabDry: GainNode | null = null;
  private cabWet: GainNode | null = null;
  private first = true;
  /** pedal de wah (a posição dele pode ser automatizada) */
  wah: WahFx;
  /** pedal de rotary (a troca lento/rápido pode ser automatizada) */
  rotary: RotaryFx;
  private put: Put = (p, v) => {
    if (this.first) p.value = v;
    else p.setTargetAtTime(v, this.ctx.currentTime, 0.015);
  };

  constructor(private ctx: BaseAudioContext, public key: string, rig: AmpRig, userIr?: AudioBuffer, bpm = 120) {
    this.input = ctx.createGain();
    this.output = ctx.createGain();
    for (const p of PEDALS) this.slots.set(p.id, new Slot(ctx, makePedal(ctx, p.id, this.put)));
    this.wah = this.slots.get('wah')!.fx as WahFx;
    this.rotary = this.slots.get('rotary')!.fx as RotaryFx;

    let node: AudioNode = this.input;
    for (const p of PEDALS.filter((x) => !x.post)) {
      const s = this.slots.get(p.id)!;
      node.connect(s.input);
      node = s.output;
    }

    const model = AMPS.find((a) => a.id === rig.amp);
    if (model) {
      this.amp = makeAmp(ctx, model, this.put);
      node.connect(this.amp.in);
      node = this.amp.out;
    }

    const ir = rig.cab === 'user' ? userIr && fitRate(ctx, userIr) : cabIR(ctx, rig.cab);
    if (ir) {
      const conv = ctx.createConvolver();
      conv.buffer = ir;
      const sum = ctx.createGain();
      this.cabDry = ctx.createGain();
      this.cabWet = ctx.createGain();
      node.connect(this.cabDry).connect(sum);
      node.connect(conv).connect(this.cabWet).connect(sum);
      node = sum;
    }

    for (const p of PEDALS.filter((x) => x.post)) {
      const s = this.slots.get(p.id)!;
      node.connect(s.input);
      node = s.output;
    }
    node.connect(this.output);
    this.update(rig, bpm);
    this.first = false;
  }

  update(rig: AmpRig, bpm = 120) {
    for (const p of PEDALS) {
      const st = pedalOf(rig, p);
      const slot = this.slots.get(p.id)!;
      slot.fx.tempo?.(bpm);
      slot.fx.model?.(st.model);
      slot.set(st.on, st.p, this.put);
    }
    this.amp?.set(rig.knobs);
    if (this.cabDry && this.cabWet) {
      this.put(this.cabDry.gain, 1 - rig.cabMix);
      this.put(this.cabWet.gain, rig.cabMix);
    }
  }

  dispose() {
    this.input.disconnect();
    this.output.disconnect();
    for (const s of this.slots.values()) for (const o of s.fx.oscs ?? []) o.stop();
  }
}
