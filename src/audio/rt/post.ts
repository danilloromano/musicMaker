// Pedais de depois da caixa (estéreo), como os do rack do app (amp.ts): chorus, phaser, flanger, vibrato,
// rotary, tremolo, delay e reverb. Cada um recebe e devolve os dois canais (L, R) no lugar. Onde o grafo do
// app junta canais (ChannelMerger), aqui entra a média dos dois, como o navegador faz.
import { Biquad, BiquadType, DelayLine, LongConvolver, Param, Shaper, VarBiquad, applyGain } from './dsp';
import type { BuildScheduler } from './dsp';
import { PhaserCore, ReverseCore } from './cores';
import { RigEnv, clipTable, f32, num, table } from './base';
import { sampleCurve } from './curves';
import { ROTORS, delaySeconds, expMap, lfoHarmonics, reverbStep, reverbType, tremCurveFn } from './pedalMath';

/** Efeito estéreo: processa L e R no lugar; `set` recebe os botões (0..1). */
export abstract class StereoFx {
  readonly params: Param[] = [];
  env: RigEnv = { bpm: 120, song: null };
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
  protected buf() {
    return new Float64Array(this.B);
  }
  tick(k: number) {
    for (const p of this.params) p.tick(k);
  }
  abstract run(L: Float64Array, R: Float64Array, n: number): void;
  abstract set(p: number[], snap: boolean): void;
}

/** Valor do parâmetro na amostra i do bloco (interpolado entre o bloco anterior e o atual). */
const at = (p: Param, i: number, n: number) => p.prev + ((p.value - p.prev) * (i + 1)) / n;

/** Onda de LFO de um ciclo (como o PeriodicWave normalizado do app), deslocada de `phase` (0..1). */
function lfoTable(phase: number, triangle: boolean) {
  return table(`lfo:${phase}:${triangle}`, () => {
    const n = 4096, h = lfoHarmonics(triangle);
    const t = new Float32Array(n + 1);
    let peak = 0;
    for (let i = 0; i <= n; i++) {
      let v = 0;
      h.forEach((a, k) => (v += a * Math.sin(2 * Math.PI * (k + 1) * (i / n + phase))));
      t[i] = v;
      peak = Math.max(peak, Math.abs(v));
    }
    for (let i = 0; i <= n; i++) t[i] /= peak;
    return t;
  });
}
const lfoAt = (t: Float32Array, ph: number) => {
  const x = ph * (t.length - 1), i = x | 0, f = x - i;
  return t[i] + (t[i + 1] - t[i]) * f;
};

// ---------- Chorus ----------

