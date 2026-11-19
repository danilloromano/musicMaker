// Mensagens entre a interface e o processo de áudio de baixa latência (electron/host/audioHost.ts).
// Só tipos: este arquivo é compilado nos dois lados.

export interface LowLatencyDevice {
  id: number;
  name: string;
  inputs: number;
  outputs: number;
  rates: number[];
  preferredRate: number;
}

/** Interface → processo de áudio */
export type HostRequest =
  | { type: 'list' }
  | {
      type: 'start';
      deviceId: number;
      /** tamanho do buffer pedido ao driver (amostras) */
      buffer: number;
      /** blocos de folga na saída: 0 = latência mínima, 1 = segura (absorve um atraso do processo) */
      safety: number;
      rate: number;
    }
  | { type: 'stop' }
  /** canal da placa (0, 1 ou 2 = soma dos dois) e ganho da monitoração (linear; 0 = mudo) */
  | { type: 'monitor'; channel: number; gain: number }
  /** rack de amp/pedais da trilha monitorada (null = sinal limpo) */
  | { type: 'rig'; rig: RtRig | null }
  /** IRs das caixas A e B na taxa da placa (mandados só quando mudam; `key` liga ao RtRig.cab.irKey) */
  | { type: 'ir'; key: string; a: Float32Array | null; b: Float32Array | null };

/** Um pedal de antes do amp, com o circuito já escolhido (`id` = id do modelo nos pedais com vários circuitos). */
export interface RtPedal {
  id: string;
  on: boolean;
  p: number[];
}

/** O rack como o processo de áudio precisa: só o que ele processa, já resolvido pela interface. */
export interface RtRig {
  /** pedais de antes do amp, na ordem do rack */
  pedals: RtPedal[];
  /** modelo do amp (null = sem amp) */
  amp: string | null;
  knobs: { gain: number; bass: number; mid: number; treble: number; presence: number; master: number };
  cab: {
    /** mistura com o sinal sem caixa (0..1) */
    mix: number;
    /** caixa A ↔ B (0..1) */
    blend: number;
    /** cortes depois da caixa em Hz (0 = desligado) */
    low: number;
    high: number;
    irKey: string;
  } | null;
}

export interface HostStatus {
  running: boolean;
  deviceId: number | null;
  buffer: number;
  rate: number;
  /** ida e volta informada pelo driver + folga (ms) */
  latencyMs: number;
  error: string | null;
}

/** Processo de áudio → interface */
export type HostEvent =
  | { type: 'devices'; api: string; devices: LowLatencyDevice[]; error?: string }
  | ({ type: 'status' } & HostStatus)
  | {
      type: 'meter';
      /** pico da entrada desde a última leitura (0..1) */
      peak: number;
      /** tempo de processamento por bloco (média e pior caso, ms) e o orçamento do bloco */
      loadAvg: number;
      loadMax: number;
      budget: number;
      /** blocos que chegaram com mais de um bloco de atraso desde o início (podem ter virado estalo) */
      late: number;
    };
