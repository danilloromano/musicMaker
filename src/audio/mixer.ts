import { Project, Track, activeFreeze } from '../types';
import { Rig, rigKey } from './amp';
import { MasterChain, ensureWorklets, workletsReady } from './master';
import { activeLanes, audibleSet, outputOf, sendAmount, sendsOf, sidechainOf, speedChanges, valueAt } from './routing';
import { SendReturn } from './sends';
import { applyComp, applyEq, compOf, createEqNodes, eqOf } from './trackfx';

/**
 * Canal da mesa: entrada → (amp/pedais) → EQ → compressor → compensação → sidechain (duck) → volume →
 * pan → saída (master ou grupo); depois do pan saem os envios para os efeitos e o analisador.
 */
export interface Strip {
  input: GainNode;
  /** EQ paramétrico em série (ver trackfx.ts: createEqNodes) */
  eq: BiquadFilterNode[];
  comp: DynamicsCompressorNode;
  makeup: GainNode;
  /** ganho controlado pelo sidechain (1 = sem efeito) */
  duck: GainNode;
  gain: GainNode;
  pan: StereoPannerNode;
  /** saída do canal: vai para o master ou para um grupo */
  out: GainNode;
  /** para onde \`out\` está ligado ('' = master) */
  dest: string;
  /** envio para cada efeito */
  sends: Map<string, GainNode>;
  analyser: AnalyserNode;
  rig?: Rig;
  side?: { key: string; nodes: AudioNode[]; meter: AnalyserNode; direct: boolean };
}

/** volume da trilha (0..1, escala de fader) → ganho linear */
export const faderGain = (v: number) => v * v * 1.4;

/** Curva do sidechain: envelope da origem (0..1) → ganho a somar ao "duck" (0 a -profundidade). */
const duckCurves = new Map<string, Float32Array<ArrayBuffer>>();
function duckCurve(depthDb: number, sens: number) {
  const key = `${depthDb}:${sens}`;
  let c = duckCurves.get(key);
  if (!c) {
    const floor = 10 ** (-depthDb / 20);
    const k = 1 / Math.max(0.05, 1 - sens); // sensível = abaixa tudo com pouco sinal
    c = new Float32Array(512);
    for (let i = 0; i < c.length; i++) {
      const x = Math.max(0, (i / (c.length - 1)) * 2 - 1);
      c[i] = -(1 - floor) * Math.min(1, x * k);
    }
    duckCurves.set(key, c);
  }
  return c;
}
const ABS = Float32Array.from({ length: 1025 }, (_, i) => Math.abs((i / 1024) * 2 - 1));

/** Mesa de som: canais das trilhas e dos grupos, retornos de efeito e o master. */
export class Mixer {
  /** entrada do master (todas as trilhas e efeitos somam aqui) */
  master: GainNode;
  /** cadeia de master (EQ, compressor, saturação, limitador, medidores) */
  chain: MasterChain;
  analyser: AnalyserNode;
  strips = new Map<string, Strip>();
  returns = new Map<string, SendReturn>();
  /** analisador de cada retorno de efeito (medidores da mesa) */
  returnAnalysers = new Map<string, AnalyserNode>();
  /** automação agendada (tocando): os parâmetros automatizados não recebem o valor fixo */
  private automating = false;
  /** posição do cursor (parado): o valor das curvas de automação aqui */
  cursor = 0;

  constructor(
    public ctx: BaseAudioContext,
    dest: AudioNode,
    private getBuffer: (id: string) => AudioBuffer | undefined = () => undefined,
    /** ao vivo (limitador e medidores no AudioWorklet) ou exportação (limitador aplicado depois) */
    live = true,
  ) {
    this.chain = new MasterChain(ctx, dest, live);
    this.master = this.chain.input;
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 2048;
    this.analyser.smoothingTimeConstant = 0.78;
    this.chain.output.connect(this.analyser);
    // quando o seguidor de envelope (AudioWorklet) carregar, os sidechains passam a usá-lo
    if (live && !workletsReady(ctx)) {
      void ensureWorklets(ctx)
        .then(() => this.lastProject && this.sync(this.lastProject))
        .catch(() => {});
    }
  }

