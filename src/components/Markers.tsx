import { useState } from 'react';
import { engine } from '../audio/engine';
import { useStore } from '../store';
import { BEATS_PER_BAR, Marker, Project, SECTION_NAMES, projectEnd, sectionColor } from '../types';

/** Fim da seção que começa no marcador `i`: o próximo marcador, ou o fim da música (mín. 4 compassos). */
export function sectionEnd(p: Project, i: number): number {
  const list = p.markers ?? [];
  const next = list[i + 1];
  if (next) return next.beat;
  const end = Math.ceil(projectEnd(p) / BEATS_PER_BAR) * BEATS_PER_BAR;
  return Math.max(end, list[i].beat + 4 * BEATS_PER_BAR);
}

/** Pula o cursor para o próximo (dir = 1) ou o anterior (dir = -1) marcador. */
export function jumpMarker(dir: 1 | -1) {
  const list = useStore.getState().project.markers ?? [];
  const b = engine.getBeat();
  // para trás, com uma folga de meio tempo: apertar logo depois de passar um marcador vai para o de antes
  const m = dir > 0 ? list.find((x) => x.beat > b + 0.01) : [...list].reverse().find((x) => x.beat < b - 0.5);
  if (m) engine.seek(m.beat);
  else if (dir < 0) engine.seek(0);
}

/** Liga o loop exatamente na seção do marcador. */
export function loopSection(id: string) {
  const s = useStore.getState();
  const i = (s.project.markers ?? []).findIndex((m) => m.id === id);
  if (i < 0) return;
  const start = s.project.markers![i].beat;
  s.update((p) => ({ ...p, loop: { start, end: sectionEnd(p, i), on: true } }));
  engine.seek(start);
}

/**
 * Faixa de seções embaixo da régua: cada marcador é uma bandeira colorida que vai até o próximo.
 * Clique pula para a seção, arrastar move (encaixa no compasso; Alt = no tempo), duplo clique renomeia,
 * duplo clique no vazio cria um marcador ali.
 */
export function MarkerLane({ ppb, beatAt }: { ppb: number; beatAt: (clientX: number) => number }) {
  const project = useStore((s) => s.project);
  const [editing, setEditing] = useState<string | null>(null);
  const markers = project.markers ?? [];
  const st = useStore.getState();

  const drag = (e: React.PointerEvent, m: Marker) => {
    if (e.button !== 0 || editing === m.id) return;
    e.preventDefault();
    e.stopPropagation();
    const x0 = e.clientX;
    const off = beatAt(e.clientX) - m.beat;
    let moved = false;
    const move = (ev: PointerEvent) => {
      if (!moved && Math.abs(ev.clientX - x0) < 4) return;
      if (!moved) {
        st.snapshot();
        moved = true;
      }
      const step = ev.altKey ? 1 : BEATS_PER_BAR;
      const beat = Math.max(0, Math.round((beatAt(ev.clientX) - off) / step) * step);
      const others = (useStore.getState().project.markers ?? []).filter((x) => x.id !== m.id);
      if (!others.some((x) => Math.abs(x.beat - beat) < 1e-6)) st.updateMarker(m.id, { beat }, false);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      if (!moved) engine.seek(m.beat);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up, { once: true });
  };

  return (
    <div
      className="markers"
      onPointerDown={(e) => e.stopPropagation()}
      onDoubleClick={(e) => {
        if (e.target === e.currentTarget) st.addMarker(beatAt(e.clientX));
      }}
      title="Seções: duplo clique para criar um marcador (ou tecla M no cursor)"
    >
      {markers.map((m, i) => {
        const w = (sectionEnd(project, i) - m.beat) * ppb;
        return (
          <div
            key={m.id}
            className="marker"
            style={{ left: m.beat * ppb, width: w, ['--c' as string]: sectionColor(m.name) }}
            onPointerDown={(e) => drag(e, m)}
            onDoubleClick={(e) => {
              e.stopPropagation();
              setEditing(m.id);
            }}
            title={`${m.name} · compasso ${m.beat / BEATS_PER_BAR + 1}\nClique: ir para a seção · arrastar: mover (Alt: no tempo) · duplo clique: renomear`}
          >
            {editing === m.id ? (
              <input
                className="marker-edit"
                autoFocus
                defaultValue={m.name}
                list="section-names"
                maxLength={40}
                onPointerDown={(e) => e.stopPropagation()}
                onFocus={(e) => e.currentTarget.select()}
                onKeyDown={(e) => {
                  e.stopPropagation();
                  if (e.key === 'Enter') e.currentTarget.blur();
                  if (e.key === 'Escape') {
                    e.currentTarget.value = m.name;
                    e.currentTarget.blur();
                  }
                }}
                onBlur={(e) => {
                  const name = e.currentTarget.value.trim();
                  if (name && name !== m.name) st.updateMarker(m.id, { name });
                  setEditing(null);
                }}
              />
            ) : (
              <span className="marker-name">{m.name}</span>
            )}
            <span className="marker-tools">
              <button
                title="Repetir esta seção (loop)"
                onPointerDown={(e) => e.stopPropagation()}
                onClick={() => loopSection(m.id)}
              >
                ⟳
              </button>
              <button title="Apagar o marcador" onPointerDown={(e) => e.stopPropagation()} onClick={() => st.removeMarker(m.id)}>
                ×
              </button>
            </span>
          </div>
        );
      })}
      <datalist id="section-names">
        {SECTION_NAMES.map((n) => <option key={n} value={n} />)}
      </datalist>
    </div>
  );
}

/** Linhas finas dos marcadores atravessando as trilhas. */
export function MarkerLines({ ppb, left }: { ppb: number; left: number }) {
  const markers = useStore((s) => s.project.markers) ?? [];
  return (
    <>
      {markers.map((m) => (
        <div key={m.id} className="marker-line" style={{ left: left + m.beat * ppb, ['--c' as string]: sectionColor(m.name) }} />
      ))}
    </>
  );
}
