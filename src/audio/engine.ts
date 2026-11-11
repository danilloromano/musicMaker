import { useStore } from '../store';
import { BEATS_PER_BAR, Note, Project, Region, projectEnd, regionGainAt, uid } from '../types';
import { PRESETS, Voice, playDrum, startVoice, triggerNote } from './instruments';
import { Mixer } from './mixer';
import { saveBufferLocal } from './persist';
import { Recorder } from './recorder';

const LOOKAHEAD = 0.12; // s de antecedência com que as notas são agendadas
const TICK_MS = 25;

class Engine {
  ctx!: AudioContext;
  mixer!: Mixer;
  ready = false;
  buffers = new Map<string, AudioBuffer>();

  private playing = false;
  private position = 0; // em tempos, quando parado
  private startTime = 0;
  private startBeat = 0;
  private scheduledUntil = 0;
  private timer = 0;
  private bpm = 120;
  private sources: AudioBufferSourceNode[] = [];
  private live = new Map<string, Voice>();
  private preview: GainNode | null = null;

  private recorder: Recorder | null = null;
  private recNotes: Note[] = [];
  private recHeld = new Map<number, { start: number; vel: number }>();

  /** Cria o contexto de áudio na primeira interação do usuário. */
  ensure() {
    if (!this.ready) {
      this.ctx = new AudioContext({ latencyHint: 'interactive' });
      this.mixer = new Mixer(this.ctx, this.ctx.destination);
      const p = useStore.getState().project;
      this.bpm = p.bpm;
      this.mixer.sync(p.tracks, p.bpm);

      // entrada de áudio: tudo que chega da placa passa por inputBus (mono)
      this.inputBus = this.ctx.createGain();
      this.inputAnalyser = this.ctx.createAnalyser();
      this.inputAnalyser.fftSize = 1024;
      this.monitorGain = this.ctx.createGain();
      this.inputBus.connect(this.inputAnalyser);
      this.inputBus.connect(this.monitorGain);

      useStore.subscribe((s, prev) => {
        const a = s.project, b = prev.project;
        if (a.bpm !== b.bpm) this.retime(a.bpm);
        if (a.tracks !== b.tracks || a.bpm !== b.bpm) this.mixer.sync(a.tracks, a.bpm);
        this.routeMonitor();
      });
      this.ready = true;
    }
    if (this.ctx.state === 'suspended') void this.ctx.resume();
  }

  private retime(bpm: number) {
    if (this.playing) {
      const now = this.ctx.currentTime;
      this.startBeat += ((now - this.startTime) * this.bpm) / 60;
      this.startTime = now;
    }
    this.bpm = bpm;
  }

  getBeat(): number {
    if (!this.playing) return this.position;
    const now = this.ctx.currentTime;
    // volta do loop já agendada mas ainda não alcançada: continua no trecho anterior
    const seg = this.prevSeg && now < this.startTime ? this.prevSeg : { t: this.startTime, b: this.startBeat };
    return Math.max(0, seg.b + ((now - seg.t) * this.bpm) / 60);
  }

  private timeAt(beat: number) {
    return this.startTime + ((beat - this.startBeat) * 60) / this.bpm;
  }

  /** Trecho de reprodução anterior à última volta do loop (até a volta acontecer de fato). */
  private prevSeg: { t: number; b: number } | null = null;

  /** Começa a tocar do cursor. `delay` = segundos até o início (a contagem antes de gravar usa um compasso). */
  play(delay = 0.06) {
    this.ensure();
    if (this.playing) return;
    this.stopPreview();
    this.startBeat = this.position;
    this.startTime = this.ctx.currentTime + delay;
    this.prevSeg = null;
    this.scheduledUntil = this.startBeat;
    this.playing = true;
    this.startAudioRegions(this.startTime);
    this.timer = window.setInterval(() => this.tick(), TICK_MS);
    this.tick();
    useStore.getState().set({ playing: true });
  }

