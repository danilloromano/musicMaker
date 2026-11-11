import { useEffect, useRef } from 'react';
import { engine } from '../audio/engine';
import { LOOPS, addLoop } from '../audio/loops';
import { PRESETS } from '../audio/instruments';
import { useStore } from '../store';
import { BEATS_PER_BAR, Region, Track, TrackKind, projectEnd, regionLen } from '../types';
import { KIND_ICON, Meter, Slider, Spectrum, useRaf } from './ui';

const HEADER_W = 264;
export const LOOP_MIME = 'application/x-mm-loop';

export function Timeline() {
  const project = useStore((s) => s.project);
  const ppb = useStore((s) => s.ppb);
  const selectedTrackId = useStore((s) => s.selectedTrackId);
  const selectedRegionId = useStore((s) => s.selectedRegionId);
  const recording = useStore((s) => s.recording);
  const loop = project.loop;
  const st = useStore.getState();

  const bars = Math.max(32, Math.ceil(projectEnd(project) / BEATS_PER_BAR) + 8);
  const width = bars * BEATS_PER_BAR * ppb;
  const barStep = ppb >= 14 ? 1 : ppb >= 9 ? 2 : 4;

  const scroll = useRef<HTMLDivElement>(null);
  const head = useRef<HTMLDivElement>(null);
  const rulerHead = useRef<HTMLDivElement>(null);
  const recEl = useRef<HTMLDivElement>(null);

  useRaf(() => {
    const b = engine.getBeat();
    if (head.current) head.current.style.transform = `translateX(${b * ppb}px)`;
    if (rulerHead.current) rulerHead.current.style.transform = `translateX(${b * ppb}px)`;
    if (recEl.current && recording) {
      recEl.current.style.left = `${recording.startBeat * ppb}px`;
      recEl.current.style.width = `${Math.max(2, (b - recording.startBeat) * ppb)}px`;
    }
    const sc = scroll.current;
    if (sc && useStore.getState().playing) {
      const x = b * ppb;
      if (x > sc.scrollLeft + sc.clientWidth - HEADER_W - 30 || x < sc.scrollLeft) sc.scrollLeft = Math.max(0, x - 60);
    }
  });

  const beatAt = (clientX: number) => {
    const sc = scroll.current!;
    return Math.max(0, (clientX - sc.getBoundingClientRect().left - HEADER_W + sc.scrollLeft) / ppb);
  };

  /**
   * Arrasta o trecho de loop: 'move' (a faixa inteira), 'start'/'end' (as bordas) ou 'new' (Shift + arrastar na régua).
   * Encaixa nos tempos; com Alt, em 1/4 de tempo.
   */
  const dragLoop = (e: React.PointerEvent, mode: 'move' | 'start' | 'end' | 'new') => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const l0 = useStore.getState().project.loop ?? { start: 0, end: 0, on: true };
    const b0 = beatAt(e.clientX);
    const move = (ev: { clientX: number; altKey: boolean }) => {
      const snap = (b: number) => Math.max(0, Math.round(b / (ev.altKey ? 0.25 : 1)) * (ev.altKey ? 0.25 : 1));
      const b = beatAt(ev.clientX);
      let { start, end } = l0;
      if (mode === 'move') {
        const d = snap(l0.start + b - b0) - l0.start;
        start += d;
        end += d;
      } else if (mode === 'start') start = Math.min(snap(b), end - 1);
      else if (mode === 'end') end = Math.max(snap(b), start + 1);
      else {
        const a = snap(b0), z = snap(b);
        if (Math.abs(z - a) < 1) return;
        [start, end] = a < z ? [a, z] : [z, a];
      }
      st.update((p) => ({ ...p, loop: { start, end, on: mode === 'new' ? true : l0.on } }), false);
    };
    const pm = (ev: PointerEvent) => move(ev);
    window.addEventListener('pointermove', pm);
    window.addEventListener('pointerup', () => window.removeEventListener('pointermove', pm), { once: true });
  };

  /** Arrasta o cursor de reprodução (pela régua ou pela própria linha). Alt = movimento livre, sem grade. */
  const scrub = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    if (e.shiftKey) return dragLoop(e, 'new');
    e.preventDefault();
    e.stopPropagation();
    document.body.classList.add('scrubbing');
    let last = -1;
    const go = (ev: { clientX: number; altKey: boolean }) => {
      const b = beatAt(ev.clientX);
      const beat = ev.altKey ? b : Math.round(b * 4) / 4;
      if (beat !== last) engine.seek((last = beat));
    };
    go(e);
    const move = (ev: PointerEvent) => go(ev);
    window.addEventListener('pointermove', move);
    window.addEventListener(
      'pointerup',
      () => {
        window.removeEventListener('pointermove', move);
        document.body.classList.remove('scrubbing');
      },
      { once: true },
    );
  };

  const dragRegion = (e: React.PointerEvent, r: Region, mode: 'move' | 'resize') => {
    if (e.button !== 0) return;
    e.stopPropagation();
    st.set({ selectedRegionId: r.id, selectedTrackId: r.trackId, selectedNoteId: null });
    // região de áudio: abre no editor de áudio (forma de onda com zoom, para cortes precisos)
    if (r.bufferId) st.set({ audioEditId: r.id, bottomTab: 'audio' });
    const x0 = e.clientX;
    const bpm = project.bpm;
    let snapped = false;
    const move = (ev: PointerEvent) => {
      const snap = ev.altKey ? 0.25 : 1;
      const d = Math.round((ev.clientX - x0) / ppb / snap) * snap;
      let patch: Partial<Region>;
      if (mode === 'move') patch = { start: Math.max(0, r.start + d) };
      else if (r.bufferId) {
        const max = (engine.buffers.get(r.bufferId)?.duration ?? 0) - (r.offset ?? 0);
        patch = { duration: Math.min(max, Math.max(0.1, (r.duration ?? 0) + (d * 60) / bpm)) };
      } else patch = { length: Math.max(1, r.length + d) };
      if (!snapped && d !== 0) {
        st.snapshot();
        snapped = true;
      }
      if (snapped) st.updateRegion(r.id, patch, false);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', () => window.removeEventListener('pointermove', move), { once: true });
  };

  const openEditor = (r: Region) => {
    if (r.notes) st.set({ editingRegionId: r.id, bottomTab: 'editor' });
  };

  const drop = (e: React.DragEvent, trackId?: string) => {
    e.preventDefault();
    e.stopPropagation();
    const beat = Math.floor(beatAt(e.clientX) / BEATS_PER_BAR) * BEATS_PER_BAR;
    const loop = LOOPS.find((l) => l.id === e.dataTransfer.getData(LOOP_MIME));
    if (loop) return addLoop(loop, beat, trackId);
    void (async () => {
      for (const f of [...e.dataTransfer.files]) await engine.importAudio(f, beat, trackId);
    })();
  };
  const allowDrop = (e: React.DragEvent) => e.preventDefault();

  const createRegion = (e: React.MouseEvent, t: Track) => {
    if (t.kind === 'audio') return;
    const start = Math.floor(beatAt(e.clientX) / BEATS_PER_BAR) * BEATS_PER_BAR;
    const r = st.addRegion({ trackId: t.id, name: t.name, start, length: 4 * BEATS_PER_BAR, notes: [] });
    st.set({ selectedRegionId: r.id, selectedTrackId: t.id, editingRegionId: r.id, bottomTab: 'editor' });
  };

  const add = (kind: TrackKind) => {
    st.addTrack(kind);
    if (kind === 'audio') st.set({ bottomTab: 'fx' }); // mostra a escolha da entrada de áudio
  };

  return (
    <div className="arrange" ref={scroll} onDragOver={allowDrop} onDrop={(e) => drop(e)}>
      <div className="arr-inner" style={{ width: HEADER_W + width, ['--ppb' as string]: `${ppb}px` }}>
        <div className="ruler-row">
          <div className="corner" style={{ width: HEADER_W }}>
            <span>Nova trilha:</span>
            <button title="Trilha de instrumento virtual" onClick={() => add('instrument')}>🎹</button>
            <button title="Trilha de bateria" onClick={() => add('drums')}>🥁</button>
            <button title="Trilha de áudio (microfone / arquivo)" onClick={() => add('audio')}>🎤</button>
          </div>
          <div className="ruler" style={{ width }} onPointerDown={scrub}>
            {Array.from({ length: Math.ceil(bars / barStep) }, (_, i) => (
              <span key={i} style={{ left: i * barStep * BEATS_PER_BAR * ppb }}>{i * barStep + 1}</span>
            ))}
            {loop && (
              <div
                className={`loop-band ${loop.on ? 'on' : ''}`}
                style={{ left: loop.start * ppb, width: (loop.end - loop.start) * ppb }}
                title="Trecho do loop: arraste para mover, pelas bordas para ajustar. Duplo clique liga/desliga."
                onPointerDown={(e) => dragLoop(e, 'move')}
                onDoubleClick={() => st.toggleLoop(engine.getBeat())}
              >
                <div className="loop-edge l" onPointerDown={(e) => dragLoop(e, 'start')} />
                <div className="loop-edge r" onPointerDown={(e) => dragLoop(e, 'end')} />
              </div>
            )}
            <div className="ruler-head" ref={rulerHead} />
          </div>
        </div>
        {loop?.on && <div className="loop-shade" style={{ left: HEADER_W + loop.start * ppb, width: (loop.end - loop.start) * ppb }} />}

        {project.tracks.map((t) => (
          <div className={`row ${t.id === selectedTrackId ? 'sel' : ''}`} key={t.id}>
            <TrackHeader track={t} />
            <div
              className="lane"
              style={{ width }}
              onPointerDown={() => st.set({ selectedTrackId: t.id, selectedRegionId: null })}
              onDoubleClick={(e) => createRegion(e, t)}
              onDragOver={allowDrop}
              onDrop={(e) => drop(e, t.id)}
            >
              {project.regions.filter((r) => r.trackId === t.id).map((r) => (
                <div
                  key={r.id}
                  className={`region ${r.id === selectedRegionId ? 'sel' : ''}`}
                  style={{ left: r.start * ppb, width: Math.max(6, regionLen(r, project.bpm) * ppb), background: t.color }}
                  onPointerDown={(e) => dragRegion(e, r, 'move')}
                  onDoubleClick={(e) => {
                    e.stopPropagation();
                    openEditor(r);
                  }}
                >
                  <div className="region-name">
                    {r.name}
                    {r.gain !== undefined && r.gain !== 1 && <small> · {gainDb(r.gain)}</small>}
                  </div>
                  {r.notes ? <NotePreview region={r} /> : <Wave region={r} />}
                  {r.bufferId && <Fades region={r} pxPerSec={(ppb * project.bpm) / 60} />}
                  <div className="region-grip" onPointerDown={(e) => dragRegion(e, r, 'resize')} />
                </div>
              ))}
              {recording?.trackId === t.id && <div className="rec-overlay" ref={recEl} />}
              {t.kind !== 'audio' && !project.regions.some((r) => r.trackId === t.id) && (
                <div className="lane-hint">Duplo clique para criar uma região · ou arraste um loop</div>
              )}
              {t.kind === 'audio' && !project.regions.some((r) => r.trackId === t.id) && !recording && (
                <div className="lane-hint">Selecione a trilha e aperte ● para gravar · ou solte um arquivo de áudio</div>
              )}
            </div>
          </div>
        ))}

        <div className="dropzone" style={{ marginLeft: HEADER_W }}>
          Arraste loops ou arquivos de áudio para cá para criar uma nova trilha
        </div>
        <div className="playhead" ref={head} style={{ left: HEADER_W }} onPointerDown={scrub} title="Arraste para mover o cursor" />
      </div>
    </div>
  );
}

