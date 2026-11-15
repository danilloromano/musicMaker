import { memo } from 'react';
import { PRESETS, SynthPreset } from '../audio/instruments';

// Forma de onda desenhada dentro de cada nota do Piano Roll, a partir do próprio instrumento da trilha.
// É uma representação visual: a frequência real (centenas de ciclos por nota) não caberia na tela, então
// a densidade da onda acompanha a altura da nota (mais aguda = ondas mais apertadas).

const TAU = Math.PI * 2;
const frac = (x: number) => x - Math.floor(x);

const WAVES: Record<string, (p: number) => number> = {
  sine: (p) => Math.sin(TAU * p),
  triangle: (p) => 4 * Math.abs(p - 0.5) - 1,
  sawtooth: (p) => 2 * p - 1,
  square: (p) => (p < 0.5 ? 1 : -1),
};

/** Uma amostra da forma do timbre (soma dos osciladores do preset) na fase `x` (em ciclos da fundamental). */
function timbre(preset: SynthPreset, x: number) {
  let sum = 0, total = 0;
  for (const o of preset.oscs) {
    const fn = WAVES[o.type] ?? WAVES.sine;
    sum += o.gain * fn(frac(x * 2 ** o.octave + o.detune / 1200));
    total += o.gain;
  }
  return total ? sum / total : 0;
}

/** Envelope ADSR do preset (sem o release, que acontece depois do fim da nota). */
function adsr(p: SynthPreset, t: number) {
  if (t < p.a) return p.a > 0 ? t / p.a : 1;
  const td = t - p.a;
  if (td < p.d) return 1 - (1 - p.s) * (td / p.d);
  return p.s;
}

/** Ruído determinístico (a mesma nota desenha sempre igual). */
const noise = (seed: number, i: number) => frac(Math.sin(seed * 12.9898 + i * 78.233) * 43758.5453) * 2 - 1;

/** Som de cada peça da bateria: [ruído (0..1), tom (0..1), decaimento (s), ciclos por segundo na tela]. */
function drumVoice(pitch: number): [number, number, number, number] {
  switch (pitch) {
    case 36: return [0.05, 1, 0.28, 40]; // bumbo: grave que cai de afinação
    case 38: return [0.7, 0.4, 0.14, 120]; // caixa: estalo + esteira
    case 39: return [1, 0, 0.09, 0]; // palmas
    case 42: return [1, 0, 0.04, 0]; // chimbal fechado
    case 46: return [1, 0, 0.3, 0]; // chimbal aberto
    case 49: return [1, 0, 0.9, 0]; // prato
    case 56: return [0.1, 1, 0.2, 260]; // cowbell
    default: return [0.15, 1, 0.3, pitch >= 48 ? 110 : 80]; // tons
  }
}

interface Props {
  width: number;
  height: number;
  pitch: number;
  velocity: number;
  /** segundos por pixel (depende do BPM e do zoom do Piano Roll) */
  secPerPx: number;
  instrument: string;
  drums: boolean;
  seed: number;
}

function buildPath({ width, height, pitch, velocity, secPerPx, instrument, drums, seed }: Props) {
  const mid = height / 2;
  const amp = (height / 2 - 1) * (0.35 + (0.65 * velocity) / 127);
  const steps = Math.max(2, Math.round(width * 2)); // 2 pontos por pixel
  const ys: number[] = [];
  const env: number[] = [];
  if (drums) {
    const [nz, tone, decay, cps] = drumVoice(pitch);
    let phase = 0;
    for (let i = 0; i <= steps; i++) {
      const t = ((i / steps) * width) * secPerPx;
      const e = Math.exp(-t / decay) * (pitch === 39 ? 0.6 + 0.4 * Math.cos(t * 160) ** 2 : 1);
      const f = pitch === 36 ? cps * (1 + 3 * Math.exp(-t / 0.03)) : cps; // bumbo: afinação cai no começo
      phase += f * (width / steps) * secPerPx * 6;
      ys.push(e * ((1 - nz) * tone * Math.sin(TAU * phase) + nz * noise(seed, i)));
      env.push(e);
    }
  } else {
    const preset = PRESETS[instrument] ?? Object.values(PRESETS)[0];
    const periodPx = Math.min(36, Math.max(4, 22 * 2 ** (-(pitch - 60) / 24))); // 2 oitavas acima = metade do período
    for (let i = 0; i <= steps; i++) {
      const xPx = (i / steps) * width;
      const e = adsr(preset, xPx * secPerPx);
      ys.push(e * timbre(preset, xPx / periodPx));
      env.push(e);
    }
  }
  let wave = '';
  let hull = `M0 ${mid}`;
  for (let i = 0; i <= steps; i++) {
    const x = ((i / steps) * width).toFixed(1);
    wave += `${i ? 'L' : 'M'}${x} ${(mid - amp * ys[i]).toFixed(1)}`;
    hull += `L${x} ${(mid - amp * env[i]).toFixed(1)}`;
  }
  for (let i = steps; i >= 0; i--) hull += `L${((i / steps) * width).toFixed(1)} ${(mid + amp * env[i]).toFixed(1)}`;
  return { wave, hull: hull + 'Z' };
}

/** Desenho da onda de uma nota (memorizado: só recalcula se tamanho, altura, força ou timbre mudarem). */
export const NoteWave = memo(function NoteWave(props: Props) {
  const { wave, hull } = buildPath(props);
  return (
    <svg className="note-wave" width={props.width} height={props.height} aria-hidden="true">
      <path d={hull} className="note-hull" />
      <path d={wave} className="note-line" />
    </svg>
  );
});