  private lastProject: Project | null = null;

  /** Áudio congelado que vale para a trilha agora (ver types.ts: activeFreeze). */
  frozenOf(p: Project, t: Track): AudioBuffer | undefined {
    const id = activeFreeze(p, t, (x) => !!this.getBuffer(x));
    return id ? this.getBuffer(id) : undefined;
  }

  private createStrip(): Strip {
    const c = this.ctx;
    const input = c.createGain();
    const eq = createEqNodes(c);
    const comp = c.createDynamicsCompressor();
    const makeup = c.createGain();
    const duck = c.createGain();
    const gain = c.createGain();
    const pan = c.createStereoPanner();
    const out = c.createGain();
    const analyser = c.createAnalyser();
    analyser.fftSize = 2048; // resolução suficiente para o espectro nos graves
    analyser.smoothingTimeConstant = 0.78;
    input.connect(eq[0]);
    eq[eq.length - 1].connect(comp).connect(makeup).connect(duck).connect(gain).connect(pan).connect(out);
    out.connect(this.master);
    pan.connect(analyser);
    return { input, eq, comp, makeup, duck, gain, pan, out, dest: '', sends: new Map(), analyser };
  }

  /**
   * Rack de amp/pedais entre a entrada do canal e o EQ: remonta só quando muda amp, caixa ou IR. Trilha
   * congelada não tem rack (o som dele já está no áudio congelado, que entra direto no EQ).
   */
  private syncRig(s: Strip, t: Track, bpm: number, frozen: boolean) {
    const want = t.amp?.on && !frozen ? t.amp : null;
    const ir = want?.cab === 'user' && want.irId ? this.getBuffer(want.irId) : undefined;
    // o octaver usa AudioWorklet: quando os worklets carregam, o rack é remontado para ganhá-lo
    const key = want && `${rigKey(want, !!ir)}|${workletsReady(this.ctx) ? 'w' : ''}`;
    if (s.rig && s.rig.key !== key) {
      s.input.disconnect();
      s.rig.dispose();
      s.rig = undefined;
      s.input.connect(s.eq[0]);
    }
    if (want && key && !s.rig) {
      s.rig = new Rig(this.ctx, key, want, ir, bpm);
      s.input.disconnect();
      s.input.connect(s.rig.input);
      s.rig.output.connect(s.eq[0]);
    } else if (want) s.rig?.update(want, bpm);
  }

