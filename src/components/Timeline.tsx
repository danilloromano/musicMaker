import { useEffect, useRef } from 'react';
import { engine } from '../audio/engine';
import { LOOPS, addLoop } from '../audio/loops';
import { PRESETS } from '../audio/instruments';
import { useStore } from '../store';
import { BEATS_PER_BAR, Region, Track, TrackKind, projectEnd, regionLen } from '../types';
import { KIND_ICON, Meter, Slider, useRaf } from './ui';

const HEADER_W = 264;
export const LOOP_MIME = 'application/x-mm-loop';

export function Timeline() {
  const project = useStore((s) => s.project);
  const ppb = useStore((s) => s.ppb);
  const selectedTrackId = useStore((s) => s.selectedTrackId);
  const selectedRegionId = useStore((s) => s.selectedRegionId);
  const recording = useStore((s) => s.recording);
  const st = useStore.getState();

  const bars = Math.max(32, Math.ceil(projectEnd(project) / BEATS_PER_BAR) + 8);
  const width = bars * BEATS_PER_BAR * ppb;
  const barStep = ppb >= 14 ? 1 : ppb >= 9 ? 2 : 4;

  const scroll = useRef<HTMLDivElement>(null);
  const head = useRef<HTMLDivElement>(null);
  const recEl = useRef<HTMLDivElement>(null);

  useRaf(() => {
    const b = engine.getBeat();
    if (head.current) head.current.style.transform = `translateX(${b * ppb}px)`;
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

  const scrub = (e: React.PointerEvent) => {
    const go = (x: number) => engine.seek(Math.round(beatAt(x)));
    go(e.clientX);
    const move = (ev: PointerEvent) => go(ev.clientX);
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', () => window.removeEventListener('pointermove', move), { once: true });
  };

  const dragRegion = (e: React.PointerEvent, r: Region, mode: 'move' | 'resize') => {
    if (e.button !== 0) return;
    e.stopPropagation();
    st.set({ selectedRegionId: r.id, selectedTrackId: r.trackId, selectedNoteId: null });
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

  const add = (kind: TrackKind) => st.addTrack(kind);

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
          </div>
        </div>

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
                  <div className="region-name">{r.name}</div>
                  {r.notes ? <NotePreview region={r} /> : <Wave region={r} />}
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
        <div className="playhead" ref={head} style={{ left: HEADER_W }} />
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
          <span className="th-kind">{t.kind === 'drums' ? 'Kit eletrônico' : 'Áudio'}</span>
        )}
        <Slider className="vol" title="Volume" min={0} max={1} step={0.01} value={t.volume} reset={0.8} onChange={(v) => up({ volume: v })} />
        <Slider className="pan" title="Pan (duplo clique centraliza)" min={-1} max={1} step={0.05} value={t.pan} reset={0} onChange={(v) => up({ pan: v })} />
      </div>
      <Meter trackId={t.id} />
    </div>
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