function TrackHeader({ track: t }: { track: Track }) {
  const st = useStore.getState();
  const up = (patch: Partial<Track>, history = false) => st.updateTrack(t.id, patch, history);
  return (
    <div
      className="th"
      style={{ width: HEADER_W, ['--c' as string]: t.color }}
      onPointerDown={() => st.set({ selectedTrackId: t.id })}
    >
      <div className="th-top">
        <span className="th-icon">{KIND_ICON[t.kind]}</span>
        <input className="th-name" value={t.name} onChange={(e) => up({ name: e.target.value })} />
        <button className={`ms ${t.mute ? 'mute' : ''}`} title="Mudo" onClick={() => up({ mute: !t.mute }, true)}>M</button>
        <button className={`ms ${t.solo ? 'solo' : ''}`} title="Solo" onClick={() => up({ solo: !t.solo }, true)}>S</button>
        <button className="ms x" title="Excluir trilha" onClick={() => st.removeTrack(t.id)}>✕</button>
      </div>
      <div className="th-bot">
        {t.kind === 'instrument' ? (
          <select
            value={t.instrument}
            title="Instrumento"
            onChange={(e) => {
              up({ instrument: e.target.value }, true);
              e.currentTarget.blur();
            }}
          >
            {Object.entries(PRESETS).map(([id, p]) => <option key={id} value={id}>{p.name}</option>)}
          </select>
        ) : (
          t.kind === 'drums' ? <span className="th-kind">Kit eletrônico</span> : <InputButton />

        )}
        <Slider className="vol" title="Volume" min={0} max={1} step={0.01} value={t.volume} reset={0.8} onChange={(v) => up({ volume: v })} />
        <Slider className="pan" title="Pan (duplo clique centraliza)" min={-1} max={1} step={0.05} value={t.pan} reset={0} onChange={(v) => up({ pan: v })} />
      </div>
      <Meter trackId={t.id} />
      <Spectrum trackId={t.id} color={t.color} points={64} />
    </div>
  );
}