/** Chorus de três vozes defasadas 120°, abertas no estéreo; Analógico (triangular, escuro) ou Digital. */
class Chorus extends StereoFx {
  private bases = [0.0072, 0.0094, 0.0118];
  private pans = [-1, 1, 0];
  // a entrada do chorus é sempre mono (é o primeiro pedal depois da caixa, que é mono)
  private lines = [new DelayLine(this.sr * 0.05)];
  private tones = [0, 1, 2].map(() => [this.bq('lowpass', 5500, 0.6)]);
  private phase = 0;
  private analog = true;
  private stereo = true;
  private rate = this.p(1);
  private amt = this.p(0.002);
  private wet = this.p(0.5);
  private out = this.p(1);
  private netG = this.p(0.5);
  private panG = [0, 1, 2].map(() => [this.p(1), this.p(0)]);
  run(L: Float64Array, R: Float64Array, n: number) {
    const sr = this.sr;
    const waves = [0, 1, 2].map((k) => lfoTable(k / 3, this.analog));
    for (let i = 0; i < n; i++) {
      const xl = L[i], xr = R[i];
      this.lines[0].write((xl + xr) / 2);
      const amt = at(this.amt, i, n), g = at(this.netG, i, n) * at(this.wet, i, n);
      let wl = 0, wr = 0;
      for (let k = 0; k < 3; k++) {
        const d = (this.bases[k] + amt * lfoAt(waves[k], this.phase)) * sr;
        // entrada mono (a caixa é mono): a voz é a mesma nos dois canais antes do pan
        const v = this.tones[k][0].tick(this.lines[0].read(d));
        const [pl, pr] = this.panG[k];
        wl += v * at(pl, i, n);
        wr += v * at(pr, i, n);
      }
      const o = at(this.out, i, n);
      L[i] = (xl + wl * g) * o;
      R[i] = (xr + wr * g) * o;
      // o oscilador do Web Audio vale sin(0) na 1ª amostra: a fase avança depois de usada
      this.phase += at(this.rate, i, n) / sr;
      if (this.phase >= 1) this.phase -= 1;
    }
  }
  set([rate, depth, mix, kind, side]: number[], snap: boolean) {
    const analog = num(kind, 0) < 0.5;
    if (analog !== this.analog) {
      this.analog = analog;
      for (const t of this.tones) for (const f of t) f.set('lowpass', analog ? 5500 : 16000, 0.6);
    }
    this.stereo = num(side, 1) >= 0.5;
    this.rate.set(expMap(num(rate, 0.3), 0.08, 6), snap);
    this.amt.set(0.0004 + num(depth, 0.5) * 0.0035, snap);
    const m = num(mix, 0.5);
    this.wet.set(m, snap);
    this.out.set(1 / (1 + m * 0.6), snap);
    // StereoPanner com entrada estéreo de lados iguais: no app o sinal já é estéreo aqui (o DynamicsCompressorNode
    // do pedal de compressor sempre sai com 2 canais, ligado ou não). Pan 0 passa inteiro; nas pontas, um lado
    // recebe os dois canais somados e o outro nada.
    this.panG.forEach(([pl, pr], k) => {
      const pan = this.stereo ? this.pans[k] : 0;
      const x = pan <= 0 ? pan + 1 : pan;
      const c = Math.cos((x * Math.PI) / 2), s = Math.sin((x * Math.PI) / 2);
      pl.set(pan <= 0 ? 1 + c : c, snap);
      pr.set(pan <= 0 ? s : 1 + s, snap);
    });
  }
}

// ---------- Phaser ----------

class Phaser extends StereoFx {
  private core = new PhaserCore(this.sr);
  private mono = this.buf();
  private wl = this.buf();
  private wr = this.buf();
  private rate = this.p(0.5);
  private depth = this.p(0.6);
  private fb = this.p(0);
  private stages = 4;
  private stereo = 1;
  private wet = this.p(0.5);
  private out = this.p(1);
  run(L: Float64Array, R: Float64Array, n: number) {
    for (let i = 0; i < n; i++) this.mono[i] = (L[i] + R[i]) / 2;
    this.core.process(this.mono, [this.wl, this.wr], n, f32(this.rate), f32(this.depth), f32(this.fb), this.stages, this.stereo);
    for (let i = 0; i < n; i++) {
      const w = at(this.wet, i, n), o = at(this.out, i, n);
      L[i] = (L[i] + this.wl[i] * w) * o;
      R[i] = (R[i] + this.wr[i] * w) * o;
    }
  }
  set([rate, depth, amt, fb, stages, side]: number[], snap: boolean) {
    this.rate.set(expMap(num(rate, 0.25), 0.05, 8), snap);
    this.depth.set(num(depth, 0.6), snap);
    const feedback = num(fb, 0.3) * 0.85;
    this.fb.set(feedback, snap);
    this.stages = num(stages, 0) >= 0.5 ? 8 : 4;
    this.stereo = num(side, 1) >= 0.5 ? 1 : 0;
    const m = num(amt, 0.6);
    this.wet.set(m * (1 - feedback * 0.7), snap);
    this.out.set(1 / (1 + m * 0.5), snap);
  }
}

// ---------- Flanger e vibrato ----------

