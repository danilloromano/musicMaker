// Rack de guitarra amostra a amostra para o motor de baixa latência: pedais de antes do amp (mono), amplificador,
// caixa e pedais de depois da caixa (estéreo), com os mesmos circuitos do rack do app (amp.ts). Cada classe
// reproduz o grafo de nós do pedal de lá — mesma ordem, filtros, curvas e valores — para a monitoração ter o
// timbre da trilha.
//
// Não depende do navegador nem do amp.ts (que usa o Web Audio): roda no processo de áudio (electron/host).
import type { RtPedal, RtRig } from '../lowLatencyProtocol';
import { AMPS, AmpModel, gainPot, magnitude, outGain, powerDrive, toneStackZ } from '../ampCircuits';
import { Biquad, Highpass1, Iir3, LongConvolver, Param, Shaper, VarBiquad, applyGain, buildInSlices, buildNow } from './dsp';
import type { BuildScheduler } from './dsp';
import { Fx, RigEnv, SMOOTH, add, copy, scale, tubeTable } from './base';
import { RT_PEDALS, makeFx } from './pre';
import { Reverb, ReverbIr, Rotary, StereoFx, makePostFx } from './post';
import { Wah } from './pre';

export { RT_PEDALS };
/** Pedais de depois da caixa que a monitoração processa (todos os do app). */
export const RT_POST = new Set(['chorus', 'phaser', 'flanger', 'vibrato', 'rotary', 'tremolo', 'delay', 'reverb']);

/** Pedal com chave liga/desliga: mistura seco/processado com a mesma suavização (sem estalo). */
class Slot {
  private mix = new Param(0);
  private dry: Float64Array;
  constructor(readonly id: string, readonly fx: Fx, B: number) {
    this.dry = new Float64Array(B);
  }
  set(st: RtPedal, snap: boolean, env: RigEnv) {
    this.mix.set(st.on ? 1 : 0, snap);
    this.fx.env = env;
    this.fx.set(st.p, snap);
  }
  run(b: Float64Array, n: number, k: number) {
    this.mix.tick(k);
    const m0 = this.mix.prev, m1 = this.mix.value;
    if (m0 === 0 && m1 === 0) return; // desligado: true bypass, o circuito nem roda
    this.fx.tick(k);
    if (m0 === 1 && m1 === 1) return this.fx.run(b, n);
    copy(b, this.dry, n);
    this.fx.run(b, n);
    const d = (m1 - m0) / n;
    for (let i = 0; i < n; i++) {
      const m = m0 + d * (i + 1);
      b[i] = b[i] * m + this.dry[i] * (1 - m);
    }
  }
}

// ---------- Amplificador ----------

/** Tone stack (IIR de 3ª ordem); cada mudança de botão faz um crossfade de 30 ms do filtro antigo para o novo. */
class ToneStack {
  private cur = new Iir3();
  private old = new Iir3();
  private fade = 0;
  private fadeLen: number;
  private key = '';
  readonly makeup: number;
  constructor(private sr: number, private parts: AmpModel['stack']) {
    this.fadeLen = Math.round(0.03 * sr);
    const z = toneStackZ(parts, 0.5, 0.5, 0.5, sr);
    this.makeup = 1 / magnitude(z.b, z.a, 1000, sr);
  }
  set(bass: number, mid: number, treble: number, snap: boolean) {
    const key = `${bass}|${mid}|${treble}`;
    if (key === this.key) return;
    this.key = key;
    const z = toneStackZ(this.parts, bass, mid, treble, this.sr);
    if (snap) {
      this.cur.setCoefs(z.b, z.a);
      return;
    }
    const t = this.old;
    this.old = this.cur;
    this.cur = t;
    this.cur.setCoefs(z.b, z.a);
    this.cur.copyState(this.old);
    this.fade = this.fadeLen;
  }
  run(b: Float64Array, n: number) {
    const g = this.makeup;
    for (let i = 0; i < n; i++) {
      const x = b[i];
      let y = this.cur.tick(x);
      if (this.fade > 0) {
        const m = this.fade / this.fadeLen;
        y = y * (1 - m) + this.old.tick(x) * m;
        this.fade--;
      }
      b[i] = y * g;
    }
  }
}