  /**
   * Sidechain: o sinal da trilha de origem (depois do compressor dela) vira um envelope (valor absoluto →
   * passa-baixa) e uma curva transforma esse envelope em quanto abaixar o "duck" desta trilha.
   */
  private syncSidechain(s: Strip, t: Track) {
    const sc = sidechainOf(t);
    const src = sc.source && sc.source !== t.id ? this.strips.get(sc.source) : undefined;
    const worklet = workletsReady(this.ctx);
    const key = src ? `${sc.source}:${sc.depth}:${sc.sens}:${sc.release}:${worklet}` : '';
    if (s.side?.key === key) return;
    s.side?.nodes.forEach((n) => n.disconnect());
    s.side = undefined;
    s.duck.gain.cancelScheduledValues(this.ctx.currentTime);
    s.duck.gain.value = 1;
    if (!src) return;
    const c = this.ctx;
    if (worklet) {
      // seguidor de envelope de verdade: ataque de 3 ms, volta ajustável; a saída é o próprio ganho
      const node = new AudioWorkletNode(c, 'mm-duck', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1],
        processorOptions: { depth: sc.depth, sens: sc.sens, release: sc.release },
      });
      const meter = c.createAnalyser();
      meter.fftSize = 256;
      s.duck.gain.value = 0;
      src.makeup.connect(node);
      node.connect(s.duck.gain);
      node.connect(meter);
      s.side = { key, nodes: [node, meter], meter, direct: true };
      return;
    }
    const tap = c.createGain();
    const abs = c.createWaveShaper();
    abs.curve = ABS;
    const lp = c.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 1 / (2 * Math.PI * (sc.release / 1000) * 0.5);
    lp.Q.value = 0.5;
    const shape = c.createWaveShaper();
    shape.curve = duckCurve(sc.depth, sc.sens);
    src.makeup.connect(tap).connect(abs).connect(lp).connect(shape).connect(s.duck.gain);
    // medidor: o mesmo sinal de redução, para mostrar quanto está abaixando
    const meter = c.createAnalyser();
    meter.fftSize = 256;
    shape.connect(meter);
    s.side = { key, nodes: [tap, abs, lp, shape, meter], meter, direct: false };
  }

  /** Cria/remove/atualiza retornos de efeito e canais para refletir o projeto. */
  sync(project: Project) {
    this.lastProject = project;
    const { tracks, bpm } = project;
    const now = this.ctx.currentTime;
    const smooth = (p: AudioParam, v: number) => p.setTargetAtTime(v, now, 0.012);

    // retornos de efeito
    const sends = sendsOf(project);
    for (const [id, r] of this.returns) {
      if (!sends.some((x) => x.id === id)) {
        r.dispose();
        this.returns.delete(id);
        this.returnAnalysers.delete(id);
        for (const s of this.strips.values()) {
          s.sends.get(id)?.disconnect();
          s.sends.delete(id);
        }
      }
    }
    for (const fx of sends) {
      const r = this.returns.get(fx.id);
      if (r) r.update(fx, bpm);
      else {
        const an = this.ctx.createAnalyser();
        an.fftSize = 2048;
        const ret = new SendReturn(this.ctx, this.master, fx, bpm);
        this.returns.set(fx.id, ret);
        // medidor: o retorno passa pelo analisador em paralelo
        ret.out.connect(an);
        this.returnAnalysers.set(fx.id, an);
      }
    }

    // canais
    for (const [id, s] of this.strips) {
      if (!tracks.some((t) => t.id === id)) {
        s.out.disconnect();
        s.pan.disconnect();
        s.input.disconnect();
        s.rig?.dispose();
        s.side?.nodes.forEach((n) => n.disconnect());
        this.strips.delete(id);
      }
    }
    for (const t of tracks) {
      if (!this.strips.has(t.id)) this.strips.set(t.id, this.createStrip());
    }
    const audible = audibleSet(tracks);
    for (const t of tracks) {
      const s = this.strips.get(t.id)!;
      // saída: grupo ou master
      const bus = outputOf(t, tracks);
      const dest = bus ? bus.id : '';
      if (s.dest !== dest) {
        s.out.disconnect();
        s.out.connect(bus ? this.strips.get(bus.id)!.input : this.master);
        s.dest = dest;
      }
      // envios
      for (const fx of sends) {
        let g = s.sends.get(fx.id);
        if (!g) {
          g = this.ctx.createGain();
          g.gain.value = 0;
          s.pan.connect(g).connect(this.returns.get(fx.id)!.input);
          s.sends.set(fx.id, g);
        }
      }
      const auto = this.automating ? new Set(activeLanes(t).map((l) => l.param)) : new Set<string>();
      const lane = (param: string) => (this.automating ? undefined : activeLanes(t).find((l) => l.param === param));
      const value = (param: string, base: number) => {
        const l = lane(param);
        return l ? valueAt(l.points, this.cursor) : base;
      };
      const on = audible.has(t.id);
      if (!auto.has('volume')) smooth(s.gain.gain, on ? faderGain(value('volume', t.volume)) : 0);
      else if (!on) smooth(s.gain.gain, 0);
      if (!auto.has('pan')) smooth(s.pan.pan, value('pan', t.pan));
      for (const fx of sends) {
        const p = `send:${fx.id}`;
        if (!auto.has(p)) smooth(s.sends.get(fx.id)!.gain, value(p, sendAmount(t, fx.id)));
      }
      applyEq(s.eq, eqOf(t.fx), true);
      applyComp(s.comp, s.makeup, compOf(t.fx), true);
      this.syncRig(s, t, bpm, !!this.frozenOf(project, t));
      // wah automatizado: tocando, a curva agendada manda; parado, vale o ponto da curva no cursor
      const wah = activeLanes(t).find((l) => l.param === 'wah');
      s.rig?.wah.override(wah ? (this.automating ? 'scheduled' : valueAt(wah.points, this.cursor)) : undefined);
      // rotary automatizado: idem (parado, a velocidade da curva no cursor)
      const rot = activeLanes(t).find((l) => l.param === 'rotary');
      s.rig?.rotary.override(rot ? (this.automating ? 'scheduled' : valueAt(rot.points, this.cursor)) : undefined);
    }
    for (const t of tracks) this.syncSidechain(this.strips.get(t.id)!, t);
  }

  /**
   * Agenda a automação de todas as trilhas a partir de \`fromBeat\`, que toca no instante \`at\`
   * (\`timeOf\` converte tempo da música em instante do áudio). Chamado ao dar play, a cada volta do
   * loop, quando a automação muda tocando e na exportação.
   */
  automate(project: Project, fromBeat: number, at: number, timeOf: (beat: number) => number) {
    this.automating = true;
    const audible = audibleSet(project.tracks);
    for (const t of project.tracks) {
      const s = this.strips.get(t.id);
      if (!s) continue;
      for (const l of activeLanes(t)) {
        if (l.param === 'wah') {
          const wah = s.rig?.wah;
          if (!wah) continue;
          wah.override('scheduled');
          // rampa exponencial em Hz = rampa linear na posição do pedal (a escala do pedal é exponencial)
          wah.freq.cancelScheduledValues(at);
          wah.freq.setValueAtTime(wah.toHz(valueAt(l.points, fromBeat)), at);
          for (const pt of l.points) if (pt.beat > fromBeat) wah.freq.exponentialRampToValueAtTime(wah.toHz(pt.value), timeOf(pt.beat));
          continue;
        }
        if (l.param === 'rotary') {
          const rot = s.rig?.rotary;
          if (!rot) continue;
          rot.override('scheduled');
          const { start, changes } = speedChanges(l.points, fromBeat);
          rot.schedule(start, at, changes.map((c) => ({ time: timeOf(c.beat), fast: c.fast })));
          continue;
        }
        const send = l.param.startsWith('send:') ? s.sends.get(l.param.slice(5)) : undefined;
        const p = l.param === 'volume' ? s.gain.gain : l.param === 'pan' ? s.pan.pan : send?.gain;
        if (!p) continue;
        if (l.param === 'volume' && !audible.has(t.id)) continue;
        const conv = (v: number) => (l.param === 'volume' ? faderGain(v) : v);
        p.cancelScheduledValues(at);
        p.setValueAtTime(conv(valueAt(l.points, fromBeat)), at);
        for (const pt of l.points) if (pt.beat > fromBeat) p.linearRampToValueAtTime(conv(pt.value), timeOf(pt.beat));
      }
    }
  }

  /** Ganho atual do sidechain de uma trilha (1 = não está abaixando). */
  private duckBuf = new Float32Array(256);
  duckLevel(trackId: string): number {
    const side = this.strips.get(trackId)?.side;
    if (!side) return 1;
    side.meter.getFloatTimeDomainData(this.duckBuf);
    let min = side.direct ? 1 : 0;
    for (const v of this.duckBuf) if (v < min) min = v;
    return side.direct ? min : 1 + min;
  }

  /** Para a automação (ao parar): os parâmetros voltam ao valor da curva no cursor. */
  stopAutomation(project: Project, cursor: number) {
    this.automating = false;
    this.cursor = cursor;
    const now = this.ctx.currentTime;
    for (const s of this.strips.values()) {
      s.gain.gain.cancelScheduledValues(now);
      s.pan.pan.cancelScheduledValues(now);
      for (const g of s.sends.values()) g.gain.cancelScheduledValues(now);
      s.rig?.wah.freq.cancelScheduledValues(now);
      s.rig?.rotary.hold(now); // os rotores param de mudar onde estão e o sync leva à velocidade do cursor
    }
    this.sync(project);
  }
}