/** Eco de 3 a ~11 ms varrido por um LFO; a realimentação (sem grave) reforça os picos do pente. */
class Flanger extends StereoFx {
  private lines = [new DelayLine(this.sr * 0.02), new DelayLine(this.sr * 0.02)];
  private dcs = [this.bq('highpass', 30), this.bq('highpass', 30)];
  private back = [new DelayLine(CYCLE + 2), new DelayLine(CYCLE + 2)];
  private phase = 0;
  private rate = this.p(0.5);
  private base = this.p(0.005);
  private depth = this.p(0.002);
  private fb = this.p(0.4);
  private out = this.p(0.75);
  run(L: Float64Array, R: Float64Array, n: number) {
    const sr = this.sr, chans = [L, R];
    for (let i = 0; i < n; i++) {
      const d = (at(this.base, i, n) + at(this.depth, i, n) * Math.sin(2 * Math.PI * this.phase)) * sr;
      this.phase += at(this.rate, i, n) / sr;
      if (this.phase >= 1) this.phase -= 1;
      const fb = at(this.fb, i, n), o = at(this.out, i, n);
      for (let c = 0; c < 2; c++) {
        const x = chans[c][i];
        const line = this.lines[c];
        // realimentação: a saída do atraso (sem grave) volta para a entrada dele (lida antes de gravar: d - 1)
        const y = line.read(d - 1);
        const back = this.back[c];
        const f = back.read(CYCLE - 1);
        back.write(this.dcs[c].tick(y));
        line.write(x + fb * f);
        chans[c][i] = (x + y * 0.8) * o;
      }
    }
  }
  set([rate, depth, regen]: number[], snap: boolean) {
    const sweep = 0.0005 + num(depth, 0.6) * 0.0035;
    this.rate.set(0.05 + num(rate, 0.25) * 2, snap);
    this.base.set(0.003 + sweep, snap);
    this.depth.set(sweep, snap);
    this.fb.set(num(regen, 0.5) * 0.85, snap);
    this.out.set(0.75 * (1 - num(regen, 0.5) * 0.3), snap);
  }
}

/** Vibrato: atraso varrido 100% molhado (a afinação sobe e desce). */
class Vibrato extends StereoFx {
  private lines = [new DelayLine(this.sr * 0.06), new DelayLine(this.sr * 0.06)];
  private phase = 0;
  private rate = this.p(2);
  private amp = this.p(0.001);
  run(L: Float64Array, R: Float64Array, n: number) {
    const sr = this.sr;
    for (let i = 0; i < n; i++) {
      const a = at(this.amp, i, n);
      const d = (0.001 + a + a * Math.sin(2 * Math.PI * this.phase)) * sr;
      this.phase += at(this.rate, i, n) / sr;
      if (this.phase >= 1) this.phase -= 1;
      this.lines[0].write(L[i]);
      this.lines[1].write(R[i]);
      L[i] = this.lines[0].read(d);
      R[i] = this.lines[1].read(d);
    }
  }
  set([rate, depth]: number[], snap: boolean) {
    const f = expMap(num(rate, 0.35), 0.5, 10);
    this.rate.set(f, snap);
    this.amp.set((num(depth, 0.35) * 0.06) / (2 * Math.PI * f), snap);
  }
}

// ---------- Rotary ----------