/** Um triodo de pré: ganho → curva da válvula (4x) → capacitor de acoplamento → corte de agudos (Miller). */
class TriodeStage {
  private sh: Shaper;
  private hp: Highpass1;
  private lp: Biquad;
  constructor(sr: number, m: AmpModel, private gain: number) {
    this.sh = new Shaper(tubeTable('triode'), sr, true);
    this.hp = new Highpass1(sr, m.stageHp);
    this.lp = new Biquad(sr, 'lowpass', m.stageLp);
  }
  run(b: Float64Array, n: number) {
    scale(b, n, this.gain);
    this.sh.run(b, n);
    this.hp.run(b, n);
    this.lp.run(b, n);
  }
}

/** Amplificador (makeAmp em amp.ts): triodos, tone stack, potência push-pull, presença. */
class Amp extends Fx {
  private inHp: Highpass1;
  private v1: TriodeStage;
  private stack: ToneStack;
  private pot = this.p();
  private bright = this.vb('highshelf', 2500);
  private stages: TriodeStage[];
  private drive = this.p();
  private power = new Shaper(tubeTable('power'), this.sr, true);
  private presence = this.vb('highshelf', 3500);
  private postLp: Biquad | null;
  private out = this.p();
  constructor(sr: number, B: number, readonly model: AmpModel) {
    super(sr, B);
    this.inHp = new Highpass1(sr, model.inHp);
    this.v1 = new TriodeStage(sr, model, model.v1);
    this.stack = new ToneStack(sr, model.stack);
    this.stages = model.stages.map((g) => new TriodeStage(sr, model, g));
    this.postLp = model.postLp ? this.bq('lowpass', model.postLp) : null;
  }
  run(b: Float64Array, n: number) {
    const m = this.model;
    this.inHp.run(b, n);
    this.v1.run(b, n);
    if (m.stackPos === 'early') this.stack.run(b, n);
    applyGain(b, n, this.pot);
    this.bright.run(b, n);
    for (const s of this.stages) s.run(b, n);
    if (m.stackPos === 'late') this.stack.run(b, n);
    applyGain(b, n, this.drive);
    this.power.run(b, n);
    this.presence.run(b, n);
    this.postLp?.run(b, n);
    applyGain(b, n, this.out);
  }
  set(): void {}
  setKnobs(k: RtRig['knobs'], snap: boolean) {
    const m = this.model;
    this.stack.set(k.bass, k.mid, k.treble, snap);
    this.pot.set(gainPot(k.gain), snap);
    this.bright.db.set(m.bright * (1 - k.gain), snap);
    this.drive.set(powerDrive(m, k.master), snap);
    this.presence.db.set((k.presence - 0.5) * 12, snap);
    this.out.set(outGain(m, k.gain), snap);
  }
}

// ---------- Caixa ----------

/** IR de uma caixa: 1 canal (mono) ou 2 (estéreo: cada lado com o seu, como o ConvolverNode faz). */
export type CabIr = Float32Array[];

/**
 * Caixa A e B (convolução com os IRs) misturadas, cortes de grave/agudo e mistura com o sinal sem caixa.
 * Entra mono; sai estéreo quando algum IR é estéreo (como o ConvolverNode com IR de 2 canais).
 */