  stop() {
    if (useStore.getState().recording) this.finishRecording();
    if (!this.playing) return;
    this.position = this.getBeat();
    this.playing = false;
    clearInterval(this.timer);
    for (const s of this.sources) {
      try {
        s.stop();
      } catch {
        /* já terminou */
      }
    }
    this.sources = [];
    useStore.getState().set({ playing: false });
  }

  toggle() {
    if (this.playing) this.stop();
    else this.play();
  }

  seek(beat: number) {
    if (useStore.getState().recording) return;
    const was = this.playing;
    if (was) this.stop();
    this.position = Math.max(0, beat);
    if (was) this.play();
  }

  /** Agenda as regiões de áudio a partir do instante `ref` (o início da reprodução ou de uma volta do loop). */
  private startAudioRegions(ref: number) {
    const { project } = useStore.getState();
    for (const r of project.regions) {
      const buf = r.bufferId && this.buffers.get(r.bufferId);
      const strip = this.mixer.strips.get(r.trackId);
      if (!buf || !strip) continue;
      const at = this.timeAt(r.start);
      const late = Math.max(0, ref - at);
      const src = playAudioRegion(this.ctx, strip.input, r, buf, Math.max(at, ref), late);
      if (src) this.sources.push(src);
    }
  }

  /** Loop ativo para a reprodução atual (não vale durante a gravação nem se a música começou depois do trecho). */
  private activeLoop() {
    const s = useStore.getState();
    const l = s.project.loop;
    if (!l?.on || s.recording || l.end - l.start < 0.25 || this.startBeat >= l.end) return null;
    return l;
  }

  private tick() {
    let loop = this.activeLoop();
    let until = this.startBeat + ((this.ctx.currentTime + LOOKAHEAD - this.startTime) * this.bpm) / 60;
    // agenda até o fim do trecho e já emenda a próxima volta, sem buraco no som
    for (let guard = 0; loop && until >= loop.end && guard < 8; guard++) {
      this.schedule(this.scheduledUntil, loop.end);
      const wrap = Math.max(this.timeAt(loop.end), this.ctx.currentTime + 0.02);
      for (const s of this.sources) {
        try {
          s.stop(wrap);
        } catch {
          /* já terminou */
        }
      }
      this.sources = [];
      this.prevSeg = { t: this.startTime, b: this.startBeat };
      this.startTime = wrap;
      this.startBeat = loop.start;
      this.scheduledUntil = loop.start;
      this.startAudioRegions(wrap);
      until = this.startBeat + ((this.ctx.currentTime + LOOKAHEAD - this.startTime) * this.bpm) / 60;
      loop = this.activeLoop();
    }
    this.schedule(this.scheduledUntil, until);
  }

  /** Agenda notas e cliques do metrônomo no intervalo [from, until) em tempos. */
  private schedule(from: number, until: number) {
    if (until <= from) return;
    const { project } = useStore.getState();
    const spb = 60 / this.bpm;
    const tracks = new Map(project.tracks.map((t) => [t.id, t]));

    for (const r of project.regions) {
      if (!r.notes || r.start >= until || r.start + r.length <= from) continue;
      const track = tracks.get(r.trackId);
      const strip = this.mixer.strips.get(r.trackId);
      if (!track || !strip) continue;
      for (const n of r.notes) {
        const abs = r.start + n.start;
        if (abs < from || abs >= until || n.start >= r.length) continue;
        const dur = Math.min(n.duration, r.length - n.start) * spb;
        triggerNote(this.ctx, strip.input, track.kind, track.instrument, n.pitch, this.timeAt(abs), dur, n.velocity);
      }
    }

    if (project.metronome) {
      for (let b = Math.ceil(from - 1e-9); b < until; b++) this.click(this.timeAt(b), b % BEATS_PER_BAR === 0);
    }
    this.scheduledUntil = until;
  }