/** Atalho no cabeçalho das trilhas de áudio para a configuração da entrada (aba Efeitos). */
function InputButton() {
  const open = useStore((s) => s.inputOpen);
  return (
    <button
      className={`th-input ${open ? 'on' : ''}`}
      title="Escolher a entrada de áudio (placa, guitarra, microfone)"
      onClick={() => useStore.getState().set({ bottomTab: 'fx' })}
    >
      {open ? '● Entrada ligada' : 'Entrada…'}
    </button>
  );
}

function NotePreview({ region: r }: { region: Region }) {
  const notes = r.notes ?? [];
  if (!notes.length) return null;
  let lo = Infinity, hi = -Infinity;
  for (const n of notes) {
    lo = Math.min(lo, n.pitch);
    hi = Math.max(hi, n.pitch);
  }
  const span = Math.max(12, hi - lo + 1);
  return (
    <svg className="region-body" viewBox={`0 0 ${r.length} ${span}`} preserveAspectRatio="none">
      {notes.map((n) => (
        <rect key={n.id} x={n.start} y={hi - n.pitch + (span - (hi - lo + 1)) / 2} width={Math.max(0.1, n.duration)} height={0.8} />
      ))}
    </svg>
  );
}

export const gainDb = (g: number) => {
  const db = 20 * Math.log10(Math.max(g, 1e-4));
  return `${db > 0 ? '+' : ''}${db.toFixed(1)} dB`;
};

