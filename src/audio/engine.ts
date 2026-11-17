import { useStore } from '../store';
import { BEATS_PER_BAR, MasterSettings, Note, Project, Region, projectEnd, regionGainAt, uid } from '../types';
import { PRESETS, Voice, playDrum, startVoice, triggerNote } from './instruments';
import { loadDrumSamples, warmDrumKit } from './drumKit';
import { loadAllSampleSets } from './sampler';
import { DEFAULT_MASTER, ensureWorklets, masterOf } from './master';
import { Analysis, analyze } from './analysis';
import { ExportReport, encodeExport, finishMaster } from './export';
import { Mixer } from './mixer';
import { saveBufferLocal } from './persist';
import { Recorder } from './recorder';
import { withLoading } from '../loading';
import { micSettingsPath } from '../platform';

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
  /** A/B: saída da mix e da referência (só uma fica aberta) */
  private mixOut!: GainNode;
  private refOut!: GainNode;
  /** ganho da referência para igualar o volume ao da mix */
  private refTrim!: GainNode;

  private recorder: Recorder | null = null;
  private recNotes: Note[] = [];
  private recHeld = new Map<number, { start: number; vel: number }>();
  /**
   * Punch-in: a trilha que está sendo regravada fica muda dentro do trecho (o take antigo some enquanto o
   * novo é tocado). Áudio passa por `punchDuck` (ganho que fecha no trecho); notas no trecho não são tocadas.
   */
  private punchMute: { trackId: string; start: number; end: number } | null = null;
  private punchDuck: GainNode | null = null;

  /** Cria o contexto de áudio na primeira interação do usuário. */
  ensure() {
    if (!this.ready) {
      this.ctx = new AudioContext({ latencyHint: 'interactive' });
      this.mixOut = this.ctx.createGain();
      this.mixOut.connect(this.ctx.destination);
      this.refOut = this.ctx.createGain();
      this.refOut.gain.value = 0;
      this.refTrim = this.ctx.createGain();
      this.refTrim.connect(this.refOut).connect(this.ctx.destination);
      warmDrumKit(this.ctx);
      void loadAllSampleSets(this.ctx);
      this.mixer = new Mixer(this.ctx, this.mixOut, (id) => this.buffers.get(id));
      const p = useStore.getState().project;
      this.bpm = p.bpm;
      this.mixer.sync(p);
      this.mixer.chain.update(masterOf(p.master));

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
        if (a.tracks !== b.tracks || a.bpm !== b.bpm || a.sends !== b.sends) {
          this.mixer.sync(a);
          // tocando: reagenda a automação (curva editada, trilha ligada/desligada, andamento)
          if (this.playing) this.mixer.automate(a, this.getBeat(), this.ctx.currentTime, (beat) => this.timeAt(beat));
        }
        if (a.master !== b.master) this.mixer.chain.update(masterOf(a.master));
        if (s.abRef !== prev.abRef || s.abMatch !== prev.abMatch || s.refAnalysis !== prev.refAnalysis || s.mixAnalysis !== prev.mixAnalysis) this.applyAB();
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
    this.mixer.chain.reset(); // o LUFS integrado mede a partir daqui
    this.mixer.automate(useStore.getState().project, this.startBeat, this.startTime, (b) => this.timeAt(b));
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
    this.mixer.stopAutomation(useStore.getState().project, this.position);
    for (const s of this.sources) {
      try {
        s.stop();
      } catch {
        /* já terminou */
      }
    }
    this.sources = [];
    this.punchMute = null;
    this.punchDuck?.disconnect();
    this.punchDuck = null;
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
    else if (this.ready) {
      // parado: os parâmetros automatizados assumem o valor da curva no cursor
      this.mixer.cursor = this.position;
      this.mixer.sync(useStore.getState().project);
    }
  }

  /** A/B: abre a saída da mix ou da referência (transição curta) e ajusta o volume da referência. */
  private applyAB() {
    if (!this.ready) return;
    const s = useStore.getState();
    const now = this.ctx.currentTime;
    const ref = s.abRef && !!s.project.reference;
    this.mixOut.gain.setTargetAtTime(ref ? 0 : 1, now, 0.01);
    this.refOut.gain.setTargetAtTime(ref ? 1 : 0, now, 0.01);
    // igualar volume: a referência fica no loudness da mix (medido na análise ou, sem ela, ao vivo)
    const mixL = s.mixAnalysis?.lufs ?? this.mixer.chain.reading?.integrated;
    const refL = s.refAnalysis?.lufs;
    const trim = s.abMatch && mixL !== undefined && refL !== undefined && Number.isFinite(mixL) && Number.isFinite(refL) ? 10 ** ((mixL - refL) / 20) : 1;
    this.refTrim.gain.setTargetAtTime(Math.min(4, trim), now, 0.01);
  }

  /** Carrega uma música de referência (A/B): guarda o áudio, analisa e liga ao projeto. */
  async importReference(file: File) {
    this.ensure();
    const buf = await withLoading('Carregando a referência…', async () => this.ctx.decodeAudioData(await file.arrayBuffer()));
    const bufferId = uid();
    this.buffers.set(bufferId, buf);
    void saveBufferLocal(bufferId, buf);
    const s = useStore.getState();
    s.update((p) => ({ ...p, reference: { bufferId, name: file.name.replace(/.[^.]+$/, '') } }));
    s.set({ refAnalysis: null });
    await this.analyzeReference();
  }

  /** Analisa a referência carregada (se ainda não foi analisada). */
  async analyzeReference() {
    const s = useStore.getState();
    const buf = s.project.reference && this.buffers.get(s.project.reference.bufferId);
    if (!buf) return;
    const r = buf.numberOfChannels > 1 ? buf.getChannelData(1) : buf.getChannelData(0);
    const a = await analyze(buf.getChannelData(0), r, buf.sampleRate);
    useStore.getState().set({ refAnalysis: a });
  }

  /** Agenda as regiões de áudio a partir do instante `ref` (o início da reprodução ou de uma volta do loop). */
  private startAudioRegions(ref: number) {
    const { project } = useStore.getState();
    // referência (A/B): toca junto, alinhada ao começo da música
    const refBuf = project.reference && this.buffers.get(project.reference.bufferId);
    if (refBuf) {
      const at = this.timeAt(0);
      const late = Math.max(0, ref - at);
      const src = playAudioRegion(this.ctx, this.refTrim, { id: 'ref', trackId: '', name: '', start: 0, length: 0, offset: 0, duration: refBuf.duration }, refBuf, Math.max(at, ref), late);
      if (src) this.sources.push(src);
      this.applyAB();
    }
    for (const r of project.regions) {
      const buf = r.bufferId && this.buffers.get(r.bufferId);
      const strip = this.mixer.strips.get(r.trackId);
      if (!buf || !strip) continue;
      const at = this.timeAt(r.start);
      const late = Math.max(0, ref - at);
      const dest = this.punchDuck && this.punchMute?.trackId === r.trackId ? this.punchDuck : strip.input;
      const src = playAudioRegion(this.ctx, dest, r, buf, Math.max(at, ref), late);
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
    // fim do trecho de punch-in: encerra a gravação (a música continua tocando). Espera a latência da placa e
    // um pouco mais passar do fim, para o áudio do finzinho do trecho já ter chegado ao gravador.
    const punch = useStore.getState().recording?.punch;
    const tail = ((this.ctx.baseLatency + (this.ctx.outputLatency || 0) + 0.15) * this.bpm) / 60;
    if (punch && this.getBeat() >= punch.end + tail) this.finishRecording();
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
      this.mixer.automate(useStore.getState().project, loop.start, wrap, (b) => this.timeAt(b));
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
        const pm = this.punchMute;
        if (pm && pm.trackId === r.trackId && abs >= pm.start && abs < pm.end) continue;
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
    if (!track || track.kind === 'audio' || track.kind === 'bus') return;
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
    if (track.kind === 'bus') {
      alert('Trilhas de grupo não gravam: selecione uma trilha de instrumento, bateria ou áudio.');
      return;
    }
    this.ensure();
    // punch-in: grava só dentro do trecho (se já está tocando e passou do começo, a partir de agora)
    const pr = s.project.punch;
    let punch: { start: number; end: number } | undefined;
    if (pr?.on && pr.end - pr.start >= 0.25) {
      punch = { start: this.playing ? Math.max(pr.start, this.getBeat()) : pr.start, end: pr.end };
      if (punch.start >= punch.end - 0.05) {
        alert('O cursor já passou do trecho de punch-in: pare e grave de novo (a música volta um compasso antes do trecho).');
        return;
      }
    }
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
    const startBeat = punch ? punch.start : this.getBeat();
    s.set({ recording: { trackId: track.id, startBeat, punch } });
    if (this.playing) {
      // já tocando: grava a partir de agora
      this.recFrom = this.ctx.currentTime;
      return;
    }
    if (punch) {
      // pré-roll: começa um compasso antes do trecho (ou do cursor, se ele está antes disso)
      if (this.position > punch.start - BEATS_PER_BAR) this.position = Math.max(0, punch.start - BEATS_PER_BAR);
      this.punchMute = { trackId: track.id, ...punch };
      const strip = this.mixer.strips.get(track.id);
      if (strip) {
        this.punchDuck = this.ctx.createGain();
        this.punchDuck.connect(strip.input);
      }
    }
    if (s.countIn) {
      // um compasso de metrônomo antes de a música (e a gravação) começar
      const spb = 60 / this.bpm;
      const t0 = this.ctx.currentTime + 0.1;
      for (let i = 0; i < BEATS_PER_BAR; i++) this.click(t0 + i * spb, i === 0);
      this.play(0.1 + BEATS_PER_BAR * spb);
    } else this.play();
    this.recFrom = this.startTime;
    if (punch && this.punchDuck) {
      // o take antigo fecha (10 ms) na entrada do trecho e volta na saída
      const g = this.punchDuck.gain;
      const a = this.timeAt(punch.start), b = this.timeAt(punch.end);
      g.setValueAtTime(1, Math.max(this.ctx.currentTime, a - 0.01));
      g.linearRampToValueAtTime(0, a);
      g.setValueAtTime(0, b);
      g.linearRampToValueAtTime(1, b + 0.01);
    }
  }

  /** Instante (relógio do AudioContext) em que a gravação começa de fato. */
  private recFrom = 0;

  private finishRecording() {
    const s = useStore.getState();
    const rec = s.recording;
    if (!rec) return;
    const punch = rec.punch;
    const end = punch ? Math.min(this.getBeat(), punch.end) : this.getBeat();
    for (const pitch of [...this.recHeld.keys()]) this.noteOff(pitch, rec.trackId);
    s.set({ recording: null });
    if (punch) return this.finishPunch(rec.trackId, punch.start, end);

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

  /**
   * Fim do punch-in: o que foi gravado entre `start` e `end` substitui o que havia nesse trecho da trilha
   * (o resto do take antigo fica intacto). Tudo vira um único passo de desfazer. Sem nada gravado, nada muda.
   */
  private finishPunch(trackId: string, start: number, end: number) {
    const s = useStore.getState();
    const before = s.past.length;
    const mergeHistory = () => useStore.setState((st) => ({ past: st.past.slice(0, before + 1) }));

    if (this.recorder) {
      const buf = this.recorder.stop(this.timeAt(start), this.timeAt(Math.max(start, end)));
      this.recorder = null;
      if (!buf) return;
      const bufferId = uid();
      this.buffers.set(bufferId, buf);
      void saveBufferLocal(bufferId, buf);
      s.deleteAudioRange(trackId, start, start + (buf.duration * this.bpm) / 60);
      const r = s.addRegion({ trackId, name: 'Punch', start, length: 0, bufferId, offset: 0, duration: buf.duration });
      mergeHistory();
      useStore.getState().set({ selectedRegionId: r.id, audioEditId: r.id });
      return;
    }

    const notes = this.recNotes.filter((n) => n.start >= start && n.start < end);
    this.recNotes = [];
    if (!notes.length) return;
    // tira as notas antigas que começavam no trecho e põe as novas numa região do tamanho dele
    s.update((p) => ({
      ...p,
      regions: p.regions.map((r) =>
        r.trackId === trackId && r.notes
          ? { ...r, notes: r.notes.filter((n) => r.start + n.start < start || r.start + n.start >= end) }
          : r,
      ),
    }));
    const r = s.addRegion({
      trackId,
      name: 'Punch',
      start,
      length: end - start,
      notes: notes.map((n) => ({ ...n, start: n.start - start, duration: Math.min(n.duration, end - n.start) })),
    });
    mergeHistory();
    useStore.getState().set({ selectedRegionId: r.id });
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
            ? `O acesso à entrada de áudio foi bloqueado. Libere o microfone para o app em ${micSettingsPath()}.`
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
    // "muted" = o sistema não está entregando sinal (dispositivo no mudo nas configurações de som ou na tecla do notebook)
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

  /** Carrega um arquivo de impulse response (.wav de caixa/microfone) para o rack da trilha. */
  async loadIr(file: File, trackId: string) {
    this.ensure();
    let buf: AudioBuffer;
    try {
      buf = await withLoading('Carregando impulse response…', async () => this.ctx.decodeAudioData(await file.arrayBuffer()));
    } catch {
      alert(`Não foi possível ler "${file.name}" como impulse response.`);
      return;
    }
    if (buf.duration > 3) {
      alert(`"${file.name}" tem ${buf.duration.toFixed(1)} s: isso parece uma música, não um impulse response. IRs de caixa costumam ter menos de 1 segundo.`);
      return;
    }
    const s = useStore.getState();
    const t = s.project.tracks.find((x) => x.id === trackId);
    if (!t?.amp) return;
    const irId = uid();
    this.buffers.set(irId, buf);
    void saveBufferLocal(irId, buf);
    s.updateTrack(trackId, { amp: { ...t.amp, cab: 'user', irId, irName: file.name.replace(/\.[^.]+$/, '') } });
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

  /** Nível de pico (0..1) do retorno de um efeito de envio. */
  returnLevel(id: string): number {
    const an = this.ready ? this.mixer.returnAnalysers.get(id) : undefined;
    if (!an) return 0;
    an.getFloatTimeDomainData(this.meterBuf);
    let peak = 0;
    for (let i = 0; i < this.meterBuf.length; i++) peak = Math.max(peak, Math.abs(this.meterBuf[i]));
    return Math.min(1, peak);
  }

  /** Ganho atual do sidechain de uma trilha (1 = sem redução). */
  duckLevel(trackId: string): number {
    return this.ready ? this.mixer.duckLevel(trackId) : 1;
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

/**
 * Mixdown offline com o master (EQ, compressor, saturação) e, depois, o limitador e o alvo de loudness.
 * `onProgress` (0..1): a renderização ocupa os primeiros 60%, a finalização do master o resto.
 */
export async function renderWav(
  project: Project,
  buffers: Map<string, AudioBuffer>,
  onProgress?: (p: number) => void,
): Promise<{ blob: Blob; ext: string; report: ExportReport }> {
  const master = masterOf(project.master);
  const rendered = await renderMix(project, buffers, master, (p) => onProgress?.(p * 0.6));
  const { channels, report } = await finishMaster(rendered, master, (p) => onProgress?.(0.6 + p * 0.3));
  const { blob, ext } = await encodeExport(channels, rendered.sampleRate, master, (p) => onProgress?.(0.9 + p * 0.1));
  onProgress?.(1);
  return { blob, ext, report };
}

/** Master neutro (sem EQ, compressão, saturação, multibanda nem limitador): a mix "crua". */
const NEUTRAL_MASTER = { ...DEFAULT_MASTER, limiter: { ...DEFAULT_MASTER.limiter, on: false }, exportTarget: 'none' as const };

/**
 * Analisa a música: 'raw' = a mix sem nada no master (para o master automático decidir o que fazer);
 * 'mastered' = como sairia na exportação (master + limitador + alvo de loudness).
 */
export async function analyzeProject(
  project: Project,
  buffers: Map<string, AudioBuffer>,
  mode: 'raw' | 'mastered',
  onProgress?: (p: number) => void,
): Promise<Analysis> {
  const master = mode === 'raw' ? NEUTRAL_MASTER : masterOf(project.master);
  const rendered = await renderMix(project, buffers, master, (p) => onProgress?.(p * 0.6));
  let [l, r]: Float32Array[] = [rendered.getChannelData(0), rendered.getChannelData(1)];
  if (mode === 'mastered') [l, r] = (await finishMaster(rendered, master, (p) => onProgress?.(0.6 + p * 0.2))).channels;
  return analyze(l, r, rendered.sampleRate, (p) => onProgress?.(0.8 + p * 0.2));
}

/** Renderiza o projeto inteiro offline com o master dado, até a entrada do limitador. */
async function renderMix(project: Project, buffers: Map<string, AudioBuffer>, master: MasterSettings, onProgress?: (p: number) => void): Promise<AudioBuffer> {
  const sr = 44100;
  const spb = 60 / project.bpm;
  const seconds = projectEnd(project) * spb + 3;
  const off = new OfflineAudioContext(2, Math.ceil(seconds * sr), sr);
  await Promise.all([loadDrumSamples(off), loadAllSampleSets(off), ensureWorklets(off).catch(() => {})]);
  const mixer = new Mixer(off, off.destination, (id) => buffers.get(id), false);
  mixer.sync(project);
  mixer.automate(project, 0, 0, (b) => b * spb);
  mixer.chain.update(master);
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
  if (onProgress) {
    const steps = 40;
    for (let k = 1; k < steps; k++) {
      // a renderização pausa em cada ponto, avisa o progresso e continua (o último 5% fica para gerar o arquivo)
      void off.suspend((seconds * k) / steps).then(() => {
        onProgress(k / steps);
        void off.resume();
      });
    }
  }
  return off.startRendering();
}

