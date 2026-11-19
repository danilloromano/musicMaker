// Rack de guitarra amostra a amostra para o motor de baixa latência: os pedais de antes do amp, o amplificador e
// a caixa, com os mesmos circuitos do rack do app (amp.ts). Cada classe aqui reproduz o grafo de nós do
// pedal de lá — mesma ordem, filtros, curvas e valores — para a monitoração ter o timbre da trilha.
//
// Não depende do navegador nem do amp.ts (que usa o Web Audio): roda no processo de áudio (electron/host).
import type { RtPedal, RtRig } from '../lowLatencyProtocol';
import { AMPS, AmpModel, gainPot, magnitude, outGain, powerDrive, powerTube, toneStackZ, triode } from '../ampCircuits';
import { Curve, GateCurve, curveFn, gateCurveFn, sampleCurve } from './curves';
import { Biquad, BiquadType, Convolver, Highpass1, Iir3, Param, Shaper, VarBiquad, applyGain } from './dsp';

/** Constante de tempo da suavização dos botões (a mesma do `put` do rack do app). */
const SMOOTH = 0.015;

const expMap = (v: number, a: number, b: number) => a * (b / a) ** v;
const num = (v: number | undefined, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

// ---------- Tabelas das curvas (as mesmas do WaveShaperNode do app) ----------

const tables = new Map<string, Float32Array>();
const table = (key: string, make: () => Float32Array) => {
  let t = tables.get(key);
  if (!t) tables.set(key, (t = make()));
  return t;
};
const clipTable = (k: Curve) => table(k, () => sampleCurve(curveFn(k), 4096));
const gateTable = (k: GateCurve) => table(`gate:${k}`, () => sampleCurve(gateCurveFn(k), 2048));
const tubeTable = (k: 'triode' | 'power') => table(`tube:${k}`, () => sampleCurve(k === 'triode' ? triode : powerTube, 4096));

// ---------- Base ----------

/** Um efeito: processa um bloco no lugar; `set` recebe os botões (0..1). */
abstract class Fx {
  readonly params: Param[] = [];
  constructor(protected sr: number, protected B: number) {}
  protected p(v = 1) {
    const x = new Param(v);
    this.params.push(x);
    return x;
  }
  protected vb(type: BiquadType, f: number, q = Math.SQRT1_2, db = 0) {
    const v = new VarBiquad(this.sr, type, f, q, db);
    this.params.push(...v.params());
    return v;
  }
  protected bq(type: BiquadType, f: number, q = Math.SQRT1_2, db = 0) {
    return new Biquad(this.sr, type, f, q, db);
  }
  protected clip(k: Curve) {
    return new Shaper(clipTable(k), this.sr, true);
  }
  protected buf() {
    return new Float64Array(this.B);
  }
  tick(k: number) {
    for (const p of this.params) p.tick(k);
  }
  abstract run(b: Float64Array, n: number): void;
  abstract set(p: number[], snap: boolean): void;
}

const copy = (src: Float64Array, dst: Float64Array, n: number) => {
  for (let i = 0; i < n; i++) dst[i] = src[i];
};
const add = (dst: Float64Array, src: Float64Array, n: number) => {
  for (let i = 0; i < n; i++) dst[i] += src[i];
};
const scale = (b: Float64Array, n: number, g: number) => {
  for (let i = 0; i < n; i++) b[i] *= g;
};

// ---------- Pedais ----------

/** Noise gate (ver noiseGate em amp.ts): envelope retificado → curva de abertura → ataque rápido + release. */
class Gate extends Fx {
  private pre = this.p(1);
  private rect = new Shaper(gateTable('rect'), this.sr);
  private open = new Shaper(gateTable('open'), this.sr);
  private clamp = new Shaper(gateTable('clamp'), this.sr);
  private env = this.bq('lowpass', 150);
  private fast = this.bq('lowpass', 1 / (2 * Math.PI * 0.001));
  private rel = this.vb('lowpass', 5);
  run(b: Float64Array, n: number) {
    const rel = this.rel;
    rel.update();
    const g0 = this.pre.prev, dg = (this.pre.value - g0) / n;
    for (let i = 0; i < n; i++) {
      const e = this.env.tick(this.rect.tick(b[i] * (g0 + dg * (i + 1))));
      const o = this.open.tick(e);
      b[i] *= this.clamp.tick(this.fast.tick(o) + rel.bq.tick(o));
    }
  }
  set([thr, release]: number[], snap: boolean) {
    const db = -80 + num(thr, 0.4) * 50;
    this.pre.set(0.4 / 10 ** (db / 20), snap);
    this.rel.f.set(1 / (2 * Math.PI * (0.02 + num(release, 0.3) * 0.38)), snap);
  }
}

/** Distorção simples (drivePedal): passa-altas → ganho → clipagem → tom → nível. */
class Drive extends Fx {
  private h: Biquad;
  private pre = this.p();
  private sh: Shaper;
  private dc = this.bq('highpass', 25);
  private tone = this.vb('lowpass', 3000);
  private out = this.p();
  constructor(sr: number, B: number, hp: number, private range: number, kind: Curve, private toneA: number, private toneB: number, private outScale: number) {
    super(sr, B);
    this.h = this.bq('highpass', hp);
    this.sh = this.clip(kind);
  }
  run(b: Float64Array, n: number) {
    this.h.run(b, n);
    applyGain(b, n, this.pre);
    this.sh.run(b, n);
    this.dc.run(b, n);
    this.tone.run(b, n);
    applyGain(b, n, this.out);
  }
  set([drive, t, level]: number[], snap: boolean) {
    this.pre.set(1 + num(drive, 0.5) * this.range, snap);
    this.tone.f.set(expMap(num(t, 0.5), this.toneA, this.toneB), snap);
    this.out.set(this.outScale * num(level, 0.5) * 2, snap);
  }
}

interface FeedbackOpts { min: number; range: number; curve: Curve; bassCut: number; hump: [number, number]; toneA: number; toneB: number; out: number }

/** Overdrive com diodos na realimentação (TS808 / SD-1): limpo + parte clipada sem graves. */
class FeedbackDrive extends Fx {
  private clean = this.buf();
  private hp = new Highpass1(this.sr, 720);
  private pre = this.p();
  private sh: Shaper;
  private dc = this.bq('highpass', 30);
  private bass: Biquad;
  private hump: Biquad;
  private tone = this.vb('lowpass', 3000, 0.6);
  private out = this.p();
  constructor(sr: number, B: number, private o: FeedbackOpts) {
    super(sr, B);
    this.sh = this.clip(o.curve);
    this.bass = this.bq('lowshelf', 250, 0.7, -o.bassCut);
    this.hump = this.bq('peaking', o.hump[0], 0.7, o.hump[1]);
  }
  run(b: Float64Array, n: number) {
    copy(b, this.clean, n);
    this.hp.run(b, n);
    applyGain(b, n, this.pre);
    this.sh.run(b, n);
    scale(b, n, 0.5);
    add(b, this.clean, n);
    this.dc.run(b, n);
    this.bass.run(b, n);
    this.hump.run(b, n);
    this.tone.run(b, n);
    applyGain(b, n, this.out);
  }
  set([drive, t, level]: number[], snap: boolean) {
    this.pre.set(this.o.min + num(drive, 0.4) * this.o.range, snap);
    this.tone.f.set(expMap(num(t, 0.5), this.o.toneA, this.o.toneB), snap);
    this.out.set(this.o.out * num(level, 0.5) * 2, snap);
  }
}

/** Overdrive transparente (Klon): limpo de banda cheia + sujo de germânio, cruzados pelo ganho. */
class TransparentDrive extends Fx {
  private cleanBuf = this.buf();
  private clean = this.p();
  private hp = new Highpass1(this.sr, 250);
  private pre = this.p();
  private sh = this.clip('germ');
  private lp = this.bq('lowpass', 6500);
  private dirty = this.p();
  private mid = this.bq('peaking', 1000, 0.8, 0.5);
  private treble = this.vb('highshelf', 1500);
  private dc = this.bq('highpass', 30);
  private out = this.p();
  run(b: Float64Array, n: number) {
    copy(b, this.cleanBuf, n);
    applyGain(this.cleanBuf, n, this.clean);
    this.hp.run(b, n);
    applyGain(b, n, this.pre);
    this.sh.run(b, n);
    this.lp.run(b, n);
    applyGain(b, n, this.dirty);
    add(b, this.cleanBuf, n);
    this.mid.run(b, n);
    this.treble.run(b, n);
    this.dc.run(b, n);
    applyGain(b, n, this.out);
  }
  set([gain, tr, level]: number[], snap: boolean) {
    const g = num(gain, 0.35);
    this.clean.set(1 - g * 0.5, snap);
    this.pre.set(1 + g * 50, snap);
    this.dirty.set(0.1 + g * 0.35, snap);
    this.treble.db.set((num(tr, 0.5) - 0.5) * 20, snap);
    this.out.set(0.5 * num(level, 0.55) * 2, snap);
  }
}

/** Distorção Preta (RAT). */
class BlackDist extends Fx {
  private hp = new Highpass1(this.sr, 60);
  private emph = this.bq('peaking', 1000, 0.6, 3);
  private pre = this.p();
  private sh = this.clip('diode');
  private dc = this.bq('highpass', 30);
  private flt = this.vb('lowpass', 3000, 0.5);
  private out = this.p();
  run(b: Float64Array, n: number) {
    this.hp.run(b, n);
    this.emph.run(b, n);
    applyGain(b, n, this.pre);
    this.sh.run(b, n);
    this.dc.run(b, n);
    this.flt.run(b, n);
    applyGain(b, n, this.out);
  }
  set([dist, f, vol]: number[], snap: boolean) {
    this.pre.set(2 + num(dist, 0.5) ** 2 * 400, snap);
    this.flt.f.set(expMap(1 - num(f, 0.4), 600, 14000), snap);
    this.out.set(0.3 * num(vol, 0.5) * 2, snap);
  }
}

/** Distorção Britânica (amp num pedal): dois estágios assimétricos e médios. */
class BritDist extends Fx {
  private hp = new Highpass1(this.sr, 90);
  private g1 = this.p();
  private s1 = this.clip('asym');
  private between = this.bq('lowpass', 5500);
  private g2 = this.p();
  private s2 = this.clip('soft');
  private dc = this.bq('highpass', 30);
  private mid = this.bq('peaking', 750, 0.8, 4);
  private tone = this.vb('highshelf', 2200);
  private cut = this.bq('lowpass', 7000);
  private out = this.p();
  run(b: Float64Array, n: number) {
    this.hp.run(b, n);
    applyGain(b, n, this.g1);
    this.s1.run(b, n);
    this.between.run(b, n);
    applyGain(b, n, this.g2);
    this.s2.run(b, n);
    this.dc.run(b, n);
    this.mid.run(b, n);
    this.tone.run(b, n);
    this.cut.run(b, n);
    applyGain(b, n, this.out);
  }
  set([gain, t, level]: number[], snap: boolean) {
    const g = num(gain, 0.5);
    this.g1.set(1.5 + g * 12, snap);
    this.g2.set(1 + g * 6, snap);
    this.tone.db.set((num(t, 0.5) - 0.5) * 18, snap);
    this.out.set(0.32 * num(level, 0.5) * 2, snap);
  }
}

/** Distorção Metal (MT-2): dois estágios duros e EQ ativo. */
class MetalDist extends Fx {
  private hp = new Highpass1(this.sr, 100);
  private g1 = this.p();
  private s1 = this.clip('hard');
  private between = this.bq('lowpass', 6000);
  private g2 = this.p();
  private s2 = this.clip('diode');
  private dc = this.bq('highpass', 30);
  private low = this.bq('lowshelf', 120, 0.7, 6);
  private mid = this.vb('peaking', 800, 0.9);
  private high = this.vb('highshelf', 3000);
  private fizz = this.bq('lowpass', 8000, 0.7);
  private out = this.p();
  run(b: Float64Array, n: number) {
    this.hp.run(b, n);
    applyGain(b, n, this.g1);
    this.s1.run(b, n);
    this.between.run(b, n);
    applyGain(b, n, this.g2);
    this.s2.run(b, n);
    this.dc.run(b, n);
    this.low.run(b, n);
    this.mid.run(b, n);
    this.high.run(b, n);
    this.fizz.run(b, n);
    applyGain(b, n, this.out);
  }
  set([drive, m, h, level]: number[], snap: boolean) {
    const d = num(drive, 0.6);
    this.g1.set(5 + d * 40, snap);
    this.g2.set(2 + d * 10, snap);
    this.mid.db.set((num(m, 0.3) - 0.5) * 30, snap);
    this.high.db.set((num(h, 0.55) - 0.5) * 24, snap);
    this.out.set(0.22 * num(level, 0.5) * 2, snap);
  }
}

/** Fuzz Muff (Big Muff): dois estágios macios e o tom que mistura passa-baixas e passa-altas. */
class MuffFuzz extends Fx {
  private hp = new Highpass1(this.sr, 80);
  private g1 = this.p();
  private s1 = this.clip('soft');
  private f1 = this.bq('lowpass', 3500);
  private g2 = this.p();
  private s2 = this.clip('soft');
  private dc = this.bq('highpass', 30);
  private lp = this.bq('lowpass', 700, 0.5);
  private hpT = this.bq('highpass', 1400, 0.5);
  private lg = this.p();
  private hg = this.p();
  private out = this.p();
  private hi = this.buf();
  run(b: Float64Array, n: number) {
    this.hp.run(b, n);
    applyGain(b, n, this.g1);
    this.s1.run(b, n);
    this.f1.run(b, n);
    applyGain(b, n, this.g2);
    this.s2.run(b, n);
    this.dc.run(b, n);
    copy(b, this.hi, n);
    this.lp.run(b, n);
    applyGain(b, n, this.lg);
    this.hpT.run(this.hi, n);
    applyGain(this.hi, n, this.hg);
    add(b, this.hi, n);
    applyGain(b, n, this.out);
  }
  set([sus, t, vol]: number[], snap: boolean) {
    const s = num(sus, 0.6), tt = num(t, 0.5);
    this.g1.set(3 + s * 30, snap);
    this.g2.set(2 + s * 12, snap);
    this.lg.set(1 - tt, snap);
    this.hg.set(tt * 1.3, snap);
    this.out.set(0.45 * num(vol, 0.5) * 2, snap);
  }
}

/** Fuzz Germânio (Fuzz Face): um estágio assimétrico, limpa tocando leve. */
class GermFuzz extends Fx {
  private hp = new Highpass1(this.sr, 40);
  private pre = this.p();
  private sh = this.clip('germAsym');
  private dc = this.bq('highpass', 30);
  private warm = this.bq('lowpass', 4500, 0.6);
  private out = this.p();
  run(b: Float64Array, n: number) {
    this.hp.run(b, n);
    applyGain(b, n, this.pre);
    this.sh.run(b, n);
    this.dc.run(b, n);
    this.warm.run(b, n);
    applyGain(b, n, this.out);
  }
  set([fuzz, vol]: number[], snap: boolean) {
    this.pre.set(1 + num(fuzz, 0.65) * 60, snap);
    this.out.set(0.35 * num(vol, 0.5) * 2, snap);
  }
}

const EQ_BANDS = [100, 200, 400, 800, 1600, 3200, 6400];

/** Equalizador gráfico de 7 bandas e volume. */
class GraphicEq extends Fx {
  private bands = EQ_BANDS.map((f) => this.vb('peaking', f, 1.4));
  private level = this.p();
  run(b: Float64Array, n: number) {
    for (const x of this.bands) x.run(b, n);
    applyGain(b, n, this.level);
  }
  set(p: number[], snap: boolean) {
    this.bands.forEach((x, i) => x.db.set((num(p[i], 0.5) - 0.5) * 30, snap));
    this.level.set(10 ** (((num(p[EQ_BANDS.length], 0.5) - 0.5) * 30) / 20), snap);
  }
}

/** Booster limpo: ganho linear e prateleiras. */
class BoostClean extends Fx {
  private g = this.p();
  private ls = this.vb('lowshelf', 120);
  private hs = this.vb('highshelf', 2500);
  run(b: Float64Array, n: number) {
    applyGain(b, n, this.g);
    this.ls.run(b, n);
    this.hs.run(b, n);
  }
  set([gain, bright, bass]: number[], snap: boolean) {
    this.g.set(1 + num(gain, 0.4) * 7, snap);
    this.hs.db.set(num(bright, 0.3) * 10, snap);
    this.ls.db.set((num(bass, 0.5) - 0.5) * 12, snap);
  }
}

/** Booster FET: satura de leve, presença e tom. */
class BoostFet extends Fx {
  private hp = new Highpass1(this.sr, 70);
  private pre = this.p();
  private sh = this.clip('fet');
  private dc = this.bq('highpass', 25);
  private presence = this.bq('peaking', 2800, 0.8, 3);
  private tone = this.vb('lowpass', 8000, 0.6);
  private out = this.p();
  run(b: Float64Array, n: number) {
    this.hp.run(b, n);
    applyGain(b, n, this.pre);
    this.sh.run(b, n);
    this.dc.run(b, n);
    this.presence.run(b, n);
    this.tone.run(b, n);
    applyGain(b, n, this.out);
  }
  set([gain, t, level]: number[], snap: boolean) {
    this.pre.set(1 + num(gain, 0.45) * 14, snap);
    this.tone.f.set(expMap(num(t, 0.55), 2500, 14000), snap);
    this.out.set((num(level, 0.5) * 2) / 1.49, snap);
  }
}

function makeFx(id: string, sr: number, B: number): Fx | null {
  switch (id) {
    case 'gate': return new Gate(sr, B);
    case 'eq': return new GraphicEq(sr, B);
    case 'boostClean': return new BoostClean(sr, B);
    case 'boostFet': return new BoostFet(sr, B);
    case 'odGreen': return new FeedbackDrive(sr, B, { min: 12, range: 106, curve: 'soft', bassCut: 9, hump: [720, 4], toneA: 800, toneB: 5000, out: 0.37 });
    case 'odYellow': return new FeedbackDrive(sr, B, { min: 10, range: 120, curve: 'asym', bassCut: 6, hump: [900, 2], toneA: 1500, toneB: 9000, out: 0.4 });
    case 'odGold': return new TransparentDrive(sr, B);
    case 'dist': return new Drive(sr, B, 120, 250, 'hard', 1200, 9000, 0.25);
    case 'distBlack': return new BlackDist(sr, B);
    case 'distBrit': return new BritDist(sr, B);
    case 'distMetal': return new MetalDist(sr, B);
    case 'fuzz': return new Drive(sr, B, 60, 600, 'asym', 700, 6000, 0.25);
    case 'fuzzMuff': return new MuffFuzz(sr, B);
    case 'fuzzGerm': return new GermFuzz(sr, B);
    default: return null;
  }
}

/** Pedais (ids de circuito) que a monitoração de baixa latência já processa. */
export const RT_PEDALS = new Set([
  'gate', 'eq', 'boostClean', 'boostFet', 'odGreen', 'odYellow', 'odGold',
  'dist', 'distBlack', 'distBrit', 'distMetal', 'fuzz', 'fuzzMuff', 'fuzzGerm',
]);

/** Pedal com chave liga/desliga: mistura seco/processado com a mesma suavização (sem estalo). */
class Slot {
  private mix = new Param(0);
  private dry: Float64Array;
  constructor(readonly id: string, readonly fx: Fx, B: number) {
    this.dry = new Float64Array(B);
  }
  set(st: RtPedal, snap: boolean) {
    this.mix.set(st.on ? 1 : 0, snap);
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

/** Caixa A e B (convolução com os IRs) misturadas, cortes de grave/agudo e mistura com o sinal sem caixa. */
class Cab extends Fx {
  private a: Convolver | null = null;
  private b: Convolver | null = null;
  private gA = this.p(1);
  private gB = this.p(0);
  private wetG = this.p(1);
  private dryG = this.p(0);
  private hp = this.vb('highpass', 10, 0.707);
  private lp: VarBiquad;
  private dry = this.buf();
  private wb = this.buf();
  constructor(sr: number, B: number) {
    super(sr, B);
    this.lp = this.vb('lowpass', (sr / 2) * 0.95, 0.707);
  }
  setIr(a: Float32Array | null, b: Float32Array | null) {
    this.a = a ? new Convolver(a, this.B) : null;
    this.b = b ? new Convolver(b, this.B) : null;
  }
  get loaded() {
    return !!(this.a || this.b);
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
    this.hp.f.set(c.low ? Math.min(nyq * 0.9, c.low) : 10, snap);
    this.lp.f.set(c.high ? Math.min(nyq * 0.9, c.high) : nyq * 0.95, snap);
  }
  run(x: Float64Array, n: number) {
    if (!this.a && !this.b) return;
    copy(x, this.dry, n);
    const w = this.wb;
    if (this.a) {
      this.a.run(this.dry, x);
      applyGain(x, n, this.gA);
    } else x.fill(0);
    if (this.b) {
      this.b.run(this.dry, w);
      applyGain(w, n, this.gB);
      add(x, w, n);
    }
    this.hp.run(x, n);
    this.lp.run(x, n);
    applyGain(x, n, this.wetG);
    applyGain(this.dry, n, this.dryG);
    add(x, this.dry, n);
  }
}

// ---------- Rack ----------

/**
 * O rack inteiro (mono): pedais de antes do amp na ordem do app → amp → caixa. Os pedais de depois da caixa
 * (modulação, delay, reverb) e os que ainda não foram portados passam direto.
 */
export class RtRigProcessor {
  private slots: Slot[] = [];
  private amp: Amp | null = null;
  private cab: Cab;
  private irKey = '';
  private rig: RtRig | null = null;
  private k: number;
  private first = true;
  constructor(private sr: number, private B: number) {
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
    // pedais: reaproveita os que continuam com o mesmo circuito (mantém o estado dos filtros)
    const old = new Map(this.slots.map((s) => [s.id, s]));
    this.slots = [];
    for (const st of r.pedals) {
      let s = old.get(st.id);
      if (!s) {
        const fx = makeFx(st.id, this.sr, this.B);
        if (!fx) continue;
        s = new Slot(st.id, fx, this.B);
        s.set(st, true);
        // pedal novo que já chega ligado entra com o mix suave a partir de 0
        if (!snap && st.on) s.set({ ...st, on: false }, true);
      }
      s.set(st, snap);
      this.slots.push(s);
    }
    const model = r.amp ? AMPS.find((a) => a.id === r.amp) ?? null : null;
    if (model !== this.amp?.model) {
      this.amp = model ? new Amp(this.sr, this.B, model) : null;
      this.amp?.setKnobs(r.knobs, true);
    } else this.amp?.setKnobs(r.knobs, snap);
    if (r.cab) this.cab.setCab(r.cab, snap);
  }

  /** IRs das caixas (já na taxa da placa e com o volume ajustado pelo app). */
  setIr(key: string, a: Float32Array | null, b: Float32Array | null) {
    this.irKey = key;
    this.cab.setIr(a, b);
    if (this.rig?.cab) this.cab.setCab(this.rig.cab, true);
  }

  /** Processa um bloco de B amostras no lugar. */
  process(b: Float64Array) {
    const r = this.rig;
    if (!r) return;
    const n = this.B, k = this.k;
    for (const s of this.slots) s.run(b, n, k);
    if (this.amp) {
      this.amp.tick(k);
      this.amp.run(b, n);
    }
    if (r.cab && r.cab.irKey === this.irKey && this.cab.loaded) {
      this.cab.tick(k);
      this.cab.run(b, n);
    }
  }
}

/**
 * Roda um rack com todos os circuitos ligados em silêncio por alguns blocos: o JIT do V8 compila o código de
 * todos antes do áudio começar (senão os primeiros blocos de cada pedal saem lentos e estalam).
 */
export function warmupRig(sr: number, B: number) {
  const p = new RtRigProcessor(sr, B);
  const ir = new Float32Array(Math.round(0.08 * sr));
  ir[0] = 1;
  p.setIr('warm', ir, ir);
  const knobs = { gain: 0.5, bass: 0.5, mid: 0.5, treble: 0.5, presence: 0.5, master: 0.5 };
  const pedals = [...RT_PEDALS].map((id) => ({ id, on: true, p: [0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5] }));
  const b = new Float64Array(B);
  for (const m of AMPS) {
    p.setRig({ pedals, amp: m.id, knobs, cab: { mix: 0.5, blend: 0.5, low: 80, high: 8000, irKey: 'warm' } });
    for (let k = 0; k < 40; k++) {
      for (let i = 0; i < B; i++) b[i] = Math.sin(k * B + i) * 0.1;
      p.process(b);
    }
  }
}
