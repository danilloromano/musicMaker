// Retornos dos efeitos de envio: reverbs (sala, placa, salão, catedral) por convolução com respostas ao
// impulso sintetizadas e delays sincronizados com o andamento (com opção de pingue-pongue).
import type { SendFx } from '../types';
import { DIVISIONS, SPACES } from './routing';

function prng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const irCache = new Map<string, AudioBuffer>();

/**
 * Resposta ao impulso de um espaço: ruído com decaimento exponencial (RT60 do espaço) que vai ficando
 * mais escuro com o tempo (os agudos morrem antes), canais decorrelacionados (largura estéreo), atraso
 * inicial (pré-delay) e, na sala, algumas reflexões iniciais das paredes.
 */
function impulse(ctx: BaseAudioContext, r: NonNullable<SendFx['reverb']>): AudioBuffer {
  const key = `${ctx.sampleRate}:${r.space}:${r.predelay}:${r.tone.toFixed(2)}`;
  const hit = irCache.get(key);
  if (hit) return hit;
  const sr = ctx.sampleRate;
  const rt = SPACES.find((s) => s.id === r.space)?.seconds ?? 2;
  const pre = Math.round((r.predelay / 1000) * sr);
  const len = pre + Math.ceil(rt * 1.1 * sr);
  const buf = ctx.createBuffer(2, len, sr);
  // ataque: quanto o reverb leva para "encher" (placa é imediata, catedral demora)
  const build = { room: 0.004, plate: 0.002, hall: 0.02, cathedral: 0.06 }[r.space];
  const bright = 2500 + r.tone * 12000;
  for (let c = 0; c < 2; c++) {
    const d = buf.getChannelData(c);
    const rnd = prng(17 + c * 7919 + r.space.length);
    let lp = 0;
    for (let i = 0; i < len - pre; i++) {
      const t = i / sr;
      const env = Math.exp((-6.9 * t) / rt) * (1 - Math.exp(-t / build));
      // passa-baixa de um polo cujo corte cai com o tempo
      const fc = Math.max(300, bright * Math.exp(-t / (rt * 0.45)));
      const a = 1 - Math.exp((-2 * Math.PI * fc) / sr);
      lp += a * (rnd() * 2 - 1 - lp);
      d[pre + i] = lp * env;
    }
    if (r.space === 'room') {
      // reflexões iniciais (paredes, teto, chão)
      const taps = [7, 11, 13, 17, 23, 29, 31, 37];
      taps.forEach((ms, k) => {
        const at = pre + Math.round(((ms + (c ? 1.7 : 0)) / 1000) * sr);
        if (at < len) d[at] += (k % 2 ? -1 : 1) * 0.6 * 0.85 ** k;
      });
    }
  }
  irCache.set(key, buf);
  return buf;
}

/** Um retorno de efeito: entrada (soma dos envios das trilhas) → efeito → volume do retorno → master. */
export class SendReturn {
  readonly input: GainNode;
  /** saída do retorno (volume do retorno aplicado) */
  readonly out: GainNode;
  private nodes: AudioNode[] = [];
  private key = '';
  private delays: DelayNode[] = [];
  private fb: GainNode | null = null;
  private tone: BiquadFilterNode | null = null;

  constructor(private ctx: BaseAudioContext, dest: AudioNode, fx: SendFx, bpm: number) {
    this.input = ctx.createGain();
    this.out = ctx.createGain();
    this.out.connect(dest);
    this.update(fx, bpm);
  }

  update(fx: SendFx, bpm: number) {
    const ctx = this.ctx;
    // estrutura: só remonta quando muda o tipo, o espaço/pré-delay/tom do reverb ou o pingue-pongue
    const key = fx.type === 'reverb' ? `r:${fx.reverb!.space}:${fx.reverb!.predelay}:${fx.reverb!.tone.toFixed(2)}` : `d:${fx.delay!.pingpong}`;
    if (key !== this.key) {
      this.input.disconnect();
      this.nodes.forEach((n) => n.disconnect());
      this.nodes = [];
      this.delays = [];
      this.fb = null;
      this.tone = null;
      if (fx.type === 'reverb') {
        const conv = ctx.createConvolver();
        conv.buffer = impulse(ctx, fx.reverb!);
        this.input.connect(conv).connect(this.out);
        this.nodes.push(conv);
      } else {
        const tone = ctx.createBiquadFilter();
        tone.type = 'lowpass';
        const fb = ctx.createGain();
        if (fx.delay!.pingpong) {
          // pingue-pongue: o eco alterna entre esquerda e direita
          const mono = ctx.createGain();
          mono.channelCount = 1;
          mono.channelCountMode = 'explicit';
          mono.channelInterpretation = 'speakers';
          const l = ctx.createDelay(4);
          const r = ctx.createDelay(4);
          const merge = ctx.createChannelMerger(2);
          this.input.connect(mono).connect(l);
          l.connect(tone);
          tone.connect(merge, 0, 0);
          tone.connect(r);
          r.connect(merge, 0, 1);
          r.connect(fb).connect(l);
          merge.connect(this.out);
          this.delays = [l, r];
          this.nodes.push(mono, l, r, merge, tone, fb);
        } else {
          const d = ctx.createDelay(4);
          this.input.connect(d).connect(tone).connect(this.out);
          tone.connect(fb).connect(d);
          this.delays = [d];
          this.nodes.push(d, tone, fb);
        }
        this.fb = fb;
        this.tone = tone;
      }
      this.key = key;
    }
    const now = ctx.currentTime;
    this.out.gain.setTargetAtTime(fx.level, now, 0.02);
    if (fx.type === 'delay' && fx.delay) {
      const beats = DIVISIONS.find((d) => d.id === fx.delay!.division)?.beats ?? 0.75;
      const time = Math.min(3.9, (beats * 60) / bpm);
      for (const d of this.delays) d.delayTime.setTargetAtTime(time, now, 0.02);
      this.fb!.gain.setTargetAtTime(Math.min(0.92, fx.delay.feedback), now, 0.02);
      this.tone!.frequency.setTargetAtTime(1200 * 2 ** (fx.delay.tone * 4), now, 0.02);
    }
  }

  dispose() {
    this.input.disconnect();
    this.nodes.forEach((n) => n.disconnect());
    this.out.disconnect();
  }
}
