// EQ paramétrico e compressor de cada trilha: valores padrão, conversão dos projetos antigos (graves/
// médios/agudos fixos e compressor liga/desliga), presets e aplicação nos nós de áudio.
import type { EqBand, TrackComp, TrackEq, TrackFx } from '../types';

/** Tipo de cada banda do EQ (fixo): prateleira de graves, dois médios, prateleira de agudos. */
export const BAND_TYPES: BiquadFilterType[] = ['lowshelf', 'peaking', 'peaking', 'highshelf'];
export const BAND_NAMES = ['Graves', 'Médio 1', 'Médio 2', 'Agudos'];
export const BAND_COLORS = ['#ff7a45', '#ffcf3f', '#38d9c0', '#b98cff'];

export const EQ_GAIN_MAX = 18;
/** faixa do gráfico do EQ (a mesma do analisador de espectro) */
export const EQ_F_MIN = 30;
export const EQ_F_MAX = 18000;

const band = (freq: number, q = 1, gain = 0): EqBand => ({ on: true, freq, gain, q });

export function defaultEq(): TrackEq {
  return {
    hp: { on: false, freq: 80, slope: 12 },
    lp: { on: false, freq: 16000 },
    bands: [band(120, 0.7), band(500, 1), band(2500, 1), band(8000, 0.7)],
  };
}

export const DEFAULT_COMP: TrackComp = { on: false, threshold: -20, ratio: 3, attack: 10, release: 150, knee: 6, makeup: 0 };

/** EQ da trilha; projetos antigos (só graves/médios/agudos) viram prateleira 200 Hz, médio 1 kHz e prateleira 5 kHz. */
export function eqOf(fx: TrackFx): TrackEq {
  if (fx.eq) return fx.eq;
  const eq = defaultEq();
  eq.bands = [band(200, 0.7, fx.low), band(1000, 0.8, fx.mid), band(2500, 1), band(5000, 0.7, fx.high)];
  return eq;
}

/** Compressor da trilha; nos projetos antigos o "ligado" era -24 dB, 4:1, ataque 3 ms, recuperação 250 ms. */
export function compOf(fx: TrackFx): TrackComp {
  if (fx.compressor) return fx.compressor;
  return fx.comp ? { on: true, threshold: -24, ratio: 4, attack: 3, release: 250, knee: 30, makeup: 0 } : DEFAULT_COMP;
}

export const COMP_PRESETS: { id: string; name: string; desc: string; c: Omit<TrackComp, 'on'> }[] = [
  { id: 'vocal', name: 'Voz', desc: 'Nivela a voz e a traz para a frente', c: { threshold: -20, ratio: 3, attack: 5, release: 120, knee: 6, makeup: 4 } },
  { id: 'drums', name: 'Bateria', desc: 'Ataque lento: deixa o golpe passar e encorpa o corpo', c: { threshold: -18, ratio: 4, attack: 15, release: 100, knee: 3, makeup: 4 } },
  { id: 'bass', name: 'Baixo', desc: 'Notas todas no mesmo volume, grave firme', c: { threshold: -22, ratio: 4, attack: 10, release: 150, knee: 6, makeup: 5 } },
  { id: 'guitar', name: 'Guitarra/violão', desc: 'Controla os picos sem tirar a dinâmica', c: { threshold: -20, ratio: 2.5, attack: 20, release: 200, knee: 10, makeup: 3 } },
  { id: 'gentle', name: 'Suave', desc: 'Compressão leve, quase transparente', c: { threshold: -16, ratio: 1.8, attack: 30, release: 250, knee: 12, makeup: 2 } },
  { id: 'heavy', name: 'Pesado', desc: 'Esmaga tudo: som denso e constante', c: { threshold: -32, ratio: 10, attack: 1, release: 80, knee: 0, makeup: 10 } },
];

