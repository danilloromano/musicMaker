// Processo de áudio de baixa latência (processo filho do Electron rodando como Node).
// Não é um utilityProcess: nele o carregamento da DLL nativa do audify trava no Windows.
//
// O áudio do Chromium no Windows tem ~50 ms só de saída; para tocar guitarra ouvindo a si mesmo isso é
// demais. Aqui a placa é aberta direto pelo driver ASIO (CoreAudio no Mac) via RtAudio (pacote audify), com
// buffers de 64–128 amostras: ~8–10 ms de ida e volta na Fast Track. Roda num processo só para isso, longe da
// interface, para que nada da tela atrase um bloco de áudio.
//
// A entrada passa pelo rack da trilha (pedais de antes do amp, amp e caixa: src/audio/rt/rig.ts, o mesmo
// circuito do app). A gravação continua pelo caminho normal do app (getUserMedia), que funciona ao mesmo tempo
// que o ASIO, e grava o sinal seco.
import type { HostEvent, HostRequest, HostStatus, LowLatencyDevice, RtRig } from '../../src/audio/lowLatencyProtocol';
import { RtRigProcessor, warmupRig } from '../../src/audio/rt/rig';

import { RtAudio } from 'audify';
import { constants, setPriority } from 'node:os';

// valores dos enums do RtAudio (no .d.ts do audify eles são `const enum` e não existem em tempo de execução)
const MACOSX_CORE = 1;
const WINDOWS_ASIO = 6;
const FLOAT32 = 0x10;
const MINIMIZE_LATENCY = 0x2;
const SCHEDULE_REALTIME = 0x8;

const API = process.platform === 'darwin' ? MACOSX_CORE : WINDOWS_ASIO;
const API_NAME = process.platform === 'darwin' ? 'CoreAudio' : 'ASIO';

let rt: RtAudio | null = null;
let status: HostStatus = { running: false, deviceId: null, buffer: 0, rate: 0, latencyMs: 0, error: null };

// parâmetros da monitoração (o callback lê direto destas variáveis)
let channel = 0;
let targetGain = 0;
let gain = 0;

// rack da trilha: o último pedido fica guardado para remontar quando a placa reabre (outra taxa/buffer)
let rig: RtRig | null = null;
let ir: Extract<HostRequest, { type: 'ir' }> | null = null;
let proc: RtRigProcessor | null = null;
let work = new Float64Array(0);

// medição
let inChannels = 2;
let peak = 0;
let loadSum = 0;
let loadCount = 0;
let loadMax = 0;
let late = 0;
let lastCall = 0;
let budgetMs = 0;
let meterTimer: NodeJS.Timeout | null = null;

const send = (e: HostEvent) => process.send?.(e);

// prioridade alta: o JavaScript que processa cada bloco não pode esperar outros programas
try {
  setPriority(constants.priority.PRIORITY_HIGH);
} catch {
  /* sem permissão: segue na prioridade normal */
}
const sendStatus = () => send({ type: 'status', ...status });

function devices(): { devices: LowLatencyDevice[]; error?: string } {
  try {
    const r = new RtAudio(API);
    return {
      devices: r.getDevices().map((d) => ({
        id: d.id,
        name: d.name,
        inputs: d.inputChannels,
        outputs: d.outputChannels,
        rates: d.sampleRates,
        preferredRate: d.preferredSampleRate,
      })),
    };
  } catch (e) {
    return { devices: [], error: String((e as Error).message ?? e) };
  }
}

function stop() {
  if (meterTimer) clearInterval(meterTimer);
  meterTimer = null;
  if (rt) {
    try {
      if (rt.isStreamRunning()) rt.stop();
      if (rt.isStreamOpen()) rt.closeStream();
    } catch {
      /* driver já fechado */
    }
  }
  rt = null;
  proc = null;
  status = { ...status, running: false };
}

