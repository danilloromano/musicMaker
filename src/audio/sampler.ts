// Instrumentos melódicos tocados a partir de gravações: as reais (piano, baixo, cordas, órgão de tubos,
// guitarra, contrabaixo, sax, trompete, trombone, flauta, marimba —
// pacotes gerados por scripts/build-instruments.cjs, carregados sob demanda) e as calculadas por modelos
// físicos (pianos elétricos, clavinete, sino — ver modeled.ts). Cada nota tocada usa a gravação mais
// próxima, transposta, na intensidade que corresponde à força do toque.
import type { Voice } from './instruments';
import { MODELED_SETS, ModeledSet, renderModel } from './modeled';
import type { Zone } from './samples/piano.js';

type RecordedSet = 'piano' | 'bass' | 'strings' | 'pipe' | 'guitar' | 'dbass' | 'sax' | 'trumpet' | 'trombone' | 'flute' | 'marimba';
export type SampleSet = RecordedSet | ModeledSet;

/** Como um timbre usa o conjunto gravado. */
export interface SampleOpts {
  set: SampleSet;
  /** volume geral */
  gain: number;
  /** soltar a tecla: tempo (s) até o som sumir (o abafador encostando na corda) */
  release: number;
  /** notas a partir desta não têm abafador (como nas cordas agudas do piano) */
  undampedFrom?: number;
  /** passa-baixa (Hz, em C4; acompanha a altura) — deixa o timbre mais escuro */
  cutoff?: number;
  /** tocar mais forte abre o passa-baixa */
  velBright?: boolean;
  /** cópias desafinadas em cents (ex.: [-12, 12] = honky-tonk) */
  detune?: number[];
}

const LOADERS: Record<RecordedSet, () => Promise<{ manifest: Zone[]; data: string }>> = {
  piano: () => import('./samples/piano.js'),
  bass: () => import('./samples/bass.js'),
  strings: () => import('./samples/strings.js'),
  pipe: () => import('./samples/pipe.js'),
  guitar: () => import('./samples/guitar.js'),
  dbass: () => import('./samples/dbass.js'),
  sax: () => import('./samples/sax.js'),
  trumpet: () => import('./samples/trumpet.js'),
  trombone: () => import('./samples/trombone.js'),
  flute: () => import('./samples/flute.js'),
  marimba: () => import('./samples/marimba.js'),
};

/** Uma gravação decodificada: o áudio, a nota em que foi gravada e o trecho que repete (se sustenta). */
interface Take {
  buffer: AudioBuffer;
  key: number;
  loop?: [number, number];
}

interface LoadedZone {
  key: number;
  /** intensidades (da mais fraca à mais forte) → repetições */
  layers: Take[][];
}

const sets: Partial<Record<SampleSet, LoadedZone[]>> = {};
const loading: Partial<Record<SampleSet, Promise<void>>> = {};

const isModeled = (name: SampleSet): name is ModeledSet => (MODELED_SETS as string[]).includes(name);

/** Calcula as notas de um instrumento modelado e as guarda como gravações. */
async function loadModeled(ctx: BaseAudioContext, name: ModeledSet): Promise<LoadedZone[]> {
  const sr = ctx.sampleRate;
  const zones = await renderModel(name, sr);
  return zones.map((z) => ({
    key: z.key,
    layers: z.layers.map((d) => {
      const buffer = new AudioBuffer({ length: d.length, sampleRate: sr, numberOfChannels: 1 });
      buffer.getChannelData(0).set(d);
      return [{ buffer, key: z.key }];
    }),
  }));
}

