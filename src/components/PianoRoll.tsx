import { useEffect, useMemo, useRef, useState } from 'react';
import { engine } from '../audio/engine';
import { DRUM_MAP } from '../audio/instruments';
import { useStore } from '../store';
import { Note, uid } from '../types';
import { useRaf } from './ui';

const PPB = 80; // pixels por tempo
const RH = 16; // altura da linha
const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const HI = 96, LO = 24;

export function PianoRoll() {
  const region = useStore((s) => s.project.regions.find((r) => r.id === s.editingRegionId));
  const track = useStore((s) => s.project.tracks.find((t) => t.id === region?.trackId));
  const selectedNoteId = useStore((s) => s.selectedNoteId);
  const st = useStore.getState();
  const [snap, setSnap] = useState(0.25);
  const lastDur = useRef<number | null>(null);
  const scroll = useRef<HTMLDivElement>(null);
  const head = useRef<HTMLDivElement>(null);
  const isDrums = track?.kind === 'drums';

  const rows = useMemo(
    () =>
      isDrums
        ? DRUM_MAP.map((d) => ({ pitch: d.pitch, label: d.name, black: false }))
        : Array.from({ length: HI - LO + 1 }, (_, i) => {
            const pitch = HI - i;
            const name = NAMES[pitch % 12];
            return { pitch, label: name === 'C' ? `C${Math.floor(pitch / 12) - 1}` : '', black: name.includes('#') };
          }),
    [isDrums],
  );
  const rowOf = useMemo(() => new Map(rows.map((r, i) => [r.pitch, i])), [rows]);

  // ao abrir uma região, centraliza a rolagem nas notas existentes (ou em C4)
  const regionId = region?.id;
  useEffect(() => {
    const sc = scroll.current;
    const r = useStore.getState().project.regions.find((x) => x.id === regionId);
    if (!sc || !r) return;
    const pitches = (r.notes ?? []).map((n) => n.pitch);
    const center = pitches.length ? (Math.min(...pitches) + Math.max(...pitches)) / 2 : 60;
    sc.scrollTop = (rowOf.get(Math.round(center)) ?? 0) * RH - sc.clientHeight / 2;
    sc.scrollLeft = 0;
  }, [regionId, rowOf]);

  useRaf(() => {
    if (!head.current || !region) return;
    const b = engine.getBeat() - region.start;
    head.current.style.display = b >= 0 && b <= region.length ? 'block' : 'none';
    head.current.style.transform = `translateX(${b * PPB}px)`;
  });

  if (!region?.notes || !track) {
    return (
      <div className="empty">
        Dê um duplo clique numa região MIDI — ou numa área vazia de uma trilha de instrumento/bateria — para editar as notas aqui.
      </div>
    );
  }
  const notes = region.notes;
  const selected = notes.find((n) => n.id === selectedNoteId);

  const preview = (pitch: number) => {
    engine.noteOn(pitch, 100, track.id);
    setTimeout(() => engine.noteOff(pitch, track.id), 180);
  };

  const addNote = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const row = rows[Math.floor((e.clientY - rect.top) / RH)];
    if (!row) return;
    const start = Math.floor((e.clientX - rect.left) / PPB / snap) * snap;
    if (start >= region.length) return;
    const n: Note = { id: uid(), pitch: row.pitch, start, duration: lastDur.current ?? (isDrums ? 0.25 : 1), velocity: 100 };
    st.setNotes(region.id, [...notes, n]);
    st.set({ selectedNoteId: n.id, selectedTrackId: track.id });
    preview(n.pitch);
  };

  const dragNote = (e: React.PointerEvent<HTMLDivElement>, n: Note) => {
    e.stopPropagation();
    if (e.button !== 0) return;
    st.set({ selectedNoteId: n.id, selectedTrackId: track.id });
    preview(n.pitch);
    const box = e.currentTarget.getBoundingClientRect();
    const resize = !isDrums && e.clientX > box.right - 7;
    const x0 = e.clientX, y0 = e.clientY;
    const row0 = rowOf.get(n.pitch) ?? 0;
    let snapped = false;
    let lastPitch = n.pitch;
    const move = (ev: PointerEvent) => {
      const d = Math.round((ev.clientX - x0) / PPB / snap) * snap;
      let patch: Partial<Note>;
      if (resize) {
        patch = { duration: Math.max(snap, n.duration + d) };
        lastDur.current = patch.duration!;
      } else {
        const row = Math.max(0, Math.min(rows.length - 1, row0 + Math.round((ev.clientY - y0) / RH)));
        patch = { start: Math.max(0, Math.min(region.length - snap, n.start + d)), pitch: rows[row].pitch };
        if (patch.pitch !== lastPitch) preview((lastPitch = patch.pitch!));
      }
      if (!snapped) {
        if (d === 0 && (resize || patch.pitch === n.pitch)) return;
        st.snapshot();
        snapped = true;
      }
      const cur = useStore.getState().project.regions.find((r) => r.id === region.id)?.notes ?? [];
      st.setNotes(region.id, cur.map((x) => (x.id === n.id ? { ...x, ...patch } : x)), false);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', () => window.removeEventListener('pointermove', move), { once: true });
  };

  const removeNote = (id: string) => st.setNotes(region.id, notes.filter((n) => n.id !== id));

  return (
    <div className="roll">
      <div className="roll-bar">
        <input
          className="roll-name"
          value={region.name}
          title="Nome da região"
          onChange={(e) => st.updateRegion(region.id, { name: e.target.value }, false)}
        />
        <label>
          Grade
          <select value={snap} onChange={(e) => { setSnap(+e.target.value); e.currentTarget.blur(); }}>
            <option value={1}>1/4</option>
            <option value={0.5}>1/8</option>
            <option value={0.25}>1/16</option>
            <option value={0.125}>1/32</option>
          </select>
        </label>
        <button
          title="Alinha o início de todas as notas à grade"
          onClick={() => st.setNotes(region.id, notes.map((n) => ({ ...n, start: Math.round(n.start / snap) * snap })))}
        >
          Quantizar
        </button>
        {selected && (
          <label>
            Intensidade
            <input
              type="range"
              min={1}
              max={127}
              value={selected.velocity}
              onPointerDown={() => st.snapshot()}
              onChange={(e) =>
                st.setNotes(region.id, notes.map((n) => (n.id === selected.id ? { ...n, velocity: +e.target.value } : n)), false)
              }
            />
          </label>
        )}
        <span className="hint">Clique: criar · Arrastar: mover · Borda direita: esticar · Botão direito / Delete: apagar</span>
      </div>
      <div className="roll-scroll" ref={scroll}>
        <div className="roll-inner" style={{ height: rows.length * RH }}>
          <div className={`keys ${isDrums ? 'drums' : ''}`}>
            {rows.map((r) => (
              <div key={r.pitch} className={r.black ? 'key black' : 'key'} style={{ height: RH }} onPointerDown={() => preview(r.pitch)}>
                {r.label}
              </div>
            ))}
          </div>
          <div
            className="grid"
            style={{ width: region.length * PPB, ['--ppb' as string]: `${PPB}px` }}
            onPointerDown={addNote}
            onContextMenu={(e) => e.preventDefault()}
          >
            {rows.map((r, i) => r.black && <div key={r.pitch} className="grid-black" style={{ top: i * RH, height: RH }} />)}
            {notes.map((n) => {
              const row = rowOf.get(n.pitch);
              if (row === undefined) return null;
              return (
                <div
                  key={n.id}
                  className={`note ${n.id === selectedNoteId ? 'sel' : ''}`}
                  style={{
                    left: n.start * PPB,
                    top: row * RH + 1,
                    width: Math.max(5, n.duration * PPB - 1),
                    height: RH - 2,
                    background: track.color,
                    opacity: 0.45 + (0.55 * n.velocity) / 127,
                  }}
                  onPointerDown={(e) => dragNote(e, n)}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    removeNote(n.id);
                  }}
                />
              );
            })}
            <div className="playhead" ref={head} />
          </div>
        </div>
      </div>
    </div>
  );
}
