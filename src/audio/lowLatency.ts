// Monitoração de baixa latência: a interface fala com o processo de áudio (electron/host/audioHost.ts), que
// abre a placa pelo ASIO (Windows) ou CoreAudio (Mac) com buffers pequenos (~10 ms de ida e volta, contra
// ~70 ms pelo áudio do Chromium).
//
// Só a monitoração passa por lá: a gravação, o medidor e o afinador continuam pela entrada normal do app
// (getUserMedia), que funciona ao mesmo tempo. Com a monitoração de baixa latência rodando, o engine não
// manda mais a entrada para o canal da trilha (senão a guitarra tocaria duas vezes).
import { savePref, useStore } from '../store';
import { faderGain } from './mixer';
import type { HostEvent, HostRequest } from './lowLatencyProtocol';

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
      if (!status.running) openKey = lastMonitor = '';
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
  const m = `${s.inputChannel}:${gain.toFixed(4)}`;
  if (m !== lastMonitor) {
    lastMonitor = m;
    send({ type: 'monitor', channel: s.inputChannel, gain });
  }
}

/** A monitoração está saindo pelo motor de baixa latência (o engine então não monitora pelo Chromium). */
export const lowLatencyActive = () => {
  const s = useStore.getState();
  return s.monitorEngine === 'low' && s.llStatus.running;
};
