// Monitoração de baixa latência: a interface fala com o processo de áudio (electron/host/audioHost.ts), que
// abre a placa pelo ASIO (Windows) ou CoreAudio (Mac) com buffers pequenos (~10 ms de ida e volta, contra
// ~70 ms pelo áudio do Chromium).
//
// O som monitorado passa pelo rack da trilha selecionada (pedais de antes do amp, amp e caixa), processado lá
// com o mesmo circuito do app (rt/rig.ts). Só a monitoração passa por lá: a gravação, o medidor e o afinador continuam pela entrada normal do app
// (getUserMedia), que funciona ao mesmo tempo. Com a monitoração de baixa latência rodando, o engine não
// manda mais a entrada para o canal da trilha (senão a guitarra tocaria duas vezes).
import { savePref, useStore } from '../store';
import type { Track } from '../types';
import { CABS, PEDALS, cabIR, convolverScale, modelOf, pedalOf, prepIr } from './amp';
import { AMPS } from './ampCircuits';
import { engine } from './engine';
import { faderGain } from './mixer';
import type { HostEvent, HostRequest, RtRig } from './lowLatencyProtocol';
import { RT_PEDALS } from './rt/rig';

interface Bridge {
  send(m: HostRequest): void;
  onMessage(cb: (m: HostEvent) => void): () => void;
}
const bridge = (globalThis as { audioHost?: Bridge }).audioHost;

const send = (m: HostRequest) => bridge?.send(m);

/** afinador no modo mudo: a monitoração fica em silêncio */
let muted = false;
/** o stream está aberto com estas configurações (para reabrir quando mudarem) */
let openKey = '';
/** último canal/ganho enviado (só manda de novo quando muda) */
let lastMonitor = '';
/** último rack e IRs enviados */
let lastRig = '';
let lastIr = '';

export function initLowLatency() {
  if (!bridge) return;
  useStore.getState().set({ llAvailable: true });
  bridge.onMessage((m) => {
    const set = useStore.getState().set;
    if (m.type === 'devices') {
      set({ llApi: m.api, llDevices: m.devices });
      // primeira vez: escolhe a única placa (ou a primeira) sozinho
      const s = useStore.getState();
      if (m.devices.length && !m.devices.some((d) => d.id === s.llDeviceId)) set({ llDeviceId: m.devices[0].id });
      sync();
    } else if (m.type === 'status') {
      const { type: _t, ...status } = m;
      // fechou (pedido, erro ou processo reiniciado): da próxima vez reabre e reenvia o ganho
      if (!status.running) openKey = lastMonitor = lastRig = lastIr = '';
      set({ llStatus: status, ...(status.running ? {} : { llMeter: null }) });
      sync();
    } else if (m.type === 'meter') {
      const { type: _t, ...meter } = m;
      set({ llMeter: meter });
    }
  });
  send({ type: 'list' });
  useStore.subscribe(sync);
}

export const refreshLowLatencyDevices = () => send({ type: 'list' });

export function setLowLatencyMuted(mute: boolean) {
  muted = mute;
  sync();
}

/** Escolhas do usuário (salvas como preferência do computador). */
export function setLowLatency(patch: { monitorEngine?: 'system' | 'low'; llDeviceId?: number; llBuffer?: number; llSafe?: boolean }) {
  useStore.getState().set(patch);
  if (patch.monitorEngine) savePref('mm.monitorEngine', patch.monitorEngine);
  if (patch.llDeviceId !== undefined) savePref('mm.llDevice', String(patch.llDeviceId));
  if (patch.llBuffer) savePref('mm.llBuffer', String(patch.llBuffer));
  if (patch.llSafe !== undefined) savePref('mm.llSafe', patch.llSafe ? '1' : '0');
}

