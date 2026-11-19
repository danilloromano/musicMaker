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
  | { type: 'monitor'; channel: number; gain: number };

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