  private click(t: number, accent: boolean) {
    const osc = this.ctx.createOscillator();
    osc.frequency.value = accent ? 1600 : 1000;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.25, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.05);
    osc.connect(g).connect(this.ctx.destination);
    osc.start(t);
    osc.stop(t + 0.06);
  }

  // ---------- Tocar ao vivo (teclado do PC, teclado na tela, MIDI) ----------

  noteOn(pitch: number, vel = 100, trackId = useStore.getState().selectedTrackId) {
    const s = useStore.getState();
    const track = s.project.tracks.find((t) => t.id === trackId);
    if (!track || track.kind === 'audio') return;
    this.ensure();
    const strip = this.mixer.strips.get(track.id);
    if (!strip) return;
    const now = this.ctx.currentTime;
    const key = `${track.id}:${pitch}`;
    this.live.get(key)?.release(now);
    const recHere = s.recording?.trackId === track.id;

    if (track.kind === 'drums') {
      playDrum(this.ctx, strip.input, pitch, now, vel);
      if (recHere) this.recNotes.push({ id: uid(), pitch, start: this.getBeat(), duration: 0.25, velocity: vel });
      return;
    }
    this.live.set(key, startVoice(this.ctx, strip.input, PRESETS[track.instrument] ?? PRESETS.epiano, pitch, now, vel));
    if (recHere) this.recHeld.set(pitch, { start: this.getBeat(), vel });
  }

  noteOff(pitch: number, trackId = useStore.getState().selectedTrackId) {
    if (!this.ready) return;
    const key = `${trackId}:${pitch}`;
    this.live.get(key)?.release(this.ctx.currentTime);
    this.live.delete(key);
    const held = this.recHeld.get(pitch);
    if (held) {
      this.recHeld.delete(pitch);
      this.recNotes.push({
        id: uid(),
        pitch,
        start: held.start,
        duration: Math.max(0.05, this.getBeat() - held.start),
        velocity: held.vel,
      });
    }
  }

  // ---------- Gravação ----------

  async toggleRecord() {
    const s = useStore.getState();
    if (s.recording) return this.stop();
    const track = s.project.tracks.find((t) => t.id === s.selectedTrackId);
    if (!track) return;
    this.ensure();
    if (track.kind === 'audio') {
      if (!s.inputOpen && !(await this.openInput())) return;
      const rec = new Recorder(this.ctx, this.inputBus);
      try {
        await rec.start();
      } catch (e) {
        alert('Não foi possível iniciar a gravação: ' + (e as Error).message);
        return;
      }
      this.recorder = rec;
    }
    this.recNotes = [];
    this.recHeld.clear();
    const startBeat = this.getBeat();
    s.set({ recording: { trackId: track.id, startBeat } });
    if (this.playing) {
      // já tocando: grava a partir de agora
      this.recFrom = this.ctx.currentTime;
      return;
    }
    if (s.countIn) {
      // um compasso de metrônomo antes de a música (e a gravação) começar
      const spb = 60 / this.bpm;
      const t0 = this.ctx.currentTime + 0.1;
      for (let i = 0; i < BEATS_PER_BAR; i++) this.click(t0 + i * spb, i === 0);
      this.play(0.1 + BEATS_PER_BAR * spb);
    } else this.play();
    this.recFrom = this.startTime;
  }

  /** Instante (relógio do AudioContext) em que a gravação começa de fato. */
  private recFrom = 0;

  private finishRecording() {
    const s = useStore.getState();
    const rec = s.recording;
    if (!rec) return;
    const end = this.getBeat();
    for (const pitch of [...this.recHeld.keys()]) this.noteOff(pitch, rec.trackId);
    s.set({ recording: null });

    if (this.recorder) {
      const buf = this.recorder.stop(this.recFrom);
      this.recorder = null;
      if (buf) {
        const bufferId = uid();
        this.buffers.set(bufferId, buf);
        void saveBufferLocal(bufferId, buf);
        const r = s.addRegion({ trackId: rec.trackId, name: 'Gravação', start: rec.startBeat, length: 0, bufferId, offset: 0, duration: buf.duration });
        s.set({ selectedRegionId: r.id });
      }
      return;
    }
    if (this.recNotes.length) {
      const start = Math.floor(rec.startBeat / BEATS_PER_BAR) * BEATS_PER_BAR;
      const length = Math.max(BEATS_PER_BAR, Math.ceil((end - start) / BEATS_PER_BAR) * BEATS_PER_BAR);
      const notes = this.recNotes.map((n) => ({ ...n, start: Math.max(0, n.start - start) }));
      const r = s.addRegion({ trackId: rec.trackId, name: 'Gravação', start, length, notes });
      s.set({ selectedRegionId: r.id, editingRegionId: r.id });
    }
    this.recNotes = [];
  }

  // ---------- Entrada de áudio (placa de áudio, guitarra, microfone) ----------

  private inputBus!: GainNode;
  private inputAnalyser!: AnalyserNode;
  private monitorGain!: GainNode;
  private monitorTarget: string | null = null;
  private inStream: MediaStream | null = null;
  private inNodes: AudioNode[] = [];

  /** Atualiza a lista de dispositivos de entrada (os nomes só aparecem depois da permissão de uso). */
  async refreshInputs() {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const inputs = devices
        .filter((d) => d.kind === 'audioinput' && d.deviceId && d.deviceId !== 'default' && d.deviceId !== 'communications')
        .map((d, i) => ({ id: d.deviceId, label: d.label || `Entrada ${i + 1}` }));
      useStore.getState().set({ inputs });
    } catch {
      /* sem acesso a dispositivos */
    }
  }

  /** Abre o dispositivo escolhido e liga o canal selecionado ao barramento de entrada. */
  async openInput(): Promise<boolean> {
    this.ensure();
    this.closeInput();
    const s = useStore.getState();
    try {
      this.inStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          // sem nenhum tratamento de voz: o sinal do instrumento tem que chegar cru
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
          channelCount: { ideal: 2 },
          ...(s.inputDeviceId ? { deviceId: { exact: s.inputDeviceId } } : {}),
        },
      });
    } catch (e) {
      const err = e as DOMException;
      alert(
        err.name === 'OverconstrainedError' || err.name === 'NotFoundError'
          ? 'O dispositivo de entrada escolhido não foi encontrado. Confira se a placa está conectada e escolha outro na lista.'
          : err.name === 'NotAllowedError'
            ? 'O acesso à entrada de áudio foi bloqueado. Libere o microfone para o app em Configurações do Windows › Privacidade e segurança › Microfone.'
            : 'Não foi possível abrir a entrada de áudio: ' + err.message,
      );
      void this.refreshInputs();
      return false;
    }
    const track = this.inStream.getAudioTracks()[0];
    const channels = track.getSettings().channelCount ?? 1;
    const src = this.ctx.createMediaStreamSource(this.inStream);
    const split = this.ctx.createChannelSplitter(2);
    src.connect(split);
    // numa placa de 2 entradas a guitarra está só num dos canais; "2" (mix) soma os dois
    if (channels < 2) split.connect(this.inputBus, 0);
    else if (s.inputChannel === 2) {
      split.connect(this.inputBus, 0);
      split.connect(this.inputBus, 1);
    } else split.connect(this.inputBus, s.inputChannel);
    this.inNodes = [src, split];

    track.onended = () => {
      // placa desconectada
      this.closeInput();
      void this.refreshInputs();
    };
    // "muted" = o Windows não está entregando sinal (dispositivo no mudo nas configurações de som ou na tecla do notebook)
    const reportMuted = () => useStore.getState().set({ inputMuted: track.muted });
    track.onmute = track.onunmute = reportMuted;
    s.set({ inputOpen: true, inputChannels: channels, inputMuted: track.muted });
    await this.refreshInputs();
    return true;
  }

  closeInput() {
    if (!this.inStream) return;
    for (const t of this.inStream.getTracks()) {
      t.onended = t.onmute = t.onunmute = null;
      t.stop();
    }
    this.inNodes.forEach((n) => n.disconnect());
    this.inNodes = [];
    this.inStream = null;
    useStore.getState().set({ inputOpen: false, inputMuted: false });
  }

  /** Monitoração: manda a entrada para o canal da trilha de áudio selecionada (passa pelos efeitos dela). */
  private routeMonitor() {
    const s = useStore.getState();
    const t = s.project.tracks.find((x) => x.id === s.selectedTrackId);
    const target = s.monitor && s.inputOpen && t?.kind === 'audio' && this.mixer.strips.has(t.id) ? t.id : null;
    if (target === this.monitorTarget) return;
    this.monitorGain.disconnect();
    if (target) this.monitorGain.connect(this.mixer.strips.get(target)!.input);
    this.monitorTarget = target;
  }

  inputLevel(): number {
    if (!this.ready || !this.inStream) return 0;
    this.inputAnalyser.getFloatTimeDomainData(this.meterBuf);
    let peak = 0;
    for (let i = 0; i < this.meterBuf.length; i++) peak = Math.max(peak, Math.abs(this.meterBuf[i]));
    return Math.min(1, peak);
  }

  // ---------- Importar áudio ----------

  async importAudio(file: File, beat = 0, trackId?: string) {
    this.ensure();
    let buf: AudioBuffer;
    try {
      buf = await this.ctx.decodeAudioData(await file.arrayBuffer());
    } catch {
      alert(`Não foi possível ler "${file.name}" como áudio.`);
      return;
    }
    const s = useStore.getState();
    const name = file.name.replace(/\.[^.]+$/, '');
    const target = s.project.tracks.find((t) => t.id === trackId && t.kind === 'audio') ?? s.addTrack('audio', { name });
    const bufferId = uid();
    this.buffers.set(bufferId, buf);
    void saveBufferLocal(bufferId, buf);
    useStore.getState().addRegion({ trackId: target.id, name, start: beat, length: 0, bufferId, offset: 0, duration: buf.duration });
  }

  // ---------- Prévia de loops ----------

  stopPreview() {
    this.preview?.disconnect();
    this.preview = null;
  }

  previewNotes(kind: string, instrument: string, notes: Omit<Note, 'id'>[]) {
    this.ensure();
    this.stopPreview();
    const g = this.ctx.createGain();
    g.gain.value = 0.8;
    g.connect(this.mixer.master);
    this.preview = g;
    const t0 = this.ctx.currentTime + 0.05;
    const spb = 60 / this.bpm;
    for (const n of notes) triggerNote(this.ctx, g, kind, instrument, n.pitch, t0 + n.start * spb, n.duration * spb, n.velocity);
  }

  /** Nível de pico (0..1) de uma trilha ou do master, para os medidores. */
  private meterBuf = new Float32Array(256);
  level(trackId?: string): number {
    if (!this.ready) return 0;
    const an = trackId ? this.mixer.strips.get(trackId)?.analyser : this.mixer.analyser;
    if (!an) return 0;
    an.getFloatTimeDomainData(this.meterBuf);
    let peak = 0;
    for (let i = 0; i < this.meterBuf.length; i++) peak = Math.max(peak, Math.abs(this.meterBuf[i]));
    return Math.min(1, peak);
  }

  /** Preenche `out` com o espectro (0..255 por faixa) de uma trilha ou do master. Devolve false se não há áudio ainda. */
  spectrum(out: Uint8Array<ArrayBuffer>, trackId?: string): boolean {
    if (!this.ready) return false;
    const an = trackId ? this.mixer.strips.get(trackId)?.analyser : this.mixer.analyser;
    if (!an) return false;
    an.getByteFrequencyData(out);
    return true;
  }
}

