import { useStore } from '../store';
import { BEATS_PER_BAR, MasterSettings, Note, Project, Region, Track, freezeKey, projectEnd, regionGainAt, regionLen, uid } from '../types';
import { PRESETS, Voice, loadInstruments, playDrum, startVoice, triggerNote } from './instruments';
import { loadDrumSamples, warmDrumKit } from './drumKit';
import { DEFAULT_MASTER, ensureWorklets, masterOf } from './master';
import { Analysis, analyze } from './analysis';
import { ExportReport, encodeExport, finishMaster } from './export';
import { Mixer } from './mixer';
import { audibleSet } from './routing';
import { makeZip } from './zip';
import { saveBufferLocal } from './persist';
import { Recorder } from './recorder';
import { Held, arpStep, playedNotes } from './arp';
import { withLoading } from '../loading';
import { addRecordedTakes, trackTakes } from './takes';
import { micSettingsPath } from '../platform';

const LOOKAHEAD = 0.2; // s de antecedência com que as notas são agendadas (folga para a interface ocupada)
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
  /** gravação de áudio em loop: início (relógio e tempo) de cada volta depois da primeira */
  private recPasses: { t: number; beat: number }[] = [];
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
      void loadInstruments(this.ctx, useStore.getState().project.tracks.map((t) => t.instrument));
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
      // afinador: janela de ~170 ms (cobre alguns períodos até do Si grave do baixo de 5 cordas)
      this.tunerAnalyser = this.ctx.createAnalyser();
      this.tunerAnalyser.fftSize = 8192;
      this.inputBus.connect(this.tunerAnalyser);

      useStore.subscribe((s, prev) => {
        const a = s.project, b = prev.project;
        if (a.bpm !== b.bpm) this.retime(a.bpm);
        // instrumento novo numa trilha: carrega as gravações dele
        if (a.tracks !== b.tracks) void loadInstruments(this.ctx, a.tracks.map((t) => t.instrument));
        if (a.tracks !== b.tracks || a.bpm !== b.bpm || a.sends !== b.sends || a.key !== b.key) {
          this.mixer.sync(a);
          // tocando: reagenda a automação (curva editada, trilha ligada/desligada, andamento)
          if (this.playing) this.mixer.automate(a, this.getBeat(), this.ctx.currentTime, (beat) => this.timeAt(beat));
        }
        // trilha que passou a tocar congelada ou ao vivo (congelou, descongelou, mudou depois de congelar):
        // remonta o rack e, tocando, recomeça no mesmo ponto para trocar o que está agendado
        const frozen = this.frozenSig(a);
        if (frozen !== this.lastFrozen) {
          this.lastFrozen = frozen;
          this.mixer.sync(a);
          queueMicrotask(() => this.restartPlayback());
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

  /** Instrumentos (e bateria gravada) já carregados para o conjunto atual de trilhas. */
  private loadedSig = '';
  /** Play pedido enquanto os sons carregavam (o número muda se o usuário parar antes). */
  private pendingPlay = 0;

  /**
   * Garante que as gravações dos instrumentos do projeto estão prontas antes de tocar. Devolve null se já
   * estão; senão, a promessa do carregamento. Começar a tocar com elas carregando fazia a música engasgar
   * (a decodificação disputa o processador com o agendamento das notas) e as primeiras notas saírem com o
   * timbre de reserva.
   */
  private preload(): Promise<unknown> | null {
    const tracks = useStore.getState().project.tracks;
    const drums = tracks.some((t) => t.kind === 'drums');
    const sig = (drums ? 'd|' : '') + [...new Set(tracks.map((t) => t.instrument))].sort().join(',');
    if (sig === this.loadedSig) return null;
    return Promise.all([drums ? loadDrumSamples(this.ctx) : null, loadInstruments(this.ctx, tracks.map((t) => t.instrument))]).finally(() => {
      this.loadedSig = sig; // se falhou, toca com o timbre de reserva (não fica tentando a cada play)
    });
  }

  /** Começa a tocar do cursor. `delay` = segundos até o início (a contagem antes de gravar usa um compasso). */
  play(delay = 0.06) {
    this.ensure();
    if (this.playing) return;
    const wait = this.preload();
    if (wait) {
      const id = ++this.pendingPlay;
      const done = wait.catch(() => {});
      // a nave de carregamento só aparece se demorar (o mais comum é já estar quase pronto)
      const slow = setTimeout(() => void withLoading('Carregando os instrumentos…', () => done), 250);
      void done.then(() => {
        clearTimeout(slow);
        if (id === this.pendingPlay && !this.playing) this.play(delay);
      });
      return;
    }
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
    this.pendingPlay++; // cancela um play que esperava os sons carregarem
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
    const frozen = new Set<string>();
    for (const t of project.tracks) {
      const buf = this.mixer.frozenOf(project, t);
      const strip = this.mixer.strips.get(t.id);
      if (!buf || !strip) continue;
      frozen.add(t.id);
      const at = this.timeAt(0);
      const src = playAudioRegion(this.ctx, strip.input, frozenRegion(t, buf), buf, Math.max(at, ref), Math.max(0, ref - at));
      if (src) this.sources.push(src);
    }
    for (const r of project.regions) {
      const buf = r.bufferId && this.buffers.get(r.bufferId);
      const strip = this.mixer.strips.get(r.trackId);
      if (!buf || !strip || frozen.has(r.trackId)) continue;
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
    // gravando: o loop só vale para áudio sem punch-in (cada volta vira um take); MIDI e punch tocam reto
    if (!l?.on || (s.recording && (s.recording.punch || !this.recorder)) || l.end - l.start < 0.25 || this.startBeat >= l.end) return null;
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
      if (this.recorder && useStore.getState().recording) this.recPasses.push({ t: wrap, beat: loop.start });
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
      if (!track || !strip || this.mixer.frozenOf(project, track)) continue;
      for (const n of playedNotes(r, track, this.bpm)) {
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
    if (recHere) this.recHeld.set(pitch, { start: this.getBeat(), vel });
    // arpejador ligado: a nota entra no acorde segurado e quem toca é o relógio do arpejo
    if (track.kind === 'instrument' && track.arp?.on) {
      if (this.arpTrack !== track.id) this.stopArp();
      this.arpTrack = track.id;
      this.arpHeld.set(pitch, { pitch, vel, order: this.arpOrder++ });
      if (!this.arpTimer) this.startArp();
      return;
    }
    this.live.set(key, startVoice(this.ctx, strip.input, PRESETS[track.instrument] ?? PRESETS.epiano, pitch, now, vel));
  }

  // ---------- Arpejador ao vivo (teclado do PC, teclado na tela, MIDI) ----------

  private arpHeld = new Map<number, Held>();
  private arpTrack: string | null = null;
  private arpOrder = 0;
  private arpTimer = 0;
  private arpCount = 0;
  private arpStepN = 0;
  /** próximo passo: instante (relógio do áudio) e, tocando, o tempo da música em que ele cai */
  private arpNext = 0;
  private arpBeat = 0;
  private arpSynced = false;

  /**
   * Relógio do arpejo: parado, o primeiro passo sai na hora e os outros seguem o andamento; tocando, os
   * passos caem na grade da música (o arpejo fica no tempo da bateria).
   */
  private startArp() {
    this.arpCount = 0;
    this.arpNext = this.ctx.currentTime + 0.005;
    this.arpSynced = false;
    this.arpTimer = window.setInterval(() => this.arpTick(), 15);
    this.arpTick();
  }

  private stopArp() {
    clearInterval(this.arpTimer);
    this.arpTimer = 0;
    this.arpHeld.clear();
    this.arpCount = 0;
  }

  private arpTick() {
    const s = useStore.getState();
    const track = s.project.tracks.find((t) => t.id === this.arpTrack);
    const strip = track && this.mixer.strips.get(track.id);
    const arp = track?.arp;
    if (!track || !strip || !arp?.on || !this.arpHeld.size) return this.stopArp();
    const step = Math.max(1 / 16, arp.rate);
    const spb = 60 / this.bpm;
    const horizon = this.ctx.currentTime + 0.06;
    // começou ou parou de tocar: reancora o relógio (tocando, no próximo passo da grade)
    // (e também se o cursor pulou: seek, volta do loop — o passo previsto ficou longe de agora)
    const now = this.ctx.currentTime;
    const lost = this.arpSynced && this.playing && (this.arpNext < now - 0.03 || this.arpNext > now + step * spb + 0.1);
    if (this.playing !== this.arpSynced || lost) {
      this.arpSynced = this.playing;
      if (this.playing) {
        this.arpBeat = Math.ceil((this.getBeat() - 1e-3) / step) * step;
        this.arpNext = this.timeAt(this.arpBeat);
      }
    }
    for (let guard = 0; this.arpNext < horizon && guard < 16; guard++) {
      const at = Math.max(this.arpNext, this.ctx.currentTime);
      const dur = step * spb * Math.max(0.05, Math.min(1, arp.gate));
      for (const n of arpStep([...this.arpHeld.values()], arp, this.arpCount, this.arpStepN++)) {
        triggerNote(this.ctx, strip.input, 'instrument', track.instrument, n.pitch, at, dur, n.vel);
      }
      this.arpCount++;
      if (this.arpSynced) {
        this.arpBeat += step;
        this.arpNext = this.timeAt(this.arpBeat);
      } else this.arpNext += step * spb;
    }
  }

  noteOff(pitch: number, trackId = useStore.getState().selectedTrackId) {
    if (!this.ready) return;
    if (trackId === this.arpTrack && this.arpHeld.delete(pitch) && !this.arpHeld.size) this.stopArp();
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

  // ---------- Congelar trilha ----------

  private lastFrozen = '';
  /** Quais trilhas estão tocando congeladas agora (para perceber quando isso muda). */
  private frozenSig(p: Project) {
    return p.tracks.filter((t) => this.mixer.frozenOf(p, t)).map((t) => t.id).join();
  }

  /** Congela a trilha (ou recongela, se ela mudou): renderiza instrumento + rack em áudio. */
  async freezeTrack(trackId: string) {
    this.ensure();
    const s = useStore.getState();
    const t = s.project.tracks.find((x) => x.id === trackId);
    if (!t || t.kind === 'bus') return;
    if (s.recording?.trackId === trackId) return;
    const project = s.project;
    const buf = await withLoading(`Congelando "${t.name}"…`, () => renderFrozen(project, trackId, this.buffers, this.ctx.sampleRate));
    if (!buf) {
      alert('Não há nada para congelar nesta trilha ainda.');
      return;
    }
    const bufferId = uid();
    this.buffers.set(bufferId, buf);
    void saveBufferLocal(bufferId, buf);
    // a impressão digital é do projeto como estava ao começar a renderizar: se algo mudou no meio, fica desatualizado
    const cur = useStore.getState().project.tracks.find((x) => x.id === trackId);
    if (cur) useStore.getState().updateTrack(trackId, { frozen: { bufferId, key: freezeKey(project, t) } }, false);
  }

  unfreezeTrack(trackId: string) {
    useStore.getState().updateTrack(trackId, { frozen: undefined }, false);
  }

  /** Recomeça a reprodução no mesmo ponto (a trilha passou a tocar congelada ou ao vivo). */
  restartPlayback() {
    if (!this.playing || useStore.getState().recording) return;
    this.seek(this.getBeat());
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
    if (this.mixer.frozenOf(s.project, track)) {
      alert('Esta trilha está congelada: descongele (botão ❄ no cabeçalho dela) para gravar.');
      return;
    }
    // a gravação começa a tocar na hora (a contagem já está agendada): os sons precisam estar prontos antes
    const loading = this.preload();
    if (loading) await withLoading('Carregando os instrumentos…', () => loading.catch(() => {}));
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
    this.recPasses = [];
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
      // uma passada por volta do loop (sem loop, uma só); a última pode ter ficado pela metade
      const passes = [{ t: this.recFrom, beat: rec.startBeat }, ...this.recPasses];
      this.recPasses = [];
      const bufs = this.recorder.stopRanges(passes.map((ps, i) => [ps.t, passes[i + 1]?.t]));
      this.recorder = null;
      const recs: Region[] = [];
      bufs.forEach((buf, i) => {
        // sobra curta no fim (parou logo depois de o loop voltar): descarta
        if (!buf || (i > 0 && i === bufs.length - 1 && (buf.duration * this.bpm) / 60 < 1)) return;
        const bufferId = uid();
        this.buffers.set(bufferId, buf);
        void saveBufferLocal(bufferId, buf);
        recs.push({ id: '', trackId: rec.trackId, name: 'Gravação', start: passes[i].beat, length: 0, bufferId, offset: 0, duration: buf.duration });
      });
      if (!recs.length) return;
      s.update((p) => addRecordedTakes(p, rec.trackId, recs));
      const p = useStore.getState().project;
      const last = p.regions.find((r) => r.trackId === rec.trackId && r.take === Math.max(...trackTakes(p, rec.trackId)));
      // mais de uma passada (ou gravou por cima de outra): abre as faixas de takes para escolher
      const many = trackTakes(p, rec.trackId).length > 1;
      if (many) s.updateTrack(rec.trackId, { takesView: true }, false);
      s.set({ selectedRegionId: last?.id ?? null });
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
  private tunerAnalyser!: AnalyserNode;
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

  /** O sinal da entrada (antes de qualquer efeito) para o afinador, ou undefined se a entrada está fechada. */
  tunerInput(): AnalyserNode | undefined {
    return this.ready && this.inStream ? this.tunerAnalyser : undefined;
  }

  /** Afinador aberto no modo mudo: a monitoração fica em silêncio (afina sem soltar som na caixa). */
  muteMonitor(mute: boolean) {
    if (!this.ready) return;
    this.monitorGain.gain.setTargetAtTime(mute ? 0 : 1, this.ctx.currentTime, 0.01);
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

  async previewNotes(kind: string, instrument: string, notes: Omit<Note, 'id'>[]) {
    this.ensure();
    this.stopPreview();
    // a primeira prévia de um instrumento espera as gravações dele carregarem (não toca o sintetizado)
    await loadInstruments(this.ctx, [instrument]);
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

/**
 * Stems: uma faixa de áudio por trilha, todas do mesmo tamanho e começando no tempo 0, para abrir em outro
 * programa e mixar lá. Cada uma é a trilha sozinha como soa na mix (EQ, compressor, volume, pan, automação,
 * o grupo para onde ela vai e os efeitos de envio dela), sem o master: somando os stems dá a mix crua.
 * Só entram as trilhas que tocam na mix agora (mudo/solo valem) e que têm alguma região. Devolve um .zip.
 */
export async function renderStems(
  project: Project,
  buffers: Map<string, AudioBuffer>,
  onProgress?: (p: number) => void,
): Promise<{ blob: Blob; count: number }> {
  const master = masterOf(project.master);
  const audible = audibleSet(project.tracks);
  const tracks = project.tracks.filter((t) => t.kind !== 'bus' && audible.has(t.id) && project.regions.some((r) => r.trackId === t.id));
  const files: { name: string; blob: Blob }[] = [];
  const clean = (n: string) => n.replace(/[\\/:*?"<>|]+/g, '-').trim() || 'Trilha';
  for (let i = 0; i < tracks.length; i++) {
    const t = tracks[i];
    const step = (p: number) => onProgress?.((i + p) / tracks.length);
    // só esta trilha soando: as outras no mudo (continuam alimentando o sidechain, que vem antes do volume)
    const solo: Project = {
      ...project,
      tracks: project.tracks.map((x) => (x.kind === 'bus' ? { ...x, solo: false } : { ...x, solo: false, mute: x.id !== t.id })),
    };
    const rendered = await renderMix(solo, buffers, NEUTRAL_MASTER, (p) => step(p * 0.8));
    const chans = [rendered.getChannelData(0), rendered.getChannelData(1)];
    const { blob, ext } = await encodeExport(chans, rendered.sampleRate, master, (p) => step(0.8 + p * 0.2));
    files.push({ name: `${String(i + 1).padStart(2, '0')} ${clean(t.name)}.${ext}`, blob });
  }
  const blob = await makeZip(files);
  onProgress?.(1);
  return { blob, count: files.length };
}

/** Região "de mentira" que toca o áudio congelado de uma trilha inteiro, a partir do tempo 0. */
function frozenRegion(t: Track, buf: AudioBuffer): Region {
  return { id: `frozen:${t.id}`, trackId: t.id, name: '', start: 0, length: 0, offset: 0, duration: buf.duration };
}

/** Agenda tudo (offline, do tempo 0): o áudio congelado das trilhas congeladas, regiões e notas das outras. */
function scheduleAll(off: BaseAudioContext, mixer: Mixer, project: Project, buffers: Map<string, AudioBuffer>, spb: number) {
  const tracks = new Map(project.tracks.map((t) => [t.id, t]));
  const frozen = new Set<string>();
  for (const t of project.tracks) {
    const buf = mixer.frozenOf(project, t);
    const strip = mixer.strips.get(t.id);
    if (!buf || !strip) continue;
    frozen.add(t.id);
    playAudioRegion(off, strip.input, frozenRegion(t, buf), buf, 0);
  }
  for (const r of project.regions) {
    const track = tracks.get(r.trackId);
    const strip = mixer.strips.get(r.trackId);
    if (!track || !strip || frozen.has(r.trackId)) continue;
    const buf = r.bufferId && buffers.get(r.bufferId);
    if (buf) playAudioRegion(off, strip.input, r, buf, r.start * spb);
    for (const n of playedNotes(r, track, project.bpm)) {
      if (n.start >= r.length) continue;
      const dur = Math.min(n.duration, r.length - n.start) * spb;
      triggerNote(off, strip.input, track.kind, track.instrument, n.pitch, (r.start + n.start) * spb, dur, n.velocity);
    }
  }
}

/** Segundos de "rabo" depois da última nota no congelamento (reverb e delay dos pedais terminarem). */
const FREEZE_TAIL = 6;

/**
 * Congela uma trilha: renderiza offline o instrumento (ou o áudio) dela passando pelo rack de amp e pedais,
 * do tempo 0 até o fim da última região mais o rabo, e corta o silêncio do fim. O que vem depois do rack
 * (EQ, compressor, volume, pan, envios, automação de volume) continua ao vivo.
 */
export async function renderFrozen(project: Project, trackId: string, buffers: Map<string, AudioBuffer>, sampleRate: number): Promise<AudioBuffer | null> {
  const t = project.tracks.find((x) => x.id === trackId);
  if (!t || t.kind === 'bus') return null;
  const regions = project.regions.filter((r) => r.trackId === trackId);
  if (!regions.length) return null;
  const spb = 60 / project.bpm;
  const end = Math.max(...regions.map((r) => r.start + regionLen(r, project.bpm)));
  const length = Math.ceil((end * spb + FREEZE_TAIL) * sampleRate);
  const off = new OfflineAudioContext(2, length, sampleRate);
  await Promise.all([loadDrumSamples(off), loadInstruments(off, project.tracks.map((t) => t.instrument)), ensureWorklets(off).catch(() => {})]);
  // só esta trilha, ao vivo (sem o congelamento antigo), audível e indo para o master
  const solo: Project = {
    ...project,
    tracks: [{ ...t, frozen: undefined, mute: false, solo: false, output: undefined }],
    regions,
  };
  const mixer = new Mixer(off, off.destination, (id) => buffers.get(id), false);
  mixer.sync(solo);
  mixer.automate(solo, 0, 0, (b) => b * spb);
  const strip = mixer.strips.get(t.id)!;
  // a saída do rack (ou a entrada do canal, sem rack) vai direto para o resultado
  const tap: AudioNode = strip.rig?.output ?? strip.input;
  tap.disconnect();
  tap.connect(off.destination);
  scheduleAll(off, mixer, solo, buffers, spb);
  const out = await off.startRendering();
  // corta o silêncio depois do fim (mantém pelo menos o fim da última região)
  const L = out.getChannelData(0), R = out.getChannelData(1);
  let last = Math.ceil(end * spb * sampleRate);
  for (let i = length - 1; i > last; i--) {
    if (Math.abs(L[i]) > 1e-4 || Math.abs(R[i]) > 1e-4) {
      last = i;
      break;
    }
  }
  const n = Math.min(length, last + Math.round(0.05 * sampleRate));
  const buf = new AudioBuffer({ length: n, numberOfChannels: 2, sampleRate });
  buf.copyToChannel(L.subarray(0, n), 0);
  buf.copyToChannel(R.subarray(0, n), 1);
  return buf;
}

/** Renderiza o projeto inteiro offline com o master dado, até a entrada do limitador. */
async function renderMix(project: Project, buffers: Map<string, AudioBuffer>, master: MasterSettings, onProgress?: (p: number) => void): Promise<AudioBuffer> {
  const sr = 44100;
  const spb = 60 / project.bpm;
  const seconds = projectEnd(project) * spb + 3;
  const off = new OfflineAudioContext(2, Math.ceil(seconds * sr), sr);
  await Promise.all([loadDrumSamples(off), loadInstruments(off, project.tracks.map((t) => t.instrument)), ensureWorklets(off).catch(() => {})]);
  const mixer = new Mixer(off, off.destination, (id) => buffers.get(id), false);
  mixer.sync(project);
  mixer.automate(project, 0, 0, (b) => b * spb);
  mixer.chain.update(master);
  scheduleAll(off, mixer, project, buffers, spb);
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