/** Caixa rotativa: saturação valvulada, divisor em 800 Hz, corneta e tambor girando com Doppler e volume. */
export class Rotary extends StereoFx {
  private mono = this.buf();
  private sat = new Shaper(clipTable('soft'), this.sr, true);
  private drive = this.p(1.6);
  private satOut = this.p(0.25);
  private dry = this.p(0);
  private wet = this.p(0.9);
  private rotors = (Object.keys(ROTORS) as (keyof typeof ROTORS)[]).map((name) => {
    const r = ROTORS[name];
    return {
      name,
      r,
      x: [this.bq(r.xover, 800), this.bq(r.xover, 800)],
      hornLp: name === 'horn' ? this.bq('lowpass', 6500) : null,
      level: this.p(1),
      freq: r.slow,
      target: r.slow,
      phase: 0,
      lines: [new DelayLine(this.sr * 0.01), new DelayLine(this.sr * 0.01)],
    };
  });
  private sine = lfoTable(0, false);
  private fast: boolean | null = null;
  private sig = this.buf();
  private outL = this.buf();
  private outR = this.buf();
  run(L: Float64Array, R: Float64Array, n: number) {
    const sr = this.sr;
    // pré: média dos canais (o divisor e os rotores do app terminam num ChannelMerger, que faz a média)
    for (let i = 0; i < n; i++) this.mono[i] = (L[i] + R[i]) / 2;
    applyGain(this.mono, n, this.drive);
    this.sat.run(this.mono, n);
    applyGain(this.mono, n, this.satOut);
    const outL = this.outL, outR = this.outR;
    outL.fill(0);
    outR.fill(0);
    for (const rt of this.rotors) {
      const s = this.sig;
      for (let i = 0; i < n; i++) s[i] = this.mono[i];
      rt.x[0].run(s, n);
      rt.x[1].run(s, n);
      applyGain(s, n, rt.level);
      rt.hornLp?.run(s, n);
      // a velocidade vai para o alvo com a inércia do rotor (setTargetAtTime)
      const k = 1 - Math.exp(-1 / (rt.r.tau * sr));
      for (let i = 0; i < n; i++) {
        const ph0 = rt.phase;
        rt.freq += (rt.target - rt.freq) * k;
        rt.phase += rt.freq / sr;
        if (rt.phase >= 1) rt.phase -= 1;
        for (let side = 0; side < 2; side++) {
          const ph = ph0 + side * rt.r.mics;
          const line = rt.lines[side];
          line.write(s[i]);
          const d = (0.002 + rt.r.doppler * lfoAt(this.sine, ph % 1)) * sr;
          const vca = 1 - rt.r.am / 2 + (rt.r.am / 2) * lfoAt(this.sine, (ph + 0.25) % 1);
          const y = line.read(d) * vca;
          if (side === 0) outL[i] += y;
          else outR[i] += y;
        }
      }
    }
    for (let i = 0; i < n; i++) {
      const dr = at(this.dry, i, n), w = at(this.wet, i, n);
      L[i] = L[i] * dr + outL[i] * w;
      R[i] = R[i] * dr + outR[i] * w;
    }
  }
  set([drv, bal, mix, knob]: number[], snap: boolean) {
    const dg = 0.4 + num(drv, 0.2) * 6;
    this.drive.set(dg, snap);
    this.satOut.set(1 / (dg * 2.5), snap);
    const b = num(bal, 0.5);
    for (const rt of this.rotors) rt.level.set(rt.name === 'horn' ? Math.min(1, 2 * b) : Math.min(1, 2 * (1 - b)), snap);
    const m = num(mix, 1);
    this.dry.set(1 - m, snap);
    this.wet.set(m * 0.9, snap);
    this.knobFast = num(knob, 0) >= 0.5;
    this.applySpeed();
  }
  private knobFast = false;
  private extFast: boolean | null = null;
  /** velocidade vinda da automação (null = a da chave Lento/Rápido) */
  external(fast: boolean | null) {
    if (fast === this.extFast) return;
    this.extFast = fast;
    this.applySpeed();
  }
  private applySpeed() {
    const want = this.extFast ?? this.knobFast;
    if (want === this.fast) return;
    const first = this.fast === null;
    this.fast = want;
    // troca de velocidade: os rotores vão para o alvo com a inércia de cada um
    for (const rt of this.rotors) {
      rt.target = want ? rt.r.fast : rt.r.slow;
      if (first) rt.freq = rt.target;
    }
  }
}

// ---------- Tremolo ----------

