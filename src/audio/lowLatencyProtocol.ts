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
  /**
   * Pedaço de um IR. Os IRs vão em pedaços de 64 KB espaçados no tempo: o processo de áudio desserializa cada
   * mensagem de uma vez, e um IR de reverb inteiro (~3 MB) travaria o áudio por alguns milissegundos.
   */
  | { type: 'chunk'; id: string; offset: number; total: number; data: Float32Array }
  /** IRs das caixas A e B na taxa da placa (ids dos pedaços já enviados; `key` liga ao RtRig.cab.irKey) */
  | { type: 'ir'; key: string; a: string | null; b: string | null }
  /** IR estéreo do reverb (`key` = taxa|tipo|passo do tempo, a mesma que o pedal calcula) */
  | { type: 'reverb'; key: string; l: string; r: string };

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
  /** pedais de depois da caixa, na ordem do rack */
  post: RtPedal[];
  /** andamento (delay sincronizado) e tom da música (harmonizador) */
  bpm: number;
  song: { root: number; minor: boolean } | null;
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