/** Curvas de fade sobre a região e as alças (cantos de cima) para arrastá-las. Duplo clique na alça zera o fade. */
function Fades({ region: r, pxPerSec }: { region: Region; pxPerSec: number }) {
  const st = useStore.getState();
  const d = r.duration ?? 0;
  const fi = r.fadeIn ?? 0;
  const fo = r.fadeOut ?? 0;
  const drag = (e: React.PointerEvent, which: 'fadeIn' | 'fadeOut') => {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    const x0 = e.clientX;
    const v0 = which === 'fadeIn' ? fi : fo;
    let snapped = false;
    const move = (ev: PointerEvent) => {
      const dx = (ev.clientX - x0) / pxPerSec;
      if (!snapped) {
        st.snapshot();
        snapped = true;
      }
      st.updateRegion(r.id, { [which]: Math.max(0, v0 + (which === 'fadeIn' ? dx : -dx)) }, false);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', () => window.removeEventListener('pointermove', move), { once: true });
  };
  const reset = (e: React.MouseEvent, which: 'fadeIn' | 'fadeOut') => {
    e.stopPropagation();
    st.updateRegion(r.id, { [which]: 0 });
  };
  return (
    <>
      {d > 0 && (fi > 0 || fo > 0) && (
        <svg className="fade-svg" viewBox={`0 0 ${d} 1`} preserveAspectRatio="none">
          {fi > 0 && <path d={`M0 0 L${fi} 0 L0 1 Z`} />}
          {fo > 0 && <path d={`M${d - fo} 0 L${d} 0 L${d} 1 Z`} />}
        </svg>
      )}
      <div
        className="fade-h"
        style={{ left: Math.min(fi * pxPerSec, d * pxPerSec - 9) }}
        title="Fade-in: arraste para a direita (duplo clique zera)"
        onPointerDown={(e) => drag(e, 'fadeIn')}
        onDoubleClick={(e) => reset(e, 'fadeIn')}
      />
      <div
        className="fade-h"
        style={{ right: Math.min(fo * pxPerSec, d * pxPerSec - 9) }}
        title="Fade-out: arraste para a esquerda (duplo clique zera)"
        onPointerDown={(e) => drag(e, 'fadeOut')}
        onDoubleClick={(e) => reset(e, 'fadeOut')}
      />
    </>
  );
}

function Wave({ region: r }: { region: Region }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const cv = ref.current;
    const buf = r.bufferId && engine.buffers.get(r.bufferId);
    if (!cv || !buf) return;
    const w = (cv.width = Math.min(4000, Math.max(50, Math.round((r.duration ?? 0) * 60))));
    const h = (cv.height = 48);
    const g = cv.getContext('2d')!;
    g.clearRect(0, 0, w, h);
    g.fillStyle = 'rgba(0,0,0,0.55)';
    const data = buf.getChannelData(0);
    const from = Math.floor((r.offset ?? 0) * buf.sampleRate);
    const count = Math.floor((r.duration ?? 0) * buf.sampleRate);
    const per = count / w;
    const stride = Math.max(1, Math.floor(per / 200));
    for (let x = 0; x < w; x++) {
      let min = 0, max = 0;
      const end = Math.min(data.length, from + Math.floor((x + 1) * per));
      for (let i = from + Math.floor(x * per); i < end; i += stride) {
        const v = data[i];
        if (v < min) min = v;
        if (v > max) max = v;
      }
      g.fillRect(x, (1 - max) * (h / 2), 1, Math.max(1, (max - min) * (h / 2)));
    }
  }, [r.bufferId, r.offset, r.duration]);
  return <canvas className="region-body" ref={ref} />;
}
