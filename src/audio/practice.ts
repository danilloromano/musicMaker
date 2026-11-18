// Tirar música: um tocador à parte do projeto para estudar uma gravação — mais devagar sem mudar o tom,
// em outro tom sem mudar a velocidade, repetindo um trecho (A–B) — e um palpite do acorde que está soando.
//
// Velocidade e tom saem de um único esticamento (WSOLA, no worker): o áudio é esticado por tom ÷ velocidade
// e tocado com playbackRate = tom (tocar mais rápido sobe a altura e encurta de volta). Cada combinação
// processada fica guardada (as últimas 4), então voltar para uma velocidade já usada é instantâneo.
import { useSyncExternalStore } from 'react';
import { guessChord, chordName } from './chords';
import { engine } from './engine';
import { stretchBuffer } from './tempo';
import type { Stems } from './separate';
import { newTrack, useStore } from '../store';
import { uid } from '../types';
import { saveBufferLocal } from './persist';

/** Volume de cada parte separada (0..1). */
export interface StemMix {
  voz: number;
  bateria: number;
  baixo: number;
  resto: number;
}
export const STEM_NAMES: [keyof StemMix, string][] = [['voz', 'Voz'], ['bateria', 'Bateria'], ['baixo', 'Baixo'], ['resto', 'Resto (guitarras, teclados…)']];
const FULL_MIX: StemMix = { voz: 1, bateria: 1, baixo: 1, resto: 1 };

type Proc = { buf: AudioBuffer; stretch: number; rate: number };

export interface PracticeState {
  name: string | null;
  duration: number;
  playing: boolean;
  /** processando uma nova velocidade/tom */
  busy: boolean;
  speed: number; // 0.25..1.5
  semis: number; // -12..12
  cents: number; // -50..50
  volume: number;
  loop: { a: number; b: number; on: boolean } | null;
  peaks: Float32Array | null;
  /** separação: null = não separada; número = processando (0..1); true = pronta */
  separated: null | number | true;
  mix: StemMix;
}

class Practice {
  /** a música como foi aberta */
  source: AudioBuffer | null = null;
  /** o que toca: a música, ou a mistura das partes separadas */
  orig: AudioBuffer | null = null;
  stems: Stems | null = null;
  state: PracticeState = {
    name: null, duration: 0, playing: false, busy: false, speed: 1, semis: 0, cents: 0, volume: 0.9, loop: null, peaks: null,
    separated: null, mix: FULL_MIX,
  };
  private cache = new Map<string, Proc>();
  private proc: Proc | null = null;
  private src: AudioBufferSourceNode | null = null;
  private out: GainNode | null = null;
  analyser: AnalyserNode | null = null;
  private t0 = 0; // relógio do contexto quando começou a tocar
  private pos0 = 0; // posição (s, na música original) quando começou a tocar
  private job = 0;
  private listeners = new Set<() => void>();

  subscribe = (f: () => void) => {
    this.listeners.add(f);
    return () => this.listeners.delete(f);
  };
  private set(patch: Partial<PracticeState>) {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((f) => f());
  }

  private get ctx() {
    engine.ensure();
    return engine.ctx;
  }

  private outNode() {
    if (!this.out) {
      const ctx = this.ctx;
      this.out = ctx.createGain();
      this.analyser = ctx.createAnalyser();
      this.analyser.fftSize = 8192;
      this.analyser.smoothingTimeConstant = 0.6;
      this.out.connect(this.analyser);
      this.out.connect(ctx.destination);
    }
    this.out.gain.value = this.state.volume;
    return this.out;
  }

  /** Abre uma música (qualquer áudio que o navegador decodifique). */
  async load(file: File) {
    this.stop();
    const buf = await this.ctx.decodeAudioData(await file.arrayBuffer());
    this.source = buf;
    this.orig = buf;
    this.stems = null;
    this.cache.clear();
    this.proc = { buf, stretch: 1, rate: 1 };
    this.playSpeed = 1;
    this.pos0 = 0;
    this.set({ name: file.name.replace(/\.[^.]+$/, ''), duration: buf.duration, loop: null, peaks: peaksOf(buf, 2400), speed: 1, semis: 0, cents: 0, separated: null, mix: FULL_MIX });
  }

  // ---------- separação (sem IA, ver separate.ts) ----------

  /** Separa voz, bateria, baixo e o resto (num worker, com progresso no estado). */
  async separate() {
    const src = this.source;
    if (!src || this.state.separated !== null) return;
    this.set({ separated: 0 });
    const L = src.getChannelData(0).slice();
    const R = (src.numberOfChannels > 1 ? src.getChannelData(1) : src.getChannelData(0)).slice();
    try {
      const stems = await new Promise<Stems>((resolve, reject) => {
        const w = new Worker(new URL('./separate.worker.ts', import.meta.url), { type: 'module' });
        w.onmessage = (e: MessageEvent<{ progress?: number; stems?: Stems }>) => {
          if (e.data.stems) {
            resolve(e.data.stems);
            w.terminate();
          } else if (e.data.progress !== undefined) this.set({ separated: e.data.progress });
        };
        w.onerror = (e) => {
          reject(e);
          w.terminate();
        };
        w.postMessage({ L, R, sampleRate: src.sampleRate }, [L.buffer, R.buffer]);
      });
      if (this.source !== src) return; // abriram outra música no meio
      this.stems = stems;
      this.set({ separated: true });
    } catch (e) {
      this.set({ separated: null });
      throw e;
    }
  }

