// Pedais de antes do amp (mono), como os do rack do app (amp.ts): mesmos filtros, curvas e valores.
import { Curve } from './curves';
import { Biquad, Highpass1, Shaper, applyGain } from './dsp';
import { COMP_REF, EQ_BANDS, HARMONY_DEF, HARMONY_STEPS, compSettings, expMap, harmonyKey, harmonyStep, pitchRatio, wahFreq } from './pedalMath';
import { HarmonyCore, OctaveCore, PitchCore, UnivibeCore } from './cores';
import { Fx, add, copy, f32, gateTable, num, scale } from './base';

// ---------- Pedais ----------

/** Noise gate (ver noiseGate em amp.ts): envelope retificado → curva de abertura → ataque rápido + release. */
class Gate extends Fx {
  private pre = this.p(1);
  private rect = new Shaper(gateTable('rect'), this.sr);
  private open = new Shaper(gateTable('open'), this.sr);
  private clamp = new Shaper(gateTable('clamp'), this.sr);
  private envLp = this.bq('lowpass', 150);
  private fast = this.bq('lowpass', 1 / (2 * Math.PI * 0.001));
  private rel = this.vb('lowpass', 5);
  run(b: Float64Array, n: number) {
    const rel = this.rel;
    rel.update();
    const g0 = this.pre.prev, dg = (this.pre.value - g0) / n;
    for (let i = 0; i < n; i++) {
      const e = this.envLp.tick(this.rect.tick(b[i] * (g0 + dg * (i + 1))));
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

export function makeFx(id: string, sr: number, B: number): Fx | null {
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
    case 'comp': return new Comp(sr, B);
    case 'octave': return new Octave(sr, B);
    case 'pitch': return new Pitch(sr, B);
    case 'harmony': return new Harmony(sr, B);
    case 'univibe': return new Univibe(sr, B);
    case 'wah': return new Wah(sr, B);
    default: return null;
  }
}

/** Pedais (ids de circuito) que a monitoração de baixa latência já processa. */
export const RT_PEDALS = new Set([
  'gate', 'eq', 'boostClean', 'boostFet', 'odGreen', 'odYellow', 'odGold',
  'dist', 'distBlack', 'distBrit', 'distMetal', 'fuzz', 'fuzzMuff', 'fuzzGerm',
  'comp', 'octave', 'pitch', 'harmony', 'univibe', 'wah',
]);


// ---------- Compressor ----------

const dB = (x: number) => 20 * Math.log10(x);
const lin = (d: number) => 10 ** (d / 20);

/**
 * O algoritmo do DynamicsCompressorNode do Chromium (DynamicsCompressorKernel): curva estática com joelho
 * exponencial e razão constante depois dele, detector com "release de saturação", envelope com ataque
 * pelo maior excesso visto e release adaptativo (mais compressão = volta mais rápido), curva em seno e o
 * ganho de compensação automático (60% da redução de um sinal em 0 dBFS). Processa em divisões de 32 amostras.
 * Sem o pré-atraso de 6 ms do original: na monitoração ele seria só latência.
 */
class ChromeCompressor {
  private detector = 0;
  private gain = 1;
  private maxAttackDiff = -1;
  private key = '';
  private k = 1;
  private linThr = 1;
  private kneeThr = 1;
  private kneeThrDb = 0;
  private yKneeThrDb = 0;
  private slope = 1;
  constructor(private sr: number) {}
  private knee(x: number, k: number) {
    if (x < this.linThr) return x;
    return this.linThr + (1 - Math.exp(-k * (x - this.linThr))) / k;
  }
  private saturate(x: number, k: number) {
    if (x < this.kneeThr) return this.knee(x, k);
    return lin(this.yKneeThrDb + this.slope * (dB(x) - this.kneeThrDb));
  }
  private slopeAt(x: number, k: number) {
    if (x < this.linThr) return 1;
    const x2 = x * 1.001;
    return (dB(this.knee(x2, k)) - dB(this.knee(x, k))) / (dB(x2) - dB(x));
  }
  private curve(thr: number, kneeDb: number, ratio: number) {
    const key = `${thr}|${kneeDb}|${ratio}`;
    if (key === this.key) return this.k;
    this.key = key;
    this.linThr = lin(thr);
    this.slope = 1 / ratio;
    // k tal que a inclinação no fim do joelho seja 1/razão (busca geométrica, 15 passos)
    const x = lin(thr + kneeDb);
    let minK = 0.1, maxK = 10000, k = 5;
    for (let i = 0; i < 15; i++) {
      if (this.slopeAt(x, k) < this.slope) maxK = k;
      else minK = k;
      k = Math.sqrt(minK * maxK);
    }
    this.kneeThrDb = thr + kneeDb;
    this.kneeThr = lin(this.kneeThrDb);
    this.yKneeThrDb = dB(this.knee(this.kneeThr, k));
    this.k = k;
    return k;
  }
  process(b: Float64Array, n: number, thr: number, kneeDb: number, ratio: number, attack: number, release: number) {
    const k = this.curve(thr, kneeDb, ratio);
    const makeup = (1 / this.saturate(1, k)) ** 0.6;
    const attackFrames = Math.max(0.001, attack) * this.sr;
    const releaseFrames = this.sr * release;
    const satReleaseFrames = 0.0025 * this.sr;
    // release adaptativo: curva que passa por 4 pontos (zonas de 9%, 16%, 42% e 98% do release)
    const y1 = releaseFrames * 0.09, y2 = releaseFrames * 0.16, y3 = releaseFrames * 0.42, y4 = releaseFrames * 0.98;
    const kA = 0.9999999999999998 * y1 + 1.8432219684323923e-16 * y2 - 1.9373394351676423e-16 * y3 + 8.824516011816245e-18 * y4;
    const kB = -1.5788320352845888 * y1 + 2.3305837032074286 * y2 - 0.9141194204840429 * y3 + 0.1623677525612032 * y4;
    const kC = 0.5334142869106424 * y1 - 1.272736789213631 * y2 + 0.9258856042207512 * y3 - 0.18656310191776226 * y4;
    const kD = 0.08783463138207234 * y1 - 0.1694162967925622 * y2 + 0.08588057951595272 * y3 - 0.00429891410546283 * y4;
    const kE = -0.042416883008123074 * y1 + 0.1115693827987602 * y2 - 0.09764676325265872 * y3 + 0.028494263462021576 * y4;
    for (let d = 0; d < n; d += 32) {
      const end = Math.min(n, d + 32);
      let det = this.detector;
      if (!Number.isFinite(det)) det = 1;
      const scaled = Math.asin(Math.min(1, det)) / (Math.PI / 2);
      let rate: number;
      let diff = dB(this.gain / scaled);
      if (scaled > this.gain) {
        this.maxAttackDiff = -1;
        if (!Number.isFinite(diff)) diff = -1;
        const x = 0.25 * (Math.min(0, Math.max(-12, diff)) + 12);
        const frames = kA + kB * x + kC * x * x + kD * x * x * x + kE * x * x * x * x;
        rate = lin(5 / frames);
      } else {
        if (!Number.isFinite(diff)) diff = 1;
        if (this.maxAttackDiff === -1 || this.maxAttackDiff < diff) this.maxAttackDiff = diff;
        const eff = Math.max(0.5, this.maxAttackDiff);
        rate = 1 - (0.25 / eff) ** (1 / attackFrames);
      }
      let g = this.gain;
      for (let i = d; i < end; i++) {
        const ax = Math.abs(b[i]);
        const att = ax <= 0.0001 ? 1 : this.saturate(ax, k) / ax;
        const attDb = Math.max(2, -dB(att));
        const satRate = lin(attDb / satReleaseFrames) - 1;
        det += (att - det) * (att > det ? satRate : 1);
        det = Math.min(1, det);
        if (!Number.isFinite(det)) det = 1;
        if (rate < 1) g += (scaled - g) * rate;
        else g = Math.min(1, g * rate);
        b[i] *= makeup * Math.sin((Math.PI / 2) * g);
      }
      this.gain = g;
      this.detector = det;
    }
  }
}

/** Compressor de pedal (compPedal em amp.ts): compressão paralela com blend e compensação automática. */
class Comp extends Fx {
  private c = new ChromeCompressor(this.sr);
  private tone = this.vb('lowpass', 20000, 0.5);
  private dryBuf = this.buf();
  private dry = this.p(0);
  private wet = this.p(1);
  private out = this.p(1);
  private s = compSettings(0.5, 0.35, false);
  run(b: Float64Array, n: number) {
    copy(b, this.dryBuf, n);
    applyGain(this.dryBuf, n, this.dry);
    const s = this.s;
    this.c.process(b, n, s.threshold, s.knee, s.ratio, s.attack, s.release);
    this.tone.run(b, n);
    applyGain(b, n, this.wet);
    add(b, this.dryBuf, n);
    applyGain(b, n, this.out);
  }
  set([sus, lvl, att, blend, mode]: number[], snap: boolean) {
    const studio = num(mode, 0) >= 0.5;
    const s = (this.s = compSettings(num(sus, 0.5), num(att, 0.35), studio));
    this.tone.f.set(s.tone, snap);
    const slope = 1 - 1 / s.ratio;
    const reduction = Math.max(0, (COMP_REF - s.threshold) * slope);
    const builtIn = 0.6 * -s.threshold * slope;
    const bl = num(blend, 0.85);
    this.wet.set(bl * 10 ** ((reduction - builtIn) / 20), snap);
    this.dry.set(1 - bl, snap);
    this.out.set(num(lvl, 0.5) * 2, snap);
  }
}

// ---------- Pedais que no app são AudioWorklets (mesmo núcleo: rt/cores.ts) ----------

/** Octaver: direto + oitavas abaixo. */
class Octave extends Fx {
  private core = new OctaveCore(this.sr);
  private sub = this.buf();
  private dry = this.p();
  private g1 = this.p(0);
  private g2 = this.p(0);
  run(b: Float64Array, n: number) {
    this.core.process(b, [this.sub], n, f32(this.g1), f32(this.g2));
    applyGain(b, n, this.dry);
    add(b, this.sub, n);
  }
  set([direct, sub1, sub2]: number[], snap: boolean) {
    this.dry.set(num(direct, 0.7) * 1.4, snap);
    this.g1.set(num(sub1, 0.6) * 3, snap);
    this.g2.set(num(sub2, 0) * 3, snap);
  }
}

/** Pitch (pitchPedalHQ): direto + transposto (WSOLA) com o agudo arredondado. */
class Pitch extends Fx {
  private core = new PitchCore(this.sr);
  private wetBuf = this.buf();
  private tone = this.bq('lowpass', 9000);
  private ratio = this.p(2);
  private dry = this.p();
  private wet = this.p();
  run(b: Float64Array, n: number) {
    this.core.process(b, [this.wetBuf], n, f32(this.ratio));
    this.tone.run(this.wetBuf, n);
    applyGain(this.wetBuf, n, this.wet);
    applyGain(b, n, this.dry);
    add(b, this.wetBuf, n);
  }
  set([interval, fine, mix]: number[], snap: boolean) {
    this.ratio.set(pitchRatio(num(interval, 1), num(fine, 0.5)), snap);
    const m = num(mix, 0.5);
    this.dry.set(Math.min(1, 2 * (1 - m)), snap);
    this.wet.set(Math.min(1, 2 * m), snap);
  }
}

/** Harmonizador: direto + voz na escala (tom da música ou o do pedal). */
class Harmony extends Fx {
  private core = new HarmonyCore(this.sr);
  private voice = this.buf();
  private level = this.p(0);
  private sent = '';
  run(b: Float64Array, n: number) {
    this.core.process(b, [this.voice], n, f32(this.level));
    add(b, this.voice, n);
  }
  set([key, step, voice, minor, manual]: number[], snap: boolean) {
    this.level.set(num(voice, 0.6) * 1.5, snap);
    const song = num(manual, 0) < 0.5 ? this.env.song : null;
    const msg = {
      key: song ? song.root : harmonyKey(num(key, 0)),
      minor: song ? song.minor : num(minor, 0) >= 0.5,
      offset: HARMONY_STEPS[harmonyStep(num(step, HARMONY_DEF))].deg,
    };
    const k = JSON.stringify(msg);
    if (k !== this.sent) {
      this.sent = k;
      this.core.setKey(msg);
    }
  }
}

/** Univibe: pré com saturação suave, 30% do direto + 70% do defasado. */
class Univibe extends Fx {
  private sat = this.clip('tape');
  private core = new UnivibeCore(this.sr);
  private wetBuf = this.buf();
  private rate = this.p(2);
  private depth = this.p(0.65);
  private out = this.p();
  run(b: Float64Array, n: number) {
    scale(b, n, 1.4);
    this.sat.run(b, n);
    this.core.process(b, [this.wetBuf], n, f32(this.rate), f32(this.depth));
    for (let i = 0; i < n; i++) b[i] = b[i] * 0.3 + this.wetBuf[i] * 0.7;
    applyGain(b, n, this.out);
  }
  set([rate, depth, vol]: number[], snap: boolean) {
    this.rate.set(expMap(num(rate, 0.35), 0.4, 12), snap);
    this.depth.set(num(depth, 0.65), snap);
    this.out.set(((num(vol, 0.5) * 2) / 1.4) * 1.1, snap);
  }
}

/**
 * Wah: passa-banda ressonante (fórmula do BiquadFilterNode, recalculada a cada amostra como o nó faz quando a
 * frequência recebe um sinal) na posição do pedal; no Auto o envelope da palhetada soma à frequência.
 */
class Wah extends Fx {
  private rect = new Shaper(gateTable('rect'), this.sr);
  private envLp = this.bq('lowpass', 9);
  private base = this.p(800);
  private amount = this.p(0);
  private q = this.p(4);
  private wet = this.p(1);
  private x1 = 0;
  private x2 = 0;
  private y1 = 0;
  private y2 = 0;
  run(b: Float64Array, n: number) {
    const sr = this.sr, nyq = sr / 2;
    const b0 = this.base.prev, db = (this.base.value - b0) / n;
    const a0 = this.amount.prev, da = (this.amount.value - a0) / n;
    const q0 = this.q.prev, dq = (this.q.value - q0) / n;
    const w0 = this.wet.prev, dw = (this.wet.value - w0) / n;
    let x1 = this.x1, x2 = this.x2, y1 = this.y1, y2 = this.y2;
    for (let i = 0; i < n; i++) {
      const x = b[i];
      const e = this.envLp.tick(this.rect.tick(x));
      const f = Math.min(nyq * 0.999, Math.max(1, b0 + db * (i + 1) + e * (a0 + da * (i + 1))));
      const w = (2 * Math.PI * f) / sr, al = Math.sin(w) / (2 * (q0 + dq * (i + 1))), c = -2 * Math.cos(w);
      const y = (al * x - al * x2 - c * y1 - (1 - al) * y2) / (1 + al);
      x2 = x1;
      x1 = x;
      y2 = y1;
      y1 = y;
      b[i] = y * (w0 + dw * (i + 1)) + x * 0.12;
    }
    this.x1 = x1;
    this.x2 = x2;
    this.y1 = y1;
    this.y2 = y2;
  }
  set([pos, sens, res, mode]: number[], snap: boolean) {
    const auto = num(mode, 0) >= 0.5;
    this.base.set(wahFreq(num(pos, 0.5), auto), snap);
    this.amount.set(auto ? num(sens, 0.5) * 9000 : 0, snap);
    const q = 2 + num(res, 0.5) * 8;
    this.q.set(q, snap);
    this.wet.set(0.9 + q * 0.18, snap);
  }
}