/** Tremolo clássico ou harmônico (graves e agudos alternados), mono ou estéreo (auto-pan). */
class Tremolo extends StereoFx {
  private phase = 0;
  private step = -1;
  private shape: Shaper | null = null;
  private lp = this.bq('lowpass', 650);
  private rate = this.p(5);
  private depth = this.p(0.25);
  private base = this.p(0.75);
  private classic = this.p(1);
  private harm = this.p(0);
  private polR = this.p(1);
  run(L: Float64Array, R: Float64Array, n: number) {
    const sr = this.sr;
    for (let i = 0; i < n; i++) {
      // os VCAs do app terminam num ChannelMerger: cada lado recebe a média dos canais da fonte
      const x = (L[i] + R[i]) / 2;
      const lfo = this.shape!.tick(Math.sin(2 * Math.PI * this.phase)) * at(this.depth, i, n);
      this.phase += at(this.rate, i, n) / sr;
      if (this.phase >= 1) this.phase -= 1;
      const base = at(this.base, i, n), pr = at(this.polR, i, n);
      const c = x * at(this.classic, i, n), h = x * at(this.harm, i, n);
      const lo = this.lp.tick(h), hi = h - lo;
      // agudos ao contrário dos graves; no estéreo o lado direito ao contrário do esquerdo
      L[i] = c * (base + lfo) + lo * (base + lfo) + hi * (base - lfo);
      R[i] = c * (base + pr * lfo) + lo * (base + pr * lfo) + hi * (base - pr * lfo);
    }
  }
  set([rate, dep, form, mode, side]: number[], snap: boolean) {
    const harmonic = num(mode, 0) >= 0.5;
    const stereo = num(side, 0) >= 0.5;
    const d = num(dep, 0.5);
    this.rate.set(1 + num(rate, 0.4) * 11, snap);
    const st = Math.round(num(form, 0.15) * 20);
    if (st !== this.step) {
      this.step = st;
      this.shape = new Shaper(table(`trem:${st}`, () => sampleCurve(tremCurveFn(st), 1024)), this.sr);
    }
    this.depth.set(d / 2, snap);
    this.base.set(1 - d / 2, snap);
    this.classic.set(harmonic ? 0 : 1, snap);
    this.harm.set(harmonic ? 1 : 0, snap);
    this.polR.set(stereo ? -1 : 1, snap);
  }
}

// ---------- Delay ----------

/**
 * O Web Audio põe um bloco de processamento (128 amostras) a mais em todo laço de realimentação com DelayNode
 * (medido: um eco de 200 amostras realimentado se repete a cada 328). Os laços daqui somam o mesmo atraso
 * no caminho de volta, para os ecos caírem nos mesmos lugares que no app.
 */
const CYCLE = 128;

/** Atraso que o WaveShaperNode 4x do app põe na fita (ver OS4_LATENCY em amp.ts): soma ao tempo de cada eco. */
const OS4_LATENCY = 192;

/** Uma linha de delay (delayNet em amp.ts): atraso → passa-altas → passa-baixas → [fita] → realimentação. */
class DelayLineFx {
  line: DelayLine;
  hp: Biquad;
  lp: Biquad;
  tape: Shaper | null;
  last = 0;
  /** caminho de volta do laço (+128 amostras, como no app) */
  back = new DelayLine(CYCLE + 2);
  /** grava o eco realimentado e devolve a amostra que volta agora para a entrada */
  feed(y: number) {
    const f = this.back.read(CYCLE - 1);
    this.back.write(y);
    return f;
  }
  constructor(sr: number, tape: boolean) {
    this.line = new DelayLine(sr * 2.6 + OS4_LATENCY);
    this.hp = new Biquad(sr, 'highpass', tape ? 140 : 20);
    this.lp = new Biquad(sr, 'lowpass', tape ? 2600 : 12000);
    this.tape = tape ? new Shaper(clipTable('tape'), sr, true) : null;
  }
  /** saída do eco de `d` amostras atrás (chamada antes de gravar a entrada desta amostra) */
  tickOut(d: number) {
    let y = this.lp.tick(this.hp.tick(this.line.read(d - 1)));
    if (this.tape) {
      const b = DelayLineFx.one;
      b[0] = y;
      this.tape.run(b, 1);
      y = b[0];
    }
    this.last = y;
    return y;
  }
  static one = new Float64Array(1);
}