function start(req: Extract<HostRequest, { type: 'start' }>) {
  stop();
  const dev = devices().devices.find((d) => d.id === req.deviceId);
  if (!dev) {
    status = { ...status, error: 'Placa não encontrada. Ela está conectada?' };
    return sendStatus();
  }
  const rate = dev.rates.includes(req.rate) ? req.rate : dev.preferredRate;
  inChannels = Math.max(1, Math.min(2, dev.inputs));
  const outChannels = Math.max(1, Math.min(2, dev.outputs));
  const r = new RtAudio(API);
  let block = req.buffer;
  try {
    block = r.openStream(
      { deviceId: dev.id, nChannels: outChannels, firstChannel: 0 },
      { deviceId: dev.id, nChannels: inChannels, firstChannel: 0 },
      FLOAT32,
      rate,
      req.buffer,
      'Alien Studio',
      (pcm) => render(pcm, block, outChannels),
      null,
      MINIMIZE_LATENCY | SCHEDULE_REALTIME,
      (type, msg) => {
        if (type <= 1) return; // WARNING / DEBUG_WARNING: avisos do driver, não são falha
        status = { ...status, error: msg };
        sendStatus();
      },
    );
    // compila o rack antes de tocar (o primeiro bloco de cada circuito sairia lento)
    warmupRig(rate, block);
    // folga: blocos de silêncio na fila de saída absorvem um callback atrasado (custa 1 bloco cada)
    for (let k = 0; k < req.safety; k++) r.write(Buffer.alloc(block * outChannels * 4));
    r.start();
  } catch (e) {
    try {
      r.closeStream();
    } catch {
      /* nada aberto */
    }
    status = { ...status, running: false, error: `Não foi possível abrir ${dev.name}: ${(e as Error).message ?? e}` };
    return sendStatus();
  }
  rt = r;
  proc = new RtRigProcessor(rate, block);
  if (ir) proc.setIr(ir.key, ir.a, ir.b);
  proc.setRig(rig);
  work = new Float64Array(block);
  budgetMs = (block / rate) * 1000;
  late = 0;
  lastCall = 0;
  const latency = r.getStreamLatency() + req.safety * block;
  status = { running: true, deviceId: dev.id, buffer: block, rate, latencyMs: (latency / rate) * 1000, error: null };
  sendStatus();
  meterTimer = setInterval(() => {
    send({
      type: 'meter',
      peak: Math.min(1, peak),
      loadAvg: loadCount ? loadSum / loadCount : 0,
      loadMax,
      budget: budgetMs,
      late,
    });
    peak = loadSum = loadCount = loadMax = 0;
  }, 100);
}

/** Callback de áudio: um bloco entrelaçado de entrada vira o bloco de saída (no mesmo Buffer). */
function render(pcm: Buffer, block: number, outChannels: number) {
  const t0 = performance.now();
  if (lastCall && t0 - lastCall > 2 * budgetMs) late++;
  lastCall = t0;
  const inp = new Float32Array(pcm.buffer, pcm.byteOffset, pcm.byteLength >> 2);
  const out = outChannels === inChannels ? inp : new Float32Array(block * outChannels);
  const ch = inChannels < 2 ? 0 : channel;
  const n = Math.min(block, Math.floor(inp.length / inChannels));
  const w = work;
  for (let i = 0; i < n; i++) {
    const a = inp[i * inChannels];
    const b = inChannels > 1 ? inp[i * inChannels + 1] : a;
    const x = ch === 2 ? a + b : ch === 1 ? b : a;
    const ax = x < 0 ? -x : x;
    if (ax > peak) peak = ax;
    // ±1e-18 alternado: impede números subnormais (lentos) nos filtros quando a entrada fica em silêncio
    w[i] = x + (i & 1 ? 1e-18 : -1e-18);
  }
  // o rack trabalha em blocos do tamanho combinado com o driver (a convolução da caixa depende disso)
  if (proc && n === w.length) proc.process(w);
  for (let i = 0; i < n; i++) {
    // rampa curta no ganho: ligar/desligar a monitoração sem estalo
    gain += (targetGain - gain) * 0.005;
    const y = w[i] * gain;
    const o = y > 1 ? 1 : y < -1 ? -1 : y;
    for (let c = 0; c < outChannels; c++) out[i * outChannels + c] = o;
  }
  rt?.write(out === inp ? pcm : Buffer.from(out.buffer));
  const dt = performance.now() - t0;
  loadSum += dt;
  loadCount++;
  if (dt > loadMax) loadMax = dt;
}

function onMessage(m: HostRequest) {
  switch (m.type) {
    case 'list': {
      const r = devices();
      send({ type: 'devices', api: API_NAME, ...r });
      break;
    }
    case 'start':
      start(m);
      break;
    case 'stop':
      stop();
      sendStatus();
      break;
    case 'monitor':
      channel = m.channel;
      targetGain = m.gain;
      break;
    case 'rig':
      rig = m.rig;
      proc?.setRig(rig);
      break;
    case 'ir':
      ir = m;
      proc?.setIr(m.key, m.a, m.b);
      break;
  }
}

// Mensagens chegam do processo principal (que repassa as da interface). 'reset' = a janela recarregou:
// interface nova, a monitoração para até ela pedir de novo.
process.on('message', (m: HostRequest | { type: 'reset' }) => {
  if (m.type === 'reset') {
    stop();
    targetGain = gain = 0;
    rig = null;
    ir = null;
    sendStatus();
  } else onMessage(m);
});
// o processo principal fechou (app encerrado): fecha a placa antes de sair
process.on('disconnect', () => {
  stop();
  process.exit(0);
});