class Cab extends Fx {
  private a: LongConvolver[] | null = null;
  private b: LongConvolver[] | null = null;
  private gA = this.p(1);
  private gB = this.p(0);
  private wetG = this.p(1);
  private dryG = this.p(0);
  private hp = [this.vb('highpass', 10, 0.707), this.vb('highpass', 10, 0.707)];
  private lp: VarBiquad[];
  private dry = this.buf();
  private wb = this.buf();
  private building: { cancel(): void } | null = null;
  key = '';
  constructor(sr: number, B: number) {
    super(sr, B);
    this.lp = [this.vb('lowpass', (sr / 2) * 0.95, 0.707), this.vb('lowpass', (sr / 2) * 0.95, 0.707)];
  }
  /** Monta as convoluções aos poucos (IRs de até 1 s) e troca quando prontas. */
  setIr(key: string, a: CabIr | null, b: CabIr | null, onReady: () => void, schedule: BuildScheduler) {
    this.building?.cancel();
    const B = this.B;
    function* build(ir: CabIr | null) {
      if (!ir?.length) return null;
      const out: LongConvolver[] = [];
      for (const ch of ir.slice(0, 2)) out.push(yield* LongConvolver.build(ch, B));
      return out;
    }
    function* both() {
      const ca = yield* build(a);
      const cb = yield* build(b);
      return [ca, cb] as const;
    }
    const done = ([ca, cb]: readonly [LongConvolver[] | null, LongConvolver[] | null]) => {
      this.building = null;
      this.a = ca;
      this.b = cb;
      this.key = key;
      onReady();
    };
    this.building = schedule(both(), done);
  }
  get loaded() {
    return !!(this.a || this.b);
  }
  /** algum dos IRs é estéreo: a saída tem lados diferentes */
  get stereo() {
    return (this.a?.length ?? 0) > 1 || (this.b?.length ?? 0) > 1;
  }
  set(): void {}
  setCab(c: NonNullable<RtRig['cab']>, snap: boolean) {
    this.dryG.set(1 - c.mix, snap);
    this.wetG.set(c.mix, snap);
    // A/B: mistura de potência constante (o volume não afunda no meio)
    const bl = this.a && this.b ? Math.min(1, Math.max(0, c.blend)) : this.b ? 1 : 0;
    this.gA.set(Math.cos((bl * Math.PI) / 2), snap);
    this.gB.set(Math.sin((bl * Math.PI) / 2), snap);
    const nyq = this.sr / 2;
    for (const f of this.hp) f.f.set(c.low ? Math.min(nyq * 0.9, c.low) : 10, snap);
    for (const f of this.lp) f.f.set(c.high ? Math.min(nyq * 0.9, c.high) : nyq * 0.95, snap);
  }
  run(): void {}
  /** Entra mono em `L`; sai em `L` e `R` (iguais se os IRs forem mono). */
  runStereo(L: Float64Array, R: Float64Array, n: number) {
    if (!this.a && !this.b) return R.set(L);
    copy(L, this.dry, n);
    const chans = this.stereo ? 2 : 1;
    for (let c = 0; c < chans; c++) {
      const x = c === 0 ? L : R;
      x.fill(0);
      const w = this.wb;
      // IR mono numa caixa estéreo: o mesmo sinal nos dois lados
      if (this.a) {
        this.a[Math.min(c, this.a.length - 1)].run(this.dry, x, n);
        applyGain(x, n, this.gA);
      }
      if (this.b) {
        w.fill(0);
        this.b[Math.min(c, this.b.length - 1)].run(this.dry, w, n);
        applyGain(w, n, this.gB);
        add(x, w, n);
      }
      this.hp[c].run(x, n);
      this.lp[c].run(x, n);
    }
    // os parâmetros avançam uma vez por bloco: aplica nos dois lados com os mesmos valores
    applyGain(L, n, this.wetG);
    if (chans === 2) applyGain(R, n, this.wetG);
    applyGain(this.dry, n, this.dryG);
    add(L, this.dry, n);
    if (chans === 2) add(R, this.dry, n);
    else R.set(L);
  }
}

// ---------- Pedais estéreo ----------