class Delay extends StereoFx {
  private nets: { key: string; lines: DelayLineFx[]; tape: boolean; stereo: boolean; reverse: boolean; rev?: ReverseCore[]; revTone?: Biquad[]; revTape?: Shaper[]; revDelay?: DelayLine } | null = null;
  private mix = this.p(0.3);
  private time = this.p(0.4);
  private fb = this.p(0.3);
  private mod = this.p(0);
  private wow = this.p(0.002);
  private ph = [0, 0, 0];
  private mono = this.buf();
  private revOut = this.buf();
  run(L: Float64Array, R: Float64Array, n: number) {
    const net = this.nets;
    if (!net) return;
    const sr = this.sr;
    if (net.reverse) return this.runReverse(L, R, n);
    for (let i = 0; i < n; i++) {
      const mod = at(this.mod, i, n) * 0.0025 * Math.sin(2 * Math.PI * this.ph[0]);
      const tapeMod = net.tape
        ? at(this.wow, i, n) * Math.sin(2 * Math.PI * this.ph[1]) + 0.00015 * Math.sin(2 * Math.PI * this.ph[2])
        : 0;
      this.ph[0] = (this.ph[0] + 0.7 / sr) % 1;
      this.ph[1] = (this.ph[1] + 0.5 / sr) % 1;
      this.ph[2] = (this.ph[2] + 6.2 / sr) % 1;
      const t = at(this.time, i, n), fb = at(this.fb, i, n), m = at(this.mix, i, n);
      const lat = net.tape ? OS4_LATENCY : 0;
      if (net.stereo) {
        // ping-pong: a entrada vai para a esquerda; cada lado realimenta o outro
        const [A, Bl] = net.lines;
        const x = (L[i] + R[i]) / 2;
        const ya = A.tickOut((t + mod + tapeMod) * sr + lat);
        const yb = Bl.tickOut((t - mod + tapeMod) * sr + lat);
        // no app o laço se fecha na passagem esquerda → direita: é ela que leva o bloco a mais
        A.line.write(x + fb * yb);
        Bl.line.write(fb * Bl.feed(ya));
        L[i] += ya * m;
        R[i] += yb * m;
      } else {
        const d = (t + mod + tapeMod) * sr + lat;
        const chans = [L, R];
        for (let c = 0; c < 2; c++) {
          const ln = net.lines[c];
          const y = ln.tickOut(d);
          ln.line.write(chans[c][i] + fb * ln.feed(y));
          chans[c][i] += y * m;
        }
      }
    }
  }
  private runReverse(L: Float64Array, R: Float64Array, n: number) {
    const net = this.nets!;
    for (let i = 0; i < n; i++) this.mono[i] = (L[i] + R[i]) / 2;
    net.rev![0].process(this.mono, [this.revOut], n, Math.fround(Math.min(3, Math.max(0.15, this.time.value))), f32(this.fb));
    const o = this.revOut;
    if (net.tape) {
      net.revTone![0].run(o, n);
      net.revTape![0].run(o, n);
    }
    for (let i = 0; i < n; i++) {
      const m = at(this.mix, i, n);
      let r = o[i];
      if (net.stereo) {
        // abre o eco: esquerda direto, direita 12 ms depois
        net.revDelay!.write(o[i]);
        r = net.revDelay!.read(0.012 * this.sr);
      }
      L[i] += o[i] * m;
      R[i] += r * m;
    }
  }
  set([time, rep, mix, mod, kind, side, dir, sync]: number[], snap: boolean) {
    const tape = num(kind, 0) < 0.5;
    const stereo = num(side, 0) >= 0.5;
    const reverse = num(dir, 0) >= 0.5;
    const key = `${tape}|${stereo}|${reverse}`;
    if (key !== this.nets?.key) {
      this.nets = reverse
        ? {
            key, tape, stereo, reverse, lines: [],
            rev: [new ReverseCore(this.sr)],
            revTone: [this.bq('lowpass', 3200)],
            revTape: [new Shaper(clipTable('tape'), this.sr, true)],
            revDelay: new DelayLine(this.sr * 0.05),
          }
        : { key, tape, stereo, reverse, lines: [new DelayLineFx(this.sr, tape), new DelayLineFx(this.sr, tape)] };
    }
    const r = num(rep, 0.35);
    const seconds = delaySeconds(num(time, 0.35), num(sync, 0) >= 0.5, reverse, this.env.bpm);
    this.mix.set(num(mix, 0.3), snap);
    this.time.set(seconds, snap);
    this.fb.set(reverse ? r * 0.85 : r * (tape ? 0.95 : 0.85), snap);
    this.mod.set(num(mod, 0), snap);
    this.wow.set(0.0012 + seconds * 0.002, snap);
  }
}