/** Abre/fecha a placa e ajusta a monitoração conforme o estado do app. */
function sync() {
  const s = useStore.getState();
  // aberta enquanto a entrada do app está ligada e o motor de baixa latência está escolhido
  const want = s.llAvailable && s.monitorEngine === 'low' && s.inputOpen && s.llDeviceId !== null;
  const key = want ? `${s.llDeviceId}:${s.llBuffer}:${s.llSafe}` : '';
  if (key !== openKey) {
    if (key) {
      const dev = s.llDevices.find((d) => d.id === s.llDeviceId);
      if (!dev) return;
      openKey = key;
      send({ type: 'start', deviceId: dev.id, buffer: s.llBuffer, safety: s.llSafe ? 1 : 0, rate: dev.preferredRate });
    } else {
      openKey = '';
      if (s.llStatus.running) send({ type: 'stop' });
    }
  }
  // ganho: o mesmo que a monitoração normal respeitaria (trilha de áudio selecionada, volume e mudo dela)
  const t = s.project.tracks.find((x) => x.id === s.selectedTrackId);
  const on = want && s.monitor && !muted && t?.kind === 'audio' && !t.mute;
  const gain = on ? faderGain(t.volume) : 0;
  if (s.llStatus.running) syncRig(t, s.llStatus.rate);
  const m = `${s.inputChannel}:${gain.toFixed(4)}`;
  if (m !== lastMonitor) {
    lastMonitor = m;
    send({ type: 'monitor', channel: s.inputChannel, gain });
  }
}

/** O rack da trilha como o processo de áudio recebe (null = sem rack: sinal limpo). */
function rtRig(t: Track | undefined, rate: number): RtRig | null {
  const a = t?.kind === 'audio' && t.amp?.on ? t.amp : null;
  if (!a) return null;
  const pedals = PEDALS.filter((d) => !d.post).map((d) => {
    const st = pedalOf(a, d);
    return { id: d.models ? modelOf(d, st.model)!.id : d.id, on: st.on, p: st.p };
  });
  const has = (cab: string | undefined, id: string | undefined) =>
    cab === 'user' ? !!id && engine.buffers.has(id) : CABS.some((c) => c.id === cab);
  const hasA = has(a.cab, a.irId), hasB = has(a.cabB, a.irB);
  return {
    pedals,
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
 * IR de uma caixa na taxa da placa, com o mesmo volume que tem no rack do app: as embutidas tocam com a
 * normalização do ConvolverNode (aplicada aqui), as do usuário já vêm igualadas por prepIr. IR estéreo vira mono.
 * Fica nos primeiros IR_MAX segundos (a convolução em blocos pequenos custa proporcional ao tamanho do IR): o
 * corpo da caixa está todo aí; o que passa disso é ambiência, e só a monitoração deixa de ouvir.
 */
const IR_MAX = 0.15;
function irData(rate: number, cab: string | undefined, id: string | undefined): Float32Array | null {
  const ctx = new OfflineAudioContext(1, 1, rate);
  const user = cab === 'user' && id ? engine.buffers.get(id) : undefined;
  const b = cab === 'user' ? (user ? prepIr(ctx, user) : null) : cab ? cabIR(ctx, cab) : null;
  if (!b) return null;
  const g = cab === 'user' ? 1 : convolverScale(b);
  const len = Math.min(b.length, Math.round(IR_MAX * rate));
  const out = new Float32Array(len);
  for (let c = 0; c < b.numberOfChannels; c++) {
    const d = b.getChannelData(c);
    for (let i = 0; i < len; i++) out[i] += (d[i] * g) / b.numberOfChannels;
  }
  if (len < b.length) {
    const fade = Math.round(0.02 * rate); // fim suave no corte
    for (let i = 0; i < fade; i++) out[len - 1 - i] *= i / fade;
  }
  return out;
}

/** Manda o rack (e os IRs, se mudaram) da trilha monitorada. */
function syncRig(t: Track | undefined, rate: number) {
  const r = rtRig(t, rate);
  if (r?.cab && r.cab.irKey !== lastIr && t?.amp) {
    lastIr = r.cab.irKey;
    const a = t.amp;
    send({ type: 'ir', key: lastIr, a: irData(rate, a.cab, a.irId), b: irData(rate, a.cabB, a.irB) });
  }
  const key = JSON.stringify(r);
  if (key !== lastRig) {
    lastRig = key;
    send({ type: 'rig', rig: r });
  }
}

/** Nomes dos efeitos ligados na trilha que a monitoração de baixa latência ainda não processa. */
export function lowLatencyMissing(t: Track | undefined): string[] {
  const a = t?.kind === 'audio' && t.amp?.on ? t.amp : null;
  if (!a) return [];
  return PEDALS.filter((d) => {
    const st = pedalOf(a, d);
    if (!st.on) return false;
    return d.post || !RT_PEDALS.has(d.models ? modelOf(d, st.model)!.id : d.id);
  }).map((d) => d.name);
}

/** A monitoração está saindo pelo motor de baixa latência (o engine então não monitora pelo Chromium). */
export const lowLatencyActive = () => {
  const s = useStore.getState();
  return s.monitorEngine === 'low' && s.llStatus.running;
};