  /** Muda o volume das partes: refaz a mistura e continua do mesmo ponto (na velocidade e tom atuais). */
  setMix(patch: Partial<StemMix>) {
    const mix = { ...this.state.mix, ...patch };
    this.set({ mix });
    const src = this.source;
    if (!src || !this.stems) return;
    this.orig = mixStems(src, this.stems, mix);
    this.cache.clear();
    this.setParams({});
  }

  /**
   * Leva as partes separadas para o projeto: uma trilha de áudio para cada (do começo da música). Elas não
   * seguem o BPM do projeto (o andamento da gravação é outro).
   */
  sendToProject(): number {
    const src = this.source, st = this.stems;
    if (!src || !st) return 0;
    const sr = src.sampleRate;
    const mono = (d: Float32Array) => {
      const b = new AudioBuffer({ length: d.length, numberOfChannels: 1, sampleRate: sr });
      b.getChannelData(0).set(d);
      return b;
    };
    const drums = new AudioBuffer({ length: src.length, numberOfChannels: 2, sampleRate: sr });
    drums.getChannelData(0).set(st.drumsL);
    drums.getChannelData(1).set(st.drumsR);
    const rest = mixStems(src, st, { voz: 0, bateria: 0, baixo: 0, resto: 1 });
    const parts: [string, AudioBuffer][] = [['Voz (separada)', mono(st.vocals)], ['Bateria (separada)', drums], ['Baixo (separado)', mono(st.bass)], ['Resto (separado)', rest]];
    const s = useStore.getState();
    s.update((p) => {
      const tracks = [...p.tracks];
      const regions = [...p.regions];
      for (const [name, buf] of parts) {
        const t = newTrack('audio', tracks.length, { name: `${name.split(' (')[0]} — ${this.state.name}` });
        tracks.push(t);
        const bufferId = uid();
        engine.buffers.set(bufferId, buf);
        void saveBufferLocal(bufferId, buf);
        regions.push({ id: uid(), trackId: t.id, name, start: 0, length: 0, bufferId, offset: 0, duration: buf.duration, fixedTempo: true });
      }
      return { ...p, tracks, regions };
    });
    return parts.length;
  }

  /** Posição atual (segundos na música original). */
  /** velocidade do áudio que está tocando agora (a nova só vale depois de processada) */
  private playSpeed = 1;

  position(): number {
    if (!this.state.playing) return this.pos0;
    const p = this.pos0 + (this.ctx.currentTime - this.t0) * this.playSpeed;
    const l = this.state.loop;
    if (l?.on && this.pos0 < l.b && p >= l.b) return l.a + ((p - l.b) % (l.b - l.a));
    return Math.min(p, this.state.duration);
  }

  play() {
    if (!this.orig || !this.proc) return;
    engine.stop(); // o projeto para: um de cada vez
    this.startAt(this.pos0 >= this.state.duration - 0.05 ? 0 : this.pos0);
  }

  private startAt(pos: number) {
    this.src?.stop();
    const ctx = this.ctx;
    const l = this.state.loop;
    if (l?.on && (pos < l.a || pos >= l.b)) pos = l.a; // com o loop ligado, toca dentro do trecho
    const { buf, stretch, rate } = this.proc!;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = rate;
    if (l?.on) {
      src.loop = true;
      src.loopStart = l.a * stretch;
      src.loopEnd = l.b * stretch;
    }
    src.connect(this.outNode());
    this.t0 = ctx.currentTime + 0.02;
    this.pos0 = pos;
    src.start(this.t0, pos * stretch);
    src.onended = () => {
      if (this.src === src) {
        this.src = null;
        this.pos0 = this.state.duration;
        this.set({ playing: false });
      }
    };
    this.src = src;
    this.set({ playing: true });
  }

  pause() {
    if (!this.state.playing) return;
    this.pos0 = this.position();
    this.stop();
  }

  private stop() {
    const s = this.src;
    this.src = null;
    s?.stop();
    this.set({ playing: false });
  }

  toggle() {
    if (this.state.playing) this.pause();
    else this.play();
  }

  seek(t: number) {
    const pos = Math.max(0, Math.min(this.state.duration, t));
    if (this.state.playing) this.startAt(pos);
    else this.pos0 = pos;
    this.listeners.forEach((f) => f());
  }

  setVolume(v: number) {
    this.set({ volume: v });
    if (this.out) this.out.gain.setTargetAtTime(v, this.ctx.currentTime, 0.02);
  }

  setLoop(loop: PracticeState['loop']) {
    const l = loop && loop.b - loop.a >= 0.1 ? loop : null;
    this.set({ loop: l });
    if (this.state.playing) this.startAt(this.position());
  }

  private timer = 0;