// ---------- Reverb ----------

/** Pitch shifter de linha de atraso (pitchPedal em amp.ts), usado no laço do shimmer: +1 oitava, só o transposto. */
class OctaveUpShifter {
  private line: DelayLine;
  private phase = 0;
  private tone: Biquad;
  private W = 0.05;
  constructor(private sr: number) {
    this.line = new DelayLine(sr * 0.13);
    this.tone = new Biquad(sr, 'lowpass', 7000);
  }
  tick(x: number) {
    const sr = this.sr, W = this.W;
    this.line.write(x);
    // razão 2: o atraso encolhe 1 s por segundo; cada voz percorre a janela W e salta de volta
    this.phase = (this.phase + 1 / (W * sr)) % 1;
    let y = 0;
    for (const off of [0, 0.5]) {
      const p = (this.phase + off) % 1;
      const d = (0.002 + W - W * p) * sr;
      y += Math.sin(Math.PI * p) ** 2 * this.line.read(d);
    }
    return this.tone.tick(y);
  }
}

/** IR do reverb já na taxa da placa, enviada pela interface (a geração fica no app: reverbIR em amp.ts). */
export interface ReverbIr {
  key: string;
  l: Float32Array;
  r: Float32Array;
}

/**
 * Reverb: as IRs do app (mola, placa, hall, sala) por convolução longa, com crossfade de 80 ms ao trocar
 * de tipo/tempo. Shimmer: a cauda passa por um pitch shifter (+1 oitava) e volta para a entrada.
 */
