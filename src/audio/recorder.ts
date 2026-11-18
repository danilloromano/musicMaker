// Grava em PCM bruto, via AudioWorklet, o sinal de um nó de áudio (a entrada já aberta pelo motor).

// cada bloco vai com o instante (no relógio do AudioContext) da sua primeira amostra
const WORKLET = `
class MMRecorder extends AudioWorkletProcessor {
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) this.port.postMessage({ t: currentTime, data: ch.slice(0) });
    return true;
  }
}
registerProcessor('mm-recorder', MMRecorder);
`;

const loaded = new WeakSet<AudioContext>();

export class Recorder {
  private chunks: Float32Array[] = [];
  private t0 = -1; // instante da primeira amostra gravada
  private node!: AudioWorkletNode;
  private sink!: GainNode;

  constructor(private ctx: AudioContext, private source: AudioNode) {}

  async start() {
    if (!loaded.has(this.ctx)) {
      const url = URL.createObjectURL(new Blob([WORKLET], { type: 'application/javascript' }));
      await this.ctx.audioWorklet.addModule(url);
      URL.revokeObjectURL(url);
      loaded.add(this.ctx);
    }
    this.node = new AudioWorkletNode(this.ctx, 'mm-recorder', { channelCount: 1, channelCountMode: 'explicit' });
    this.node.port.onmessage = (e) => {
      const { t, data } = e.data as { t: number; data: Float32Array };
      if (this.t0 < 0) this.t0 = t;
      this.chunks.push(data);
    };
    this.sink = this.ctx.createGain();
    this.sink.gain.value = 0; // mantém o nó ativo sem mandar som para a saída
    this.source.connect(this.node);
    this.node.connect(this.sink).connect(this.ctx.destination);
  }

  /**
   * Encerra e devolve o áudio gravado a partir do instante `from` (relógio do AudioContext) e, se dado, até
   * `to` (punch-in: só o trecho marcado), ou null se curto demais.
   */
  stop(from = 0, to?: number): AudioBuffer | null {
    return this.stopRanges([[from, to]])[0];
  }

  /**
   * Encerra e devolve um áudio para cada trecho [de, até] (relógio do AudioContext; sem `até` = até o fim).
   * Gravação em loop: uma única gravação contínua, cortada em uma passada por volta do loop.
   */
  stopRanges(ranges: [number, number | undefined][]): (AudioBuffer | null)[] {
    this.source.disconnect(this.node);
    this.node.disconnect();
    this.sink.disconnect();
    this.node.port.onmessage = null;

    const sr = this.ctx.sampleRate;
    const total = this.chunks.reduce((n, c) => n + c.length, 0);
    if (this.t0 < 0) return ranges.map(() => null);
    const all = new Float32Array(total);
    let o = 0;
    for (const c of this.chunks) {
      all.set(c, o);
      o += c.length;
    }
    // descarta o que veio antes do início (contagem) e compensa a latência de saída:
    // o que o músico ouviu estava atrasado em relação ao relógio
    const latency = this.ctx.baseLatency + (this.ctx.outputLatency || 0);
    return ranges.map(([from, to]) => {
      const skip = Math.min(total, Math.max(0, Math.round((from - this.t0 + latency) * sr)));
      const len = to === undefined ? total - skip : Math.min(total - skip, Math.round((to - from) * sr));
      if (len < sr * 0.05) return null;
      const buf = new AudioBuffer({ length: len, numberOfChannels: 1, sampleRate: sr });
      buf.getChannelData(0).set(all.subarray(skip, skip + len));
      return buf;
    });
  }
}