export const engine = new Engine();

/** Número de faixas de frequência devolvidas por `engine.spectrum` (fftSize / 2). */
export const SPECTRUM_BINS = 1024;

// ---------- Regiões de áudio (ganho e fades) ----------

const EDGE_FADE = 0.003; // micro-fade nas bordas de toda região: evita estalos em cortes fora do zero

/** Toca uma região de áudio em `when`, começando `late` segundos dentro dela, com ganho e fades. */
export function playAudioRegion(
  ctx: BaseAudioContext,
  dest: AudioNode,
  r: Region,
  buf: AudioBuffer,
  when: number,
  late = 0,
): AudioBufferSourceNode | null {
  const d = Math.min(r.duration ?? buf.duration, buf.duration - (r.offset ?? 0));
  if (late >= d || d <= 0) return null;
  const fi = Math.min(Math.max(r.fadeIn ?? 0, EDGE_FADE), d / 2);
  const fo = Math.min(Math.max(r.fadeOut ?? 0, EDGE_FADE), d - fi);
  const env = { ...r, duration: d, fadeIn: fi, fadeOut: fo };
  const src = ctx.createBufferSource();
  src.buffer = buf;
  const g = ctx.createGain();
  const p = g.gain;
  p.setValueAtTime(regionGainAt(env, late), when);
  if (fi > late) p.linearRampToValueAtTime(regionGainAt(env, fi), when + fi - late);
  const foStart = d - fo;
  if (foStart > late) p.setValueAtTime(regionGainAt(env, foStart), when + foStart - late);
  p.linearRampToValueAtTime(0, when + d - late);
  src.connect(g).connect(dest);
  src.start(when, (r.offset ?? 0) + late, d - late);
  return src;
}