class Reverb extends StereoFx {
  private hp = [this.bq('highpass', 120), this.bq('highpass', 120)];
  private tone = [this.vb('lowpass', 5000), this.vb('lowpass', 5000)];
  private wet = this.p(0.4);
  private loopG = this.p(0);
  private cur: { key: string; conv: LongConvolver[] } | null = null;
  private old: { key: string; conv: LongConvolver[] } | null = null;
  private fade = 0;
  private fadeLen = Math.round(0.08 * this.sr);
  private building: { cancel(): void } | null = null;
  private want = '';
  private inBuf = [this.buf(), this.buf()];
  private wetBuf = [this.buf(), this.buf()];
  private oldBuf = [this.buf(), this.buf()];
  // laço do shimmer: oitava acima → filtros → saturação suave → 80 ms → entrada do reverb
  private shift = [new OctaveUpShifter(this.sr), new OctaveUpShifter(this.sr)];
  private loopF = [0, 1].map(() => [this.bq('highpass', 400), this.bq('lowpass', 7000)]);
  private loopSat = [new Shaper(clipTable('tape'), this.sr, true), new Shaper(clipTable('tape'), this.sr, true)];
  private loopLine = [new DelayLine(this.sr * 0.1 + OS4_LATENCY + CYCLE), new DelayLine(this.sr * 0.1 + OS4_LATENCY + CYCLE)];
  private one = new Float64Array(1);
  private pending = '';
  /** chave da IR que os botões pedem (a interface manda a IR com essa chave) */
  get irKey() {
    return this.want;
  }
  /** IR em uso ou sendo montada */
  get loadedKey() {
    return this.pending || this.cur?.key || '';
  }
  setIr(ir: ReverbIr, schedule: BuildScheduler) {
    if (ir.key !== this.want) return;
    this.building?.cancel();
    // monta as duas convoluções aos poucos, sem travar o áudio; quando prontas, entra com crossfade
    const B = this.B;
    function* both() {
      const l = yield* LongConvolver.build(ir.l, B);
      const r = yield* LongConvolver.build(ir.r, B);
      return [l, r];
    }
    this.pending = ir.key;
    this.building = schedule(both(), (conv) => {
      this.building = null;
      this.pending = '';
      this.old = this.cur;
      this.cur = { key: ir.key, conv };
      this.fade = this.old ? this.fadeLen : 0;
    });
  }
  /** Monta na hora (testes). */
  setIrNow(ir: ReverbIr) {
    this.want = ir.key;
    this.cur = { key: ir.key, conv: [LongConvolver.now(ir.l, this.B), LongConvolver.now(ir.r, this.B)] };
  }
  run(L: Float64Array, R: Float64Array, n: number) {
    if (!this.cur) return;
    const chans = [L, R];
    const sr = this.sr;
    for (let c = 0; c < 2; c++) {
      const inp = this.inBuf[c];
      const lg = this.loopG.value;
      // o laço volta 80 ms depois (+ o atraso da saturação e do ciclo, como no app); as amostras deste bloco
      // ainda não foram gravadas, então a amostra i lê D - 1 - i atrás da última gravada
      const D = 0.08 * sr + OS4_LATENCY + CYCLE;
      for (let i = 0; i < n; i++) inp[i] = chans[c][i] + (lg > 0 || this.loopG.prev > 0 ? this.loopLine[c].read(D - 1 - i) : 0);
      this.hp[c].run(inp, n);
      const w = this.wetBuf[c];
      w.fill(0);
      this.cur.conv[c].run(inp, w, n);
      if (this.fade > 0 && this.old) {
        const o = this.oldBuf[c];
        o.fill(0);
        this.old.conv[c].run(inp, o, n);
        for (let i = 0; i < n; i++) {
          const m = Math.max(0, this.fade - i) / this.fadeLen;
          w[i] = w[i] * (1 - m) + o[i] * m;
        }
      }
      // laço do shimmer (só quando ligado: sem ele o caminho não muda o som)
      if (lg > 0 || this.loopG.prev > 0) {
        for (let i = 0; i < n; i++) {
          let v = this.shift[c].tick(w[i]);
          v = this.loopF[c][1].tick(this.loopF[c][0].tick(v)) * at(this.loopG, i, n);
          this.one[0] = v;
          this.loopSat[c].run(this.one, 1);
          this.loopLine[c].write(this.one[0]);
        }
      }
      this.tone[c].run(w, n);
      const ch = chans[c];
      for (let i = 0; i < n; i++) ch[i] += w[i] * at(this.wet, i, n);
    }
    if (this.fade > 0) {
      this.fade = Math.max(0, this.fade - n);
      if (!this.fade) this.old = null;
    }
  }
  set([time, t, mix, kind]: number[], snap: boolean) {
    this.tone[0].f.set(expMap(num(t, 0.5), 1500, 9000), snap);
    this.tone[1].f.set(expMap(num(t, 0.5), 1500, 9000), snap);
    this.wet.set(num(mix, 0.35) * 1.2, snap);
    const type = reverbTypeId(num(kind, 0));
    this.loopG.set(type === 'shimmer' ? 0.32 : 0, snap);
    this.want = `${this.sr}|${type}|${reverbStep(num(time, 0.4))}`;
  }
}

const reverbTypeId = (v: number) => (['spring', 'plate', 'shimmer', 'hall', 'room'] as const)[reverbType(v)];

export function makePostFx(id: string, sr: number, B: number): StereoFx | null {
  switch (id) {
    case 'chorus': return new Chorus(sr, B);
    case 'phaser': return new Phaser(sr, B);
    case 'flanger': return new Flanger(sr, B);
    case 'vibrato': return new Vibrato(sr, B);
    case 'rotary': return new Rotary(sr, B);
    case 'tremolo': return new Tremolo(sr, B);
    case 'delay': return new Delay(sr, B);
    case 'reverb': return new Reverb(sr, B);
    default: return null;
  }
}

export { Reverb };