/** Q de Butterworth nos passa-altas/baixas (o Web Audio mede o Q desses filtros em dB). */
const BUTTERWORTH_Q_DB = 20 * Math.log10(Math.SQRT1_2);
/** frequência que deixa um filtro desligado na prática (fora da faixa audível) */
const OFF_HP = 10;

/**
 * Nós do EQ de uma trilha, em série: passa-altas (2 estágios = 24 dB/oitava), 4 bandas, passa-baixas.
 * O mesmo conjunto serve para tocar (no mixer) e para desenhar a curva (getFrequencyResponse).
 */
export function createEqNodes(ctx: BaseAudioContext): BiquadFilterNode[] {
  const types: BiquadFilterType[] = ['highpass', 'highpass', ...BAND_TYPES, 'lowpass'];
  const nodes = types.map((type) => {
    const f = ctx.createBiquadFilter();
    f.type = type;
    return f;
  });
  for (let i = 0; i < nodes.length - 1; i++) nodes[i].connect(nodes[i + 1]);
  return nodes;
}

/** Aplica os ajustes; com `smooth`, as mudanças deslizam (sem estalos enquanto toca). */
export function applyEq(nodes: BiquadFilterNode[], eq: TrackEq, smooth = false) {
  const ctx = nodes[0].context;
  const nyq = ctx.sampleRate / 2;
  const now = ctx.currentTime;
  const set = (p: AudioParam, v: number) => (smooth ? p.setTargetAtTime(v, now, 0.015) : (p.value = v));
  const [hp1, hp2, b0, b1, b2, b3, lp] = nodes;
  set(hp1.frequency, eq.hp.on ? eq.hp.freq : OFF_HP);
  set(hp2.frequency, eq.hp.on && eq.hp.slope === 24 ? eq.hp.freq : OFF_HP);
  hp1.Q.value = hp2.Q.value = BUTTERWORTH_Q_DB;
  [b0, b1, b2, b3].forEach((n, i) => {
    const b = eq.bands[i];
    set(n.frequency, b.freq);
    set(n.gain, b.on ? b.gain : 0);
    n.Q.value = b.q;
  });
  set(lp.frequency, eq.lp.on ? Math.min(eq.lp.freq, nyq * 0.98) : nyq * 0.98);
  lp.Q.value = BUTTERWORTH_Q_DB;
}

/** Ganho de compensação do compressor (linear). */
export const makeupGain = (c: TrackComp) => (c.on ? 10 ** (c.makeup / 20) : 1);

export function applyComp(comp: DynamicsCompressorNode, makeup: GainNode, c: TrackComp, smooth = false) {
  comp.threshold.value = c.on ? c.threshold : 0;
  comp.ratio.value = c.on ? c.ratio : 1;
  comp.knee.value = c.knee;
  comp.attack.value = c.attack / 1000;
  comp.release.value = c.release / 1000;
  if (smooth) makeup.gain.setTargetAtTime(makeupGain(c), comp.context.currentTime, 0.015);
  else makeup.gain.value = makeupGain(c);
}

let curveCtx: OfflineAudioContext | null = null;
let curveNodes: BiquadFilterNode[] | null = null;

/** Resposta do EQ (dB) nas frequências dadas — calculada pelos próprios filtros do Web Audio. */
export function eqResponse(eq: TrackEq, freqs: Float32Array<ArrayBuffer>): Float32Array {
  curveCtx ??= new OfflineAudioContext(1, 1, 48000);
  curveNodes ??= createEqNodes(curveCtx);
  applyEq(curveNodes, eq);
  const total = new Float32Array(freqs.length).fill(1);
  const mag = new Float32Array(freqs.length);
  const phase = new Float32Array(freqs.length);
  for (const n of curveNodes) {
    n.getFrequencyResponse(freqs, mag, phase);
    for (let i = 0; i < freqs.length; i++) total[i] *= mag[i];
  }
  return total.map((m) => 20 * Math.log10(Math.max(1e-6, m)));
}