/** Pedal de depois da caixa com chave liga/desliga (mistura seco/processado nos dois canais). */
class StereoSlot {
  private mix = new Param(0);
  private dl: Float64Array;
  private dr: Float64Array;
  constructor(readonly id: string, readonly fx: StereoFx, B: number) {
    this.dl = new Float64Array(B);
    this.dr = new Float64Array(B);
  }
  set(st: RtPedal, snap: boolean, env: RigEnv) {
    this.mix.set(st.on ? 1 : 0, snap);
    this.fx.env = env;
    this.fx.set(st.p, snap);
  }
  run(L: Float64Array, R: Float64Array, n: number, k: number) {
    this.mix.tick(k);
    const m0 = this.mix.prev, m1 = this.mix.value;
    if (m0 === 0 && m1 === 0) return;
    this.fx.tick(k);
    if (m0 === 1 && m1 === 1) return this.fx.run(L, R, n);
    copy(L, this.dl, n);
    copy(R, this.dr, n);
    this.fx.run(L, R, n);
    const d = (m1 - m0) / n;
    for (let i = 0; i < n; i++) {
      const m = m0 + d * (i + 1);
      L[i] = L[i] * m + this.dl[i] * (1 - m);
      R[i] = R[i] * m + this.dr[i] * (1 - m);
    }
  }
}

// ---------- Rack ----------

/** Reaproveita os slots que continuam com o mesmo circuito (mantém o estado dos filtros e dos ecos). */
function syncSlots<S extends { id: string; set(st: RtPedal, snap: boolean, env: RigEnv): void }>(
  old: S[],
  want: RtPedal[],
  make: (id: string) => S | null,
  snap: boolean,
  env: RigEnv,
): S[] {
  const byId = new Map(old.map((s) => [s.id, s]));
  const out: S[] = [];
  for (const st of want) {
    let s = byId.get(st.id);
    if (!s) {
      const made = make(st.id);
      if (!made) continue;
      s = made;
      s.set(st, true, env);
      // pedal novo que já chega ligado entra com o mix suave a partir de 0
      if (!snap && st.on) s.set({ ...st, on: false }, true, env);
    }
    s.set(st, snap, env);
    out.push(s);
  }
  return out;
}

/**
 * O rack inteiro: pedais de antes do amp (mono, na ordem do app) → amp → caixa → pedais de depois da caixa
 * (estéreo). Os IRs (caixas e reverb) chegam prontos da interface e são montados aos poucos.
 */
export class RtRigProcessor {
  private slots: Slot[] = [];
  private post: StereoSlot[] = [];
  private amp: Amp | null = null;
  private cab: Cab;
  private rig: RtRig | null = null;
  private reverbIr: ReverbIr | null = null;
  private k: number;
  private first = true;
  /** `schedule`: como montar os IRs aos poucos (host: fatias com setTimeout; worklet: fila drenada a cada bloco) */
  constructor(private sr: number, private B: number, private schedule: BuildScheduler = buildInSlices) {
    this.k = 1 - Math.exp(-B / (SMOOTH * sr));
    this.cab = new Cab(sr, B);
  }

  /** Configuração nova do rack (null = sem rack: sinal limpo). */
  setRig(r: RtRig | null) {
    this.rig = r;
    if (!r) {
      this.first = true;
      return;
    }
    const snap = this.first;
    this.first = false;
    const env: RigEnv = { bpm: r.bpm, song: r.song };
    this.slots = syncSlots(this.slots, r.pedals, (id) => {
      const fx = makeFx(id, this.sr, this.B);
      return fx ? new Slot(id, fx, this.B) : null;
    }, snap, env);
    this.post = syncSlots(this.post, r.post, (id) => {
      const fx = makePostFx(id, this.sr, this.B);
      return fx ? new StereoSlot(id, fx, this.B) : null;
    }, snap, env);
    const model = r.amp ? AMPS.find((a) => a.id === r.amp) ?? null : null;
    if (model !== this.amp?.model) {
      this.amp = model ? new Amp(this.sr, this.B, model) : null;
      this.amp?.setKnobs(r.knobs, true);
    } else this.amp?.setKnobs(r.knobs, snap);
    if (r.cab) this.cab.setCab(r.cab, snap);
    this.applyReverbIr();
  }

