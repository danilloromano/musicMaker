// Ponte entre o rack do app (AmpRig, em types.ts) e o rack em tempo real (rt/rig.ts): converte as escolhas do
// usuário no formato que o processador recebe e gera os IRs (caixas e reverb) na taxa de quem vai tocar.
// Usado pelo AudioWorklet do rack (rigNode.ts) e pela monitoração de baixa latência (lowLatency.ts).
import type { AmpRig, MusicKey } from '../types';
import { CABS, PEDALS, cabIR, convolverScale, modelOf, pedalOf, prepIr, reverbIR } from './amp';
import { AMPS } from './ampCircuits';
import type { RtRig } from './lowLatencyProtocol';
import { REVERB_TYPES, reverbStep, reverbType } from './rt/pedalMath';

/** O rack no formato do processador (`getBuffer` acha os IRs carregados pelo usuário). */
export function toRtRig(
  a: AmpRig,
  rate: number,
  bpm: number,
  song: MusicKey | undefined,
  getBuffer: (id: string) => AudioBuffer | undefined,
): RtRig {
  const pedal = (d: (typeof PEDALS)[number]) => {
    const st = pedalOf(a, d);
    return { id: d.models ? modelOf(d, st.model)!.id : d.id, on: st.on, p: st.p };
  };
  const has = (cab: string | undefined, id: string | undefined) =>
    cab === 'user' ? !!id && !!getBuffer(id) : CABS.some((c) => c.id === cab);
  const hasA = has(a.cab, a.irId), hasB = has(a.cabB, a.irB);
  return {
    pedals: PEDALS.filter((d) => !d.post).map(pedal),
    post: PEDALS.filter((d) => d.post).map(pedal),
    bpm,
    song: song ?? null,
    amp: AMPS.some((m) => m.id === a.amp) ? a.amp : null,
    knobs: a.knobs,
    cab: hasA || hasB
      ? {
          mix: a.cabMix,
          blend: a.cabBlend ?? 0.5,
          low: a.cabLow ?? 0,
          high: a.cabHigh ?? 0,
          irKey: `${rate}|${hasA ? (a.cab === 'user' ? `u:${a.irId}` : a.cab) : '-'}|${hasB ? (a.cabB === 'user' ? `u:${a.irB}` : a.cabB) : '-'}`,
        }
      : null,
  };
}

/**
 * IR de uma caixa na taxa pedida, com o mesmo volume do ConvolverNode do rack de nós: as embutidas com a
 * normalização dele (aplicada aqui), as do usuário já igualadas por prepIr. Um canal por canal do IR (até 2).
 */
export function cabIrData(rate: number, cab: string | undefined, user: AudioBuffer | undefined): Float32Array[] | null {
  const ctx = new OfflineAudioContext(1, 1, rate);
  const b = cab === 'user' ? (user ? prepIr(ctx, user) : null) : cab ? cabIR(ctx, cab) : null;
  if (!b) return null;
  const g = cab === 'user' ? 1 : convolverScale(b);
  const chans = Math.min(2, b.numberOfChannels);
  return Array.from({ length: chans }, (_, c) => Float32Array.from(b.getChannelData(c), (v) => v * g));
}

/** IRs das caixas A e B do rack. */
export function cabIrs(a: AmpRig, rate: number, getBuffer: (id: string) => AudioBuffer | undefined) {
  return {
    a: cabIrData(rate, a.cab, a.irId ? getBuffer(a.irId) : undefined),
    b: cabIrData(rate, a.cabB, a.irB ? getBuffer(a.irB) : undefined),
  };
}

/** Chave da IR de reverb que o rack pede (taxa|tipo|passo do tempo, a mesma que o pedal calcula); null = desligado. */
export function reverbKeyOf(r: RtRig, rate: number): string | null {
  const rv = r.post.find((x) => x.id === 'reverb');
  if (!rv?.on) return null;
  return `${rate}|${REVERB_TYPES[reverbType(rv.p[3] ?? 0)].id}|${reverbStep(rv.p[0] ?? 0.4)}`;
}

/** IR estéreo do reverb para a chave (gerada como no rack de nós, com a normalização do ConvolverNode). */
export function reverbIrData(key: string) {
  const [rate, type, step] = key.split('|');
  const b = reverbIR(new OfflineAudioContext(2, 1, +rate), type as (typeof REVERB_TYPES)[number]['id'], +step);
  const g = convolverScale(b);
  const ch = (c: number) => Float32Array.from(b.getChannelData(Math.min(c, b.numberOfChannels - 1)), (v) => v * g);
  return { key, l: ch(0), r: ch(1) };
}
