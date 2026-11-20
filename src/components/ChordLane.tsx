import { useEffect, useRef, useState } from 'react';
import { ChordEvent, chordName, parseChord } from '../audio/chords';
import { engine } from '../audio/engine';
import { useStore } from '../store';
import { barBeats, projectEnd, uid } from '../types';

const sortChords = (c: ChordEvent[]) => [...c].sort((a, b) => a.beat - b.beat);
const save = (chords: ChordEvent[], history = true) =>
  useStore.getState().update((p) => ({ ...p, chords: chords.length ? sortChords(chords) : undefined }), history);

/**
 * Trilha de acordes embaixo das seções: cada acorde vale até o próximo. Duplo clique no vazio cria um
 * acorde ali (no compasso; Alt = no tempo), duplo clique num acorde edita a cifra, arrastar move (encaixa
 * no tempo), botão direito apaga, clique leva o cursor até ele.
 */
export function ChordLane({ ppb, beatAt }: { ppb: number; beatAt: (clientX: number) => number }) {
  const project = useStore((s) => s.project);
  const chords = project.chords ?? [];
  const [editing, setEditing] = useState<{ id: string | null; beat: number } | null>(null);
  const [bad, setBad] = useState(false);
  const st = useStore.getState();
  const bb = barBeats(project);
  const songEnd = Math.max(projectEnd(project), bb * 4);

  const commit = (text: string) => {
    if (!editing) return;
    const list = useStore.getState().project.chords ?? [];
    const t = text.trim();
    if (!t) {
      if (editing.id) save(list.filter((c) => c.id !== editing.id));
      setEditing(null);
      return;
    }
    const c = parseChord(t);
    if (!c) {
      setBad(true);
      return;
    }
    if (editing.id) save(list.map((x) => (x.id === editing.id ? { id: x.id, beat: x.beat, ...c } : x)));
    else save([...list.filter((x) => Math.abs(x.beat - editing.beat) > 1e-6), { id: uid(), beat: editing.beat, ...c }]);
    setEditing(null);
  };

  const drag = (e: React.PointerEvent, c: ChordEvent) => {
    if (e.button !== 0 || editing?.id === c.id) return;
    e.preventDefault();
    e.stopPropagation();
    const x0 = e.clientX;
    const off = beatAt(e.clientX) - c.beat;
    let moved = false;
    const move = (ev: PointerEvent) => {
      if (!moved && Math.abs(ev.clientX - x0) < 4) return;
      if (!moved) {
        st.snapshot();
        moved = true;
      }
      const step = ev.altKey ? 0.5 : 1;
      const beat = Math.max(0, Math.round((beatAt(ev.clientX) - off) / step) * step);
      const list = useStore.getState().project.chords ?? [];
      if (!list.some((x) => x.id !== c.id && Math.abs(x.beat - beat) < 1e-6)) save(list.map((x) => (x.id === c.id ? { ...x, beat } : x)), false);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      if (!moved) engine.seek(c.beat);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up, { once: true });
  };

  const editor = (value: string) => (
    <input
      className={`chord-edit ${bad ? 'bad' : ''}`}
      autoFocus
      defaultValue={value}
      placeholder="Am7"
      title="Cifra: C, Am, G7, F7M, Bb, Dm7(b5), C/E… (vazio apaga)"
      onPointerDown={(e) => e.stopPropagation()}
      onFocus={(e) => e.currentTarget.select()}
      onChange={() => setBad(false)}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter') commit(e.currentTarget.value);
        if (e.key === 'Escape') setEditing(null);
      }}
      onBlur={(e) => commit(e.currentTarget.value)}
    />
  );

  return (
    <div
      className="chord-lane"
      onPointerDown={(e) => e.stopPropagation()}
      onDoubleClick={(e) => {
        if (e.target !== e.currentTarget) return;
        const b = beatAt(e.clientX);
        setBad(false);
        setEditing({ id: null, beat: e.altKey ? Math.floor(b) : Math.floor(b / bb + 1e-6) * bb });
      }}
      title="Acordes: duplo clique para escrever um acorde (no compasso; Alt: no tempo). Os loops seguem estes acordes."
    >
      {chords.map((c, i) => {
        const end = chords[i + 1]?.beat ?? Math.max(c.beat + bb, songEnd);
        return (
          <div
            key={c.id}
            className="chord"
            style={{ left: c.beat * ppb, width: Math.max(18, (end - c.beat) * ppb) }}
            onPointerDown={(e) => drag(e, c)}
            onDoubleClick={(e) => {
              e.stopPropagation();
              setBad(false);
              setEditing({ id: c.id, beat: c.beat });
            }}
            onContextMenu={(e) => {
              e.preventDefault();
              save(chords.filter((x) => x.id !== c.id));
            }}
            title={`${chordName(c)}\nClique: ir até o acorde · arrastar: mover (Alt: meio tempo) · duplo clique: editar · botão direito: apagar`}
          >
            {editing?.id === c.id ? editor(chordName(c)) : <span>{chordName(c)}</span>}
          </div>
        );
      })}
      {editing && editing.id === null && (
        <div className="chord new" style={{ left: editing.beat * ppb, width: 90 }}>
          {editor('')}
        </div>
      )}
    </div>
  );
}

