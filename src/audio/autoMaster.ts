// Master automático: a partir da análise da mix "crua" (sem nada no master) e de um alvo — a música de
// referência, se houver, ou o equilíbrio típico de músicas masterizadas — monta os ajustes do master e
// explica cada decisão.
import { Analysis, BANDS, TYPICAL_BANDS } from './analysis';
import { DEFAULT_MULTIBAND, DEFAULT_STEREO, masterOf } from './master';
import type { MasterSettings } from '../types';

export interface Suggestion {
  kind: 'fix' | 'ok' | 'warn';
  text: string;
}

const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
const half = (v: number) => Math.round(v * 2) / 2;
const db = (v: number) => `${v > 0 ? '+' : ''}${v.toFixed(1).replace('.', ',')} dB`;

export function suggestMaster(raw: Analysis, ref: Analysis | null, current?: MasterSettings): { settings: Required<MasterSettings>; notes: Suggestion[] } {
  const base = masterOf(current);
  const notes: Suggestion[] = [];
  const target = ref?.bands ?? TYPICAL_BANDS;
  const vs = ref ? 'a referência' : 'músicas masterizadas';

  // ---- equilíbrio tonal: corrige metade da diferença (o resto fica para o ouvido), no máximo ±4 dB
  const diff = target.map((t, i) => t - raw.bands[i]);
  const avg = (a: number, b: number) => (a + b) / 2;
  const eq = {
    low: half(clamp(avg(diff[0], diff[1]) * 0.5, -4, 4)),
    lowMid: half(clamp(diff[2] * 0.5, -4, 4)),
    highMid: half(clamp(diff[3] * 0.5, -4, 4)),
    high: half(clamp(avg(diff[4], diff[5]) * 0.5, -4, 4)),
  };
  const regions: [keyof typeof eq, string][] = [['low', 'graves'], ['lowMid', 'médio-graves'], ['highMid', 'médios/presença'], ['high', 'agudos']];
  const eqChanges = regions.filter(([k]) => Math.abs(eq[k]) >= 1);
  if (eqChanges.length) {
    notes.push({
      kind: 'fix',
      text: `Equilíbrio tonal comparado com ${vs}: ${eqChanges.map(([k, name]) => `${name} ${db(eq[k])}`).join(', ')} no EQ do master.`,
    });
  } else notes.push({ kind: 'ok', text: `Equilíbrio tonal parecido com ${vs}: EQ do master quase neutro.` });
  BANDS.forEach((b, i) => {
    if (Math.abs(diff[i]) >= 8) {
      notes.push({
        kind: 'warn',
        text: `${b.name} ${diff[i] > 0 ? 'bem abaixo' : 'bem acima'} (${db(-diff[i])}) do esperado: vale corrigir na mix (EQ das trilhas), não só no master.`,
      });
    }
  });

  // ---- dinâmica: quanto mais espaço entre pico e volume médio, mais compressão de cola
  let comp = { ...base.comp, on: false };
  if (raw.plr > 15) {
    comp = { on: true, threshold: clamp(Math.round(raw.lufs + 6), -36, -8), ratio: 2, attack: 30, release: 200, makeup: 2 };
    notes.push({ kind: 'fix', text: `Picos muito acima do volume médio (PLR ${raw.plr.toFixed(1).replace('.', ',')} dB): compressor de cola 2:1 para dar corpo e deixar o limitador trabalhar menos.` });
  } else if (raw.plr > 11) {
    comp = { on: true, threshold: clamp(Math.round(raw.lufs + 7), -36, -8), ratio: 1.5, attack: 30, release: 250, makeup: 1 };
    notes.push({ kind: 'fix', text: 'Dinâmica boa, com picos de sobra: compressão leve (1,5:1) só para colar a mix.' });
  } else {
    notes.push({ kind: raw.plr < 8 ? 'warn' : 'ok', text: raw.plr < 8 ? 'A mix já está bem comprimida (pouco espaço entre pico e volume): sem compressão no master para não achatar mais.' : 'Dinâmica já controlada: sem compressão extra no master.' });
  }
  if (raw.lra > 12) notes.push({ kind: 'warn', text: `O volume varia bastante ao longo da música (LRA ${raw.lra.toFixed(0)} LU): se não for intencional, nivele as partes com automação de volume.` });

  // ---- multibanda: segura graves "soltos" quando há grave demais
  let multiband = { ...base.multiband, on: false };
  if (diff[0] + diff[1] < -6) {
    multiband = {
      ...DEFAULT_MULTIBAND,
      on: true,
      bands: [
        { threshold: clamp(Math.round(raw.lufs + 2), -40, -10), ratio: 3, gain: 0 },
        { threshold: 0, ratio: 1, gain: 0 },
        { threshold: 0, ratio: 1, gain: 0 },
      ],
    };
    notes.push({ kind: 'fix', text: 'Graves fortes e irregulares: multibanda comprimindo só os graves (3:1), para o grave ficar firme sem embolar.' });
  }

  // ---- estéreo
  let stereo = { ...DEFAULT_STEREO };
  if (raw.correlation < 0.1) {
    stereo = { width: 0.85, monoBass: true, monoFreq: 120 };
    notes.push({ kind: 'warn', text: `Correlação de fase baixa (${raw.correlation.toFixed(2).replace('.', ',')}): partes da música podem sumir no celular/mono. Estreitei o estéreo e deixei os graves em mono; confira trilhas com pan/efeitos estéreo exagerados.` });
  } else if (raw.sideLow > -12) {
    stereo = { width: 1, monoBass: true, monoFreq: 120 };
    notes.push({ kind: 'fix', text: 'Há grave espalhado nos lados do estéreo: graves em mono abaixo de 120 Hz para um grave firme e centrado.' });
  } else if (raw.sideAll < -20) {
    stereo = { width: 1.2, monoBass: true, monoFreq: 120 };
    notes.push({ kind: 'fix', text: 'Mix quase mono: abri um pouco o estéreo (120%), mantendo os graves no centro.' });
  } else notes.push({ kind: 'ok', text: 'Imagem estéreo saudável.' });

  // ---- saturação: um pouco de calor quando faltam agudos e há dinâmica sobrando
  const saturation = raw.plr > 12 && avg(diff[4], diff[5]) > 2 ? 0.15 : 0;
  if (saturation) notes.push({ kind: 'fix', text: 'Saturação leve (15%) para dar brilho e presença sem aumentar os picos.' });

  // ---- volume final: alvo de loudness da exportação e ganho do limitador para ouvir parecido
  const goal = ref && Number.isFinite(ref.lufs) ? ref.lufs : -14;
  const exportTarget: MasterSettings['exportTarget'] = goal >= -11 ? 'loud' : goal <= -15.5 ? 'apple' : 'streaming';
  const targetLufs = exportTarget === 'loud' ? -9 : exportTarget === 'apple' ? -16 : -14;
  const makeups = (comp.on ? comp.makeup : 0) + eq.low * 0.3;
  const limiterGain = half(clamp(targetLufs - raw.lufs - makeups, 0, 12));
  notes.push({
    kind: 'fix',
    text: ref
      ? `A referência está em ${ref.lufs.toFixed(1).replace('.', ',')} LUFS: exportação com alvo de ${targetLufs} LUFS e limitador com teto de -1 dBTP.`
      : `Exportação com alvo de ${targetLufs} LUFS (Spotify/YouTube) e limitador com teto de -1 dBTP; limitador em ${db(limiterGain)} para você ouvir parecido com o resultado.`,
  });

  return {
    settings: {
      ...base,
      eq,
      comp,
      saturation,
      multiband,
      stereo,
      limiter: { on: true, gain: limiterGain, ceiling: -1, release: 120 },
      exportTarget,
    },
    notes,
  };
}
