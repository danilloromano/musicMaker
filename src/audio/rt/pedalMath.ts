// Conversão dos botões dos pedais (0..1) para valores do circuito, sem dependência do navegador: usada pelo
// rack do app (amp.ts) e pelo motor de baixa latência (rt/rig.ts).

export const expMap = (v: number, a: number, b: number) => a * (b / a) ** v;

/** Tons do harmonizador e intervalos (em graus da escala: 2 = terça, 4 = quinta, 7 = oitava). */
export const KEY_NAMES = ['Dó', 'Dó#', 'Ré', 'Ré#', 'Mi', 'Fá', 'Fá#', 'Sol', 'Sol#', 'Lá', 'Lá#', 'Si'];
export const HARMONY_STEPS = [
  { name: '-8ª', deg: -7 }, { name: '-6ª', deg: -5 }, { name: '-5ª', deg: -4 }, { name: '-4ª', deg: -3 }, { name: '-3ª', deg: -2 },
  { name: '+3ª', deg: 2 }, { name: '+4ª', deg: 3 }, { name: '+5ª', deg: 4 }, { name: '+6ª', deg: 5 }, { name: '+8ª', deg: 7 },
];
export const harmonyKey = (v: number) => Math.min(11, Math.round(v * 11));
export const harmonyStep = (v: number) => Math.min(HARMONY_STEPS.length - 1, Math.round(v * (HARMONY_STEPS.length - 1)));
export const HARMONY_DEF = 5 / (HARMONY_STEPS.length - 1); // terça acima

/** Botão de intervalo do pedal de pitch (0..1) → semitons inteiros de -12 a +12. */
export const pitchSemis = (v: number) => Math.round(v * 24 - 12);
/** Razão de transposição do pedal de pitch (intervalo + ajuste fino de ±50 cents). */
export const pitchRatio = (interval: number, fine: number) => 2 ** ((pitchSemis(interval) + (fine - 0.5)) / 12);

/** Tipos do pedal de reverb (ordem do botão Tipo) e a faixa de tempo (s) de cada um. */
export const REVERB_TYPES = [
  { id: 'spring', name: 'Mola', min: 0.8, max: 3.5 },
  { id: 'plate', name: 'Placa', min: 0.6, max: 5 },
  { id: 'shimmer', name: 'Shimmer', min: 2, max: 9 },
  { id: 'hall', name: 'Hall', min: 1.5, max: 8 },
  { id: 'room', name: 'Sala', min: 0.8, max: 5 },
] as const;
export type ReverbType = (typeof REVERB_TYPES)[number]['id'];
export const reverbType = (v: number) => Math.min(REVERB_TYPES.length - 1, Math.round(v * (REVERB_TYPES.length - 1)));
/** Tempo do reverb quantizado (0..15): cada passo é uma IR (não recalcula a cada movimento do botão). */
export const reverbStep = (v: number) => Math.round(v * 15);

/** Figuras do delay sincronizado (em tempos de semínima). */
export const DELAY_DIVS = [
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
export const delayDiv = (v: number) => DELAY_DIVS[Math.min(DELAY_DIVS.length - 1, Math.round(v * (DELAY_DIVS.length - 1)))];
/** Tempo livre do delay (s): normal 60 ms a 1 s; reverso, trechos de 0,15 a 1,5 s. */
export const freeDelay = (v: number, reverse: boolean) => (reverse ? 0.15 + v * 1.35 : 0.06 + v * 0.94);
/** Tempo do eco (s) a partir dos botões: livre, ou a figura no andamento (no máximo 2,4 s, o limite da linha). */
export const delaySeconds = (time: number, sync: boolean, reverse: boolean, bpm: number) =>
  sync ? Math.min(2.4, (delayDiv(time).beats * 60) / bpm) : freeDelay(time, reverse);

/** Bandas do equalizador gráfico (uma oitava entre elas, como nos pedais de EQ de 7 bandas). */
export const EQ_BANDS = [100, 200, 400, 800, 1600, 3200, 6400];

/** Frequência do wah (Hz) para uma posição 0..1 do pedal; no modo Auto a posição é só o ponto de partida. */
export const wahFreq = (pos: number, auto: boolean) => expMap(pos, 350, 2400) * (auto ? 0.6 : 1);

/** Curva que deforma a senoide do LFO do tremolo: passo 0 = senoide pura, passo 20 = quase quadrada. */
export function tremCurveFn(step: number) {
  const k = 0.3 + (step / 20) ** 2 * 30;
  return (x: number) => Math.tanh(k * x) / Math.tanh(k);
}

/** Velocidades (Hz) e inércia (constante de tempo, s) de cada rotor do rotary: a corneta é leve, o tambor pesado. */
export const ROTORS = {
  horn: { slow: 0.83, fast: 6.7, tau: 0.35, xover: 'highpass' as const, doppler: 0.00035, am: 0.45, mics: 0.25 },
  drum: { slow: 0.67, fast: 5.8, tau: 1.3, xover: 'lowpass' as const, doppler: 0.00012, am: 0.3, mics: 0.25 },
};

/** Harmônicos (senos) da onda do LFO do chorus/rotary: senoide ou quase-triangular. */
export const lfoHarmonics = (triangle: boolean) => (triangle ? [1, 0, -1 / 9, 0, 1 / 25, 0, -1 / 49] : [1]);

/** Nível de referência de uma palhetada (dBFS) usado na compensação automática do compressor. */
export const COMP_REF = -12;
/** Ajustes do compressor a partir dos botões (os mesmos no app e na monitoração). */
export function compSettings(sus: number, att: number, studio: boolean) {
  const threshold = studio ? -6 - sus * 34 : -10 - sus * 40;
  const ratio = studio ? 2 + sus * 4 : 6 + sus * 14;
  return {
    threshold,
    ratio,
    knee: studio ? 12 : 3,
    attack: expMap(att, 0.001, 0.04),
    release: studio ? 0.3 : 0.1,
    tone: studio ? 20000 : 6500,
  };
}