/**
 * Ferramentas da trilha de acordes (no canto da régua): escrever uma progressão inteira de uma vez, copiar
 * os acordes de um loop e limpar.
 */
export function ChordTools() {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('C Am F G');
  const [len, setLen] = useState(1); // compassos por acorde
  const [times, setTimes] = useState(1);
  const [err, setErr] = useState('');
  const box = useRef<HTMLDivElement>(null);
  const hasChords = useStore((s) => !!s.project.chords?.length);
  const sel = useStore((s) => s.project.regions.find((r) => r.id === s.selectedRegionId && r.harmony));

  useEffect(() => {
    if (!open) return;
    const down = (e: PointerEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
    window.addEventListener('pointerdown', down, true);
    return () => window.removeEventListener('pointerdown', down, true);
  }, [open]);

  /** Escreve acordes de `start` em diante, trocando os que havia nesse trecho. */
  const write = (list: Omit<ChordEvent, 'id'>[], start: number, end: number) => {
    const old = useStore.getState().project.chords ?? [];
    save([...old.filter((c) => c.beat < start - 1e-6 || c.beat >= end - 1e-6), ...list.map((c) => ({ ...c, id: uid() }))]);
  };

  const writeProgression = () => {
    const tokens = text.split(/[\s|,]+/).filter(Boolean);
    const parsed = tokens.map(parseChord);
    const wrong = tokens.filter((_, i) => !parsed[i]);
    if (!tokens.length || wrong.length) {
      setErr(wrong.length ? `Não entendi: ${wrong.join(', ')}` : 'Escreva os acordes separados por espaço.');
      return;
    }
    const p = useStore.getState().project;
    const bb = barBeats(p);
    const step = len * bb;
    const start = Math.floor(engine.getBeat() / bb + 1e-6) * bb;
    const list: Omit<ChordEvent, 'id'>[] = [];
    for (let t = 0; t < times; t++) parsed.forEach((c, i) => list.push({ beat: start + (t * parsed.length + i) * step, ...c! }));
    write(list, start, start + list.length * step);
    setErr('');
    setOpen(false);
  };

  /** Os acordes do loop selecionado (a harmonia em que ele foi escrito), no trecho dele. */
  const copyFromRegion = () => {
    if (!sel?.harmony) return;
    const h = sel.harmony;
    const list: Omit<ChordEvent, 'id'>[] = [];
    for (let base = -(h.offset ?? 0); base < sel.length; base += h.period) {
      for (const c of h.chords) {
        const beat = base + c.at;
        if (beat >= 0 && beat < sel.length) list.push({ beat: sel.start + beat, root: c.root, q: c.q });
      }
    }
    if (!list.some((c) => Math.abs(c.beat - sel.start) < 1e-6)) {
      const first = [...h.chords].reverse().find((c) => c.at <= (h.offset ?? 0) % h.period) ?? h.chords[h.chords.length - 1];
      list.unshift({ beat: sel.start, root: first.root, q: first.q });
    }
    write(list, sel.start, sel.start + sel.length);
    setOpen(false);
  };

  return (
    <div className="chord-tools" ref={box}>
      <button title="Escrever uma progressão de acordes de uma vez" onClick={() => setOpen(!open)}>Progressão…</button>
      {open && (
        <div className="chord-pop" role="dialog" aria-label="Progressão de acordes">
          <label>
            Acordes
            <input
              autoFocus
              value={text}
              onChange={(e) => {
                setText(e.target.value);
                setErr('');
              }}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === 'Enter') writeProgression();
                if (e.key === 'Escape') setOpen(false);
              }}
              placeholder="C Am F G"
            />
          </label>
          <div className="chord-pop-row">
            <select value={len} onChange={(e) => setLen(+e.target.value)}>
              <option value={0.5}>meio compasso cada</option>
              <option value={1}>1 compasso cada</option>
              <option value={2}>2 compassos cada</option>
              <option value={4}>4 compassos cada</option>
            </select>
            <select value={times} onChange={(e) => setTimes(+e.target.value)}>
              {[1, 2, 3, 4, 8].map((n) => <option key={n} value={n}>{n === 1 ? 'uma vez' : `${n} vezes`}</option>)}
            </select>
          </div>
          {err && <small className="warn">{err}</small>}
          <small className="hint">A partir do compasso do cursor. Cifras: C, Am, G7, F7M, Bb, Dm7(b5), C/E…</small>
          <div className="chord-pop-row">
            <button className="primary" onClick={writeProgression}>Escrever</button>
            <button disabled={!sel} title={sel ? 'Escreve os acordes em que o loop selecionado foi composto, no trecho dele' : 'Selecione uma região de loop (baixo, acordes ou melodia) na timeline'} onClick={copyFromRegion}>
              Copiar do loop
            </button>
            <button disabled={!hasChords} title="Apagar todos os acordes (os loops voltam a tocar como foram escritos)" onClick={() => { save([]); setOpen(false); }}>
              Limpar
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
