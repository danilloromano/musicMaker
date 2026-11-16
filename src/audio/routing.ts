// Roteamento e automação: efeitos de envio, grupos, sidechain e curvas de automação (só dados — os nós de
// áudio ficam em mixer.ts e sends.ts).
import type { AutoLane, Project, SendFx, Sidechain, Track } from '../types';

/** Envios padrão (os de todo projeto antigo): reverb de salão e eco de colcheia pontuada. */
export const DEFAULT_SENDS: SendFx[] = [
  { id: 'reverb', name: 'Reverb', type: 'reverb', level: 1, reverb: { space: 'hall', predelay: 20, tone: 0.5 } },
  { id: 'delay', name: 'Eco', type: 'delay', level: 1, delay: { division: '1/8d', feedback: 0.35, tone: 0.5, pingpong: false } },
];

export const sendsOf = (p: Project): SendFx[] => p.sends ?? DEFAULT_SENDS;

/** Quanto a trilha manda para o envio (os campos antigos fx.reverb/fx.delay valem para 'reverb'/'delay'). */
export function sendAmount(t: Track, id: string): number {
  const v = t.sends?.[id];
  if (v !== undefined) return v;
  if (id === 'reverb') return t.fx.reverb;
  if (id === 'delay') return t.fx.delay;
  return 0;
}

export const SPACES: { id: NonNullable<SendFx['reverb']>['space']; name: string; seconds: number }[] = [
  { id: 'room', name: 'Sala', seconds: 0.8 },
  { id: 'plate', name: 'Placa (plate)', seconds: 1.8 },
  { id: 'hall', name: 'Salão (hall)', seconds: 2.6 },
  { id: 'cathedral', name: 'Catedral', seconds: 5.5 },
];

export const DIVISIONS: { id: NonNullable<SendFx['delay']>['division']; name: string; beats: number }[] = [
  { id: '1/4', name: 'Semínima (1/4)', beats: 1 },
  { id: '1/8d', name: 'Colcheia pontuada', beats: 0.75 },
  { id: '1/8', name: 'Colcheia (1/8)', beats: 0.5 },
  { id: '1/4t', name: 'Tercina de semínima', beats: 2 / 3 },
  { id: '1/8t', name: 'Tercina de colcheia', beats: 1 / 3 },
  { id: '1/16', name: 'Semicolcheia (1/16)', beats: 0.25 },
];

export const newSend = (type: SendFx['type'], id: string, n: number): SendFx =>
  type === 'reverb'
    ? { id, name: `Reverb ${n}`, type, level: 1, reverb: { space: 'room', predelay: 10, tone: 0.5 } }
    : { id, name: `Eco ${n}`, type, level: 1, delay: { division: '1/4', feedback: 0.3, tone: 0.5, pingpong: true } };

// ---------- Grupos ----------

/** Grupo de saída válido da trilha (grupos não mandam para outros grupos). */
export function outputOf(t: Track, tracks: Track[]): Track | undefined {
  if (t.kind === 'bus' || !t.output) return undefined;
  return tracks.find((b) => b.id === t.output && b.kind === 'bus');
}

/**
 * Quem está audível com mudo/solo: com algum solo, tocam as trilhas em solo, os grupos por onde elas
 * passam e as trilhas que alimentam um grupo em solo.
 */
export function audibleSet(tracks: Track[]): Set<string> {
  const anySolo = tracks.some((t) => t.solo);
  const out = new Set<string>();
  for (const t of tracks) {
    if (t.mute) continue;
    const bus = outputOf(t, tracks);
    if (bus?.mute) continue;
    const soloed = t.solo || !!bus?.solo || (t.kind === 'bus' && tracks.some((c) => c.solo && outputOf(c, tracks)?.id === t.id));
    if (!anySolo || soloed) out.add(t.id);
  }
  return out;
}

// ---------- Sidechain ----------

export const DEFAULT_SIDECHAIN: Sidechain = { source: null, depth: 9, sens: 0.6, release: 180 };
export const sidechainOf = (t: Track): Sidechain => t.fx.sidechain ?? DEFAULT_SIDECHAIN;

// ---------- Automação ----------

export interface AutoParamInfo {
  id: string;
  name: string;
  min: number;
  max: number;
  /** valor sem automação */
  base: (t: Track) => number;
  format: (v: number) => string;
}

const pct = (v: number) => `${Math.round(v * 100)}%`;

/** Parâmetros automatizáveis de uma trilha (volume, pan e um por envio). */
export function autoParams(p: Project): AutoParamInfo[] {
  return [
    {
      id: 'volume', name: 'Volume', min: 0, max: 1, base: (t) => t.volume,
      format: (v) => {
        const db = 20 * Math.log10(Math.max(1e-4, v * v * 1.4));
        return v <= 0.001 ? '–∞ dB' : `${db > 0 ? '+' : ''}${db.toFixed(1).replace('.', ',')} dB`;
      },
    },
    {
      id: 'pan', name: 'Pan', min: -1, max: 1, base: (t) => t.pan,
      format: (v) => (Math.abs(v) < 0.02 ? 'Centro' : `${Math.round(Math.abs(v) * 100)}% ${v < 0 ? 'E' : 'D'}`),
    },
    ...sendsOf(p).map((s) => ({
      id: `send:${s.id}`, name: `Envio: ${s.name}`, min: 0, max: 1, base: (t: Track) => sendAmount(t, s.id), format: pct,
    })),
  ];
}

export const laneOf = (t: Track, param: string): AutoLane | undefined => t.automation?.find((l) => l.param === param);

/** Valor da curva num tempo (antes do 1º ponto vale o 1º, depois do último vale o último; entre eles, linear). */
export function valueAt(points: AutoLane['points'], beat: number): number {
  if (!points.length) return NaN;
  if (beat <= points[0].beat) return points[0].value;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i];
    if (beat <= b.beat) return b.beat === a.beat ? b.value : a.value + ((b.value - a.value) * (beat - a.beat)) / (b.beat - a.beat);
  }
  return points[points.length - 1].value;
}

/** Faixas de automação que de fato valem (com pelo menos um ponto). */
export const activeLanes = (t: Track) => (t.automation ?? []).filter((l) => l.points.length > 0);
