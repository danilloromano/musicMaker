// Gravação do microfone/entrada de linha em PCM bruto via AudioWorklet.

const WORKLET = `
class MMRecorder extends AudioWorkletProcessor {
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) this.port.postMessage(ch.slice(0));
    return true;
  }
}
registerProcessor('mm-recorder', MMRecorder);
`;

const loaded = new WeakSet<AudioContext>();

export class Recorder {
  private chunks: Float32Array[] = [];
  private stream!: MediaStream;
  private src!: MediaStreamAudioSourceNode;
  private node!: AudioWorkletNode;
  private sink!: GainNode;

  constructor(private ctx: AudioContext) {}

  async start() {
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
    if (!loaded.has(this.ctx)) {
      const url = URL.createObjectURL(new Blob([WORKLET], { type: 'application/javascript' }));
      await this.ctx.audioWorklet.addModule(url);
      URL.revokeObjectURL(url);
      loaded.add(this.ctx);
    }
    this.src = this.ctx.createMediaStreamSource(this.stream);
    this.node = new AudioWorkletNode(this.ctx, 'mm-recorder');
    this.node.port.onmessage = (e) => this.chunks.push(e.data as Float32Array);
    this.sink = this.ctx.createGain();
    this.sink.gain.value = 0; // mantém o nó ativo sem monitorar (evita microfonia)
    this.src.connect(this.node).connect(this.sink).connect(this.ctx.destination);
  }

  stop(): AudioBuffer | null {
    this.src.disconnect();
    this.node.disconnect();
    this.sink.disconnect();
    this.node.port.onmessage = null;
    this.stream.getTracks().forEach((t) => t.stop());

    const total = this.chunks.reduce((n, c) => n + c.length, 0);
    // compensa a latência de saída: o que o músico ouviu estava atrasado em relação ao relógio
    const skip = Math.min(total, Math.round((this.ctx.baseLatency + (this.ctx.outputLatency || 0)) * this.ctx.sampleRate));
    const len = total - skip;
    if (len < this.ctx.sampleRate * 0.05) return null;
    const all = new Float32Array(total);
    let o = 0;
    for (const c of this.chunks) {
      all.set(c, o);
      o += c.length;
    }
    const buf = new AudioBuffer({ length: len, numberOfChannels: 1, sampleRate: this.ctx.sampleRate });
    buf.getChannelData(0).set(all.subarray(skip));
    return buf;
  }
}