  /**
   * Muda velocidade e/ou tom: processa (no worker) e troca no mesmo ponto da música. Arrastando o controle,
   * só processa quando ele para (250 ms).
   */
  setParams(p: { speed?: number; semis?: number; cents?: number }) {
    this.set({ speed: p.speed ?? this.state.speed, semis: p.semis ?? this.state.semis, cents: p.cents ?? this.state.cents });
    clearTimeout(this.timer);
    this.set({ busy: true });
    this.timer = window.setTimeout(() => void this.apply(), 250);
  }

  private async apply() {
    const { speed, semis, cents } = this.state;
    if (!this.orig) return this.set({ busy: false });
    const rate = 2 ** ((semis + cents / 100) / 12);
    const stretch = rate / speed;
    const key = `${stretch.toFixed(5)}|${rate.toFixed(5)}`;
    let proc = this.cache.get(key);
    if (!proc) {
      const id = ++this.job;
      this.set({ busy: true });
      const buf = Math.abs(stretch - 1) < 1e-4 ? this.orig : await stretchBuffer(this.orig, stretch);
      if (id !== this.job) return; // já pediram outra
      proc = { buf, stretch, rate };
      this.cache.set(key, proc);
      while (this.cache.size > 4) this.cache.delete(this.cache.keys().next().value!);
    }
    this.set({ busy: false });
    // a velocidade antiga ainda estava tocando: a posição conta com ela até a troca
    const pos = this.position();
    this.proc = proc;
    this.playSpeed = proc.rate / proc.stretch;
    if (this.state.playing) this.startAt(pos);
    else this.pos0 = pos;
  }

  // ---------- palpite de acorde ----------
  private chroma = new Float32Array(12);
  private fft: Float32Array<ArrayBuffer> | null = null;

  /** O acorde que mais combina com o que está soando agora (ou null em silêncio). */
  chordNow(): string | null {
    const an = this.analyser;
    if (!an || !this.state.playing) return null;
    if (!this.fft || this.fft.length !== an.frequencyBinCount) this.fft = new Float32Array(an.frequencyBinCount);
    an.getFloatFrequencyData(this.fft);
    const sr = an.context.sampleRate;
    const binHz = sr / an.fftSize;
    const now = new Float32Array(12);
    let bassPc: number | null = null, bassMag = 0, total = 0;
    for (let i = Math.floor(55 / binHz); i < Math.min(this.fft.length, Math.ceil(1800 / binHz)); i++) {
      const mag = 10 ** (this.fft[i] / 20);
      if (!Number.isFinite(mag)) continue;
      const f = i * binHz;
      const pc = ((Math.round(12 * Math.log2(f / 440)) % 12) + 12 + 9) % 12;
      now[pc] += mag * mag;
      total += mag * mag;
      if (f < 220 && mag > bassMag) {
        bassMag = mag;
        bassPc = pc;
      }
    }
    if (total < 1e-7) return null;
    // média curta: o acorde anterior sai rápido (com média longa, uma troca virava "C6", "Bm7(b5)"…)
    for (let k = 0; k < 12; k++) this.chroma[k] = this.chroma[k] * 0.5 + (now[k] / total) * 0.5;
    // só as notas mais fortes contam (o resto é harmônico e ruído)
    const max = Math.max(...this.chroma);
    const w = Array.from(this.chroma, (v) => (v > max * 0.2 ? v : 0));
    const c = guessChord(w, bassPc);
    return c ? chordName(c) : null;
  }
}

/**
 * Mistura das partes: resto·original + Σ (parte − resto)·parte — o "resto" é o original menos as três
 * partes, então com tudo em 100% sai exatamente a música original.
 */
function mixStems(src: AudioBuffer, st: Stems, m: StemMix): AudioBuffer {
  const out = new AudioBuffer({ length: src.length, numberOfChannels: 2, sampleRate: src.sampleRate });
  const gD = m.bateria - m.resto, gB = m.baixo - m.resto, gV = m.voz - m.resto;
  for (let c = 0; c < 2; c++) {
    const x = src.getChannelData(Math.min(c, src.numberOfChannels - 1));
    const d = c ? st.drumsR : st.drumsL;
    const o = out.getChannelData(c);
    for (let i = 0; i < o.length; i++) o[i] = m.resto * x[i] + gD * d[i] + gB * st.bass[i] + gV * st.vocals[i];
  }
  return out;
}

/** Picos para o desenho da forma de onda (máximo absoluto por coluna). */
function peaksOf(b: AudioBuffer, cols: number): Float32Array {
  const out = new Float32Array(cols);
  const per = Math.max(1, Math.floor(b.length / cols));
  for (let c = 0; c < b.numberOfChannels; c++) {
    const d = b.getChannelData(c);
    for (let x = 0; x < cols; x++) {
      let m = 0;
      const end = Math.min(d.length, (x + 1) * per);
      for (let i = x * per; i < end; i += 4) m = Math.max(m, Math.abs(d[i]));
      out[x] = Math.max(out[x], m);
    }
  }
  return out;
}

export const practice = new Practice();

/** Estado do tocador para componentes React. */
export const usePractice = () => useSyncExternalStore(practice.subscribe, () => practice.state);