/** Carrega (ou calcula) um conjunto uma única vez (um AudioBuffer serve para qualquer contexto). */
export function loadSampleSet(ctx: BaseAudioContext, name: SampleSet): Promise<void> {
  loading[name] ??= (async () => {
    if (isModeled(name)) {
      sets[name] = await loadModeled(ctx, name);
      return;
    }
    const { manifest, data } = await LOADERS[name]();
    const str = atob(data);
    const bin = new Uint8Array(str.length);
    for (let i = 0; i < str.length; i++) bin[i] = str.charCodeAt(i);
    const cache = new Map<number, Promise<AudioBuffer>>();
    const decode = (o: number, n: number) => {
      if (!cache.has(o)) cache.set(o, ctx.decodeAudioData(bin.slice(o, o + n).buffer));
      return cache.get(o)!;
    };
    sets[name] = await Promise.all(
      manifest.map(async (z) => ({
        key: z.key,
        layers: await Promise.all(
          z.layers.map((takes) =>
            Promise.all(
              takes.map(async ([o, n, key, ls, le]): Promise<Take> => ({
                buffer: await decode(o, n),
                key,
                loop: ls !== undefined && le !== undefined ? [ls, le] : undefined,
              })),
            ),
          ),
        ),
      })),
    );
  })().catch((e) => {
    console.warn(`Amostras de ${name} indisponíveis; usando o timbre sintetizado.`, e);
    delete loading[name];
  });
  return loading[name]!;
}

/** Carrega (uma vez) os conjuntos pedidos; os que já carregaram voltam na hora. */
export const loadSampleSets = (ctx: BaseAudioContext, names: SampleSet[]) => Promise.all([...new Set(names)].map((n) => loadSampleSet(ctx, n)));

const lastTake = new Map<string, number>();

/** Toca uma nota com o conjunto gravado; null se ele ainda não carregou (o chamador usa o sintetizado). */
export function startSampleVoice(
  ctx: BaseAudioContext,
  dest: AudioNode,
  o: SampleOpts,
  pitch: number,
  t: number,
  vel: number,
): Voice | null {
  const zones = sets[o.set];
  if (!zones?.length) return null;
  const zone = zones.reduce((a, b) => (Math.abs(b.key - pitch) < Math.abs(a.key - pitch) ? b : a));
  const v = Math.max(0, Math.min(1, vel / 127));
  const li = Math.min(zone.layers.length - 1, Math.floor(v * zone.layers.length));
  const takes = zone.layers[li];
  const lk = `${o.set}:${zone.key}:${li}`;
  let k = Math.floor(Math.random() * takes.length);
  if (takes.length > 1 && k === lastTake.get(lk)) k = (k + 1) % takes.length;
  lastTake.set(lk, k);
  const { buffer, key: recorded, loop } = takes[k];

  const vca = ctx.createGain();
  // as intensidades gravadas já mudam o timbre; o volume acompanha a força dentro de cada uma
  vca.gain.setValueAtTime(o.gain * (0.3 + 0.7 * v ** 1.2), t);
  let out: AudioNode = vca;
  if (o.cutoff) {
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.Q.value = 0.5;
    f.frequency.value = Math.min(18000, o.cutoff * 2 ** ((pitch - 60) / 24) * (o.velBright ? 0.5 + v : 1));
    vca.connect(f);
    out = f;
  }
  out.connect(dest);

  const rate = 2 ** ((pitch - recorded) / 12);
  const detunes = o.detune ?? [0];
  const srcs = detunes.map((cents) => {
    const s = ctx.createBufferSource();
    s.buffer = buffer;
    s.playbackRate.value = rate;
    s.detune.value = cents;
    if (loop) {
      // instrumentos que sustentam: repete o trecho estável enquanto a tecla estiver apertada
      s.loop = true;
      s.loopStart = loop[0];
      s.loopEnd = loop[1];
    }
    const g = ctx.createGain();
    g.gain.value = 1 / Math.sqrt(detunes.length);
    s.connect(g).connect(vca);
    s.start(t);
    return s;
  });

  const release = o.undampedFrom !== undefined && pitch >= o.undampedFrom ? Math.max(o.release, 1.5) : o.release;
  return {
    release(rt: number) {
      const at = Math.max(rt, t);
      if (vca.gain.cancelAndHoldAtTime) vca.gain.cancelAndHoldAtTime(at);
      else vca.gain.cancelScheduledValues(at);
      vca.gain.setTargetAtTime(0, at, Math.max(0.005, release / 4));
      for (const s of srcs) s.stop(at + release * 1.5 + 0.05);
    },
  };
}