  /** IRs das caixas (já na taxa da placa e com o volume ajustado pelo app). */
  setIr(key: string, a: CabIr | null, b: CabIr | null, now = false) {
    this.cab.setIr(key, a, b, () => {
      if (this.rig?.cab) this.cab.setCab(this.rig.cab, true);
    }, now ? buildNow : this.schedule);
  }

  /** IR do reverb (estéreo, na taxa da placa, já com a normalização do ConvolverNode). */
  setReverbIr(ir: ReverbIr, now = false) {
    this.reverbIr = ir;
    this.applyReverbIr(now);
  }

  private applyReverbIr(now = false) {
    const fx = this.post.find((s) => s.id === 'reverb')?.fx as Reverb | undefined;
    const ir = this.reverbIr;
    if (!fx || !ir || fx.irKey !== ir.key || fx.loadedKey === ir.key) return;
    fx.setIr(ir, now ? buildNow : this.schedule);
  }

  /** Chave da IR de reverb que os botões pedem agora (null = reverb desligado ou sem rack). */
  get reverbWant(): string | null {
    const s = this.post.find((x) => x.id === 'reverb');
    return s ? (s.fx as Reverb).irKey : null;
  }

  /**
   * Controle externo (automação da trilha): frequência do wah em Hz e velocidade do rotary; null = os botões.
   * Chamado antes de cada bloco.
   */
  external(wahHz: number | null, rotaryFast: boolean | null) {
    const wah = this.slots.find((s) => s.id === 'wah')?.fx as Wah | undefined;
    if (wah) wah.ext = wahHz;
    const rot = this.post.find((s) => s.id === 'rotary')?.fx as Rotary | undefined;
    rot?.external(rotaryFast);
  }

  /** Modo Auto do wah (a automação converte a posição do pedal em Hz conforme ele). */
  get wahAuto() {
    return (this.slots.find((s) => s.id === 'wah')?.fx as Wah | undefined)?.auto ?? false;
  }

  /** Processa um bloco de B amostras: entra mono em `L`, sai estéreo em `L` e `R`. */
  process(L: Float64Array, R: Float64Array) {
    const r = this.rig;
    const n = this.B, k = this.k;
    if (!r) {
      R.set(L);
      return;
    }
    for (const s of this.slots) s.run(L, n, k);
    if (this.amp) {
      this.amp.tick(k);
      this.amp.run(L, n);
    }
    if (r.cab && r.cab.irKey === this.cab.key && this.cab.loaded) {
      this.cab.tick(k);
      this.cab.runStereo(L, R, n);
    } else R.set(L);
    for (const s of this.post) s.run(L, R, n, k);
  }
}

/**
 * Roda um rack com todos os circuitos ligados em silêncio por alguns blocos: o JIT do V8 compila o código de
 * todos antes do áudio começar (senão os primeiros blocos de cada pedal saem lentos e estalam).
 */
export function warmupRig(sr: number, B: number, blocks = 40) {
  const p = new RtRigProcessor(sr, B);
  const ir = new Float32Array(Math.round(0.3 * sr));
  ir[0] = 1;
  ir[ir.length - 1] = 0.1;
  p.setIr('warm', [ir, ir], [ir], true);
  const knobs = { gain: 0.5, bass: 0.5, mid: 0.5, treble: 0.5, presence: 0.5, master: 0.5 };
  const on = (id: string) => ({ id, on: true, p: [0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5] });
  const pedals = [...RT_PEDALS].map(on);
  const post = [...RT_POST].map(on);
  const L = new Float64Array(B), R = new Float64Array(B);
  for (const m of AMPS) {
    p.setRig({ pedals, post, amp: m.id, knobs, bpm: 120, song: null, cab: { mix: 0.5, blend: 0.5, low: 80, high: 8000, irKey: 'warm' } });
    const want = p.reverbWant;
    if (want) p.setReverbIr({ key: want, l: ir, r: ir }, true);
    for (let k = 0; k < blocks; k++) {
      for (let i = 0; i < B; i++) L[i] = Math.sin(k * B + i) * 0.1;
      p.process(L, R);
    }
  }
}