// ---------- Exportação (mixdown offline para WAV) ----------

export async function renderWav(project: Project, buffers: Map<string, AudioBuffer>): Promise<Blob> {
  const sr = 44100;
  const spb = 60 / project.bpm;
  const seconds = projectEnd(project) * spb + 3;
  const off = new OfflineAudioContext(2, Math.ceil(seconds * sr), sr);
  const mixer = new Mixer(off, off.destination);
  mixer.sync(project.tracks, project.bpm);
  const tracks = new Map(project.tracks.map((t) => [t.id, t]));

  for (const r of project.regions) {
    const track = tracks.get(r.trackId);
    const strip = mixer.strips.get(r.trackId);
    if (!track || !strip) continue;
    const buf = r.bufferId && buffers.get(r.bufferId);
    if (buf) playAudioRegion(off, strip.input, r, buf, r.start * spb);
    for (const n of r.notes ?? []) {
      if (n.start >= r.length) continue;
      const dur = Math.min(n.duration, r.length - n.start) * spb;
      triggerNote(off, strip.input, track.kind, track.instrument, n.pitch, (r.start + n.start) * spb, dur, n.velocity);
    }
  }
  return encodeWav(await off.startRendering());
}

function encodeWav(buf: AudioBuffer): Blob {
  const ch = buf.numberOfChannels, n = buf.length;
  const view = new DataView(new ArrayBuffer(44 + n * ch * 2));
  const str = (o: number, s: string) => [...s].forEach((c, i) => view.setUint8(o + i, c.charCodeAt(0)));
  str(0, 'RIFF');
  view.setUint32(4, 36 + n * ch * 2, true);
  str(8, 'WAVEfmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, ch, true);
  view.setUint32(24, buf.sampleRate, true);
  view.setUint32(28, buf.sampleRate * ch * 2, true);
  view.setUint16(32, ch * 2, true);
  view.setUint16(34, 16, true);
  str(36, 'data');
  view.setUint32(40, n * ch * 2, true);
  const data = Array.from({ length: ch }, (_, c) => buf.getChannelData(c));
  let o = 44;
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < ch; c++) {
      const v = Math.max(-1, Math.min(1, data[c][i]));
      view.setInt16(o, v < 0 ? v * 0x8000 : v * 0x7fff, true);
      o += 2;
    }
  }
  return new Blob([view], { type: 'audio/wav' });
}
