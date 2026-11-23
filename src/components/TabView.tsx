import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { engine } from '../audio/engine';
import { playedNotes } from '../audio/arp';
import { ChordEvent, chordAt, chordName } from '../audio/chords';
import { TUNINGS, Tuning, tuningOf } from '../audio/tuner';
import { asciiTab, chordShape, fingering, stringLabel } from '../audio/tab';
import { pref, savePref, useStore } from '../store';
import { Project, TabNote, TabTech, Tablature, barBeats, projectEnd, uid } from '../types';

const BASS_INSTR = new Set(['ebass', 'dbass', 'bass']);

/** Acordes da música: a trilha de acordes ou, sem ela, os acordes em que os loops foram escritos. */
function songChords(p: Project): { chords: ChordEvent[]; fromLoops: boolean } {
  if (p.chords?.length) return { chords: p.chords, fromLoops: false };
  const out: ChordEvent[] = [];
  const bb = barBeats(p);
  const end = projectEnd(p);
  for (let beat = 0; beat < end; beat += bb / 2) {
    const r = p.regions.find((x) => x.harmony && beat >= x.start && beat < x.start + x.length);
    if (!r?.harmony) continue;
    const h = r.harmony;
    const t = (((beat - r.start + (h.offset ?? 0)) % h.period) + h.period) % h.period;
    let c = h.chords[h.chords.length - 1];
    for (const x of h.chords) if (x.at <= t + 1e-6) c = x;
    const last = out[out.length - 1];
    if (!last || last.root !== c.root || last.q !== c.q) out.push({ id: `${beat}`, beat, root: c.root, q: c.q });
  }
  return { chords: out, fromLoops: true };
}

/** Seções da música (marcadores) com início e fim. */
function sections(p: Project, total: number) {
  const m = p.markers ?? [];
  if (!m.length) return [{ name: 'Música', start: 0, end: total }];
  const out = m.map((x, i) => ({ name: x.name, start: x.beat, end: m[i + 1]?.beat ?? total }));
  if (out[0].start > 0) out.unshift({ name: 'Início', start: 0, end: out[0].start });
  return out;
}

/** Aba Tablatura & Cifra: o editor de tablaturas do usuário, ou a cifra da música com os desenhos dos acordes. */
export function TabView() {
  const [mode, setMode] = useState<'tab' | 'chart'>(() => (pref('mm.tabMode') === 'chart' ? 'chart' : 'tab'));
  const choose = (m: 'tab' | 'chart') => {
    setMode(m);
    savePref('mm.tabMode', m);
  };
  const seg = (
    <div className="seg">
      <button className={mode === 'tab' ? 'on' : ''} onClick={() => choose('tab')}>Tablatura</button>
      <button className={mode === 'chart' ? 'on' : ''} onClick={() => choose('chart')}>Cifra</button>
    </div>
  );
  if (mode === 'tab') return <TabEditor seg={seg} />;
  return (
    <div className="tabview">
      <div className="roll-bar">
        {seg}
        <ChartControls />
      </div>
      <div className="tab-scroll print-area"><ChordChart /></div>
    </div>
  );
}

// ---------- editor de tablatura ----------

/** Durações oferecidas (em tempos = semínimas). */
const DURS: { d: number; label: string; name: string }[] = [
  { d: 4, label: '1', name: 'Semibreve (4 tempos)' },
  { d: 2, label: '1/2', name: 'Mínima (2 tempos)' },
  { d: 1, label: '1/4', name: 'Semínima (1 tempo)' },
  { d: 0.5, label: '1/8', name: 'Colcheia (½ tempo)' },
  { d: 0.25, label: '1/16', name: 'Semicolcheia (¼ de tempo)' },
  { d: 0.125, label: '1/32', name: 'Fusa (⅛ de tempo)' },
];

/** Técnicas: tecla, marca na tablatura e nome. */
const TECHS: { t: TabTech; key: string; mark: string; name: string }[] = [
  { t: 'h', key: 'H', mark: 'h', name: 'Hammer-on (ligado para cima)' },
  { t: 'p', key: 'P', mark: 'p', name: 'Pull-off (ligado para baixo)' },
  { t: '/', key: '/', mark: '/', name: 'Slide subindo' },
  { t: '\\', key: '\\', mark: '\\', name: 'Slide descendo' },
  { t: 'b', key: 'B', mark: 'b', name: 'Bend (puxar a corda 1 tom)' },
  { t: '~', key: 'V', mark: '~', name: 'Vibrato' },
  { t: 'pm', key: 'M', mark: '', name: 'Palm mute (abafado com a mão)' },
];
const markOf = (t?: TabTech) => (t ? TECHS.find((x) => x.t === t)?.mark ?? '' : '');

const MAX_FRET = 24;
const EPS = 1e-6;
const same = (a: number, b: number) => Math.abs(a - b) < EPS;

const isBass = (t: Tuning) => t.group === 'Baixo';
const instrumentOf = (t: Tuning) => (isBass(t) ? 'ebass' : 'guitar');
const tuningsWithStrings = TUNINGS.filter((t) => t.strings.length);

/** Troca uma tablatura do projeto (com passo de desfazer, a não ser que `history` seja false). */
function updateTab(id: string, fn: (t: Tablature) => Tablature, history = true) {
  useStore.getState().update((p) => ({ ...p, tabs: (p.tabs ?? []).map((t) => (t.id === id ? fn(t) : t)) }), history);
}

function newTablature(p: Project, patch: Partial<Tablature> = {}): Tablature {
  const n = (p.tabs?.length ?? 0) + 1;
  return { id: uid(), name: `Tablatura ${n}`, tuning: 'gtr', bars: 4, notes: [], ...patch };
}

/** Notas MIDI de uma tablatura (para ouvir ou levar para uma trilha). Notas mortas não soam. */
function tabPitches(tab: Tablature) {
  const strings = tuningOf(tab.tuning).strings;
  return tab.notes
    .filter((n) => n.fret >= 0 && n.string < strings.length)
    .map((n) => ({
      pitch: strings[n.string] + n.fret + (n.tech === 'b' ? 2 : 0),
      start: n.beat,
      duration: n.tech === 'pm' ? Math.min(n.duration, 0.25) : n.duration,
      velocity: n.tech === 'pm' ? 80 : n.tech === 'h' || n.tech === 'p' ? 85 : 100,
    }));
}

/** Uma trilha MIDI virando tablatura: cada nota na corda e casa mais tocável. */
function tabFromTrack(p: Project, trackId: string): Tablature | null {
  const track = p.tracks.find((t) => t.id === trackId);
  if (!track) return null;
  const tuning = tuningOf(BASS_INSTR.has(track.instrument) ? 'bass' : 'gtr');
  // sem o toque humano: a tablatura mostra o ritmo escrito
  const t = { ...track, feel: 0 };
  const notes = p.regions
    .filter((r) => r.trackId === track.id && r.notes?.length)
    .flatMap((r) =>
      playedNotes(r, t, p.bpm, p.chords)
        .filter((n) => n.start < r.length)
        .map((n) => ({ pitch: n.pitch, start: r.start + n.start, duration: Math.min(n.duration, r.length - n.start) })),
    );
  const q = (x: number) => Math.round(x * 8) / 8; // grade de fusas
  const frets = fingering(notes, tuning.strings, isBass(tuning) ? 20 : 22);
  const bb = barBeats(p);
  const end = Math.max(0, ...notes.map((n) => n.start + n.duration));
  return newTablature(p, {
    name: track.name,
    tuning: tuning.id,
    bars: Math.max(1, Math.ceil(end / bb - EPS)),
    notes: frets.map((f) => ({ id: uid(), beat: q(f.start), string: f.string, fret: f.fret, duration: Math.max(0.125, q(f.duration)) })),
  });
}

/** Tablatura em texto (para colar em mensagem, e-mail, site de cifras…). */
function tabText(p: Project, tab: Tablature, per: number): string {
  const tuning = tuningOf(tab.tuning);
  const bb = barBeats(p);
  const notes = tab.notes
    .filter((n) => n.string < tuning.strings.length)
    .map((n) => ({ start: n.beat, string: n.string, fret: n.fret, mark: markOf(n.tech) }));
  const labels = [
    ...tab.notes.filter((n) => n.tech === 'pm').map((n) => ({ beat: n.beat, text: 'PM' })),
    ...songChords(p).chords.filter((c) => c.beat < tab.bars * bb).map((c) => ({ beat: c.beat, text: chordName(c) })),
  ];
  const head = `${p.name || 'Música'} — ${tab.name}\nAfinação: ${tuning.name} · ${p.bpm} BPM\n\n`;
  return head + asciiTab(notes, tuning.strings, bb, tab.bars, per, labels);
}

async function copy(text: string) {
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
}

/** Compasso copiado (notas com o tempo relativo ao começo dele). */
let barClipboard: Omit<TabNote, 'id'>[] | null = null;

/** Px por tempo: mais largo quando há notas curtas, para as casas não se encostarem. */
function beatWidth(tab: Tablature, step: number) {
  const grid = (v: number) => (Math.abs(v * 4 - Math.round(v * 4)) > EPS ? 0.125 : Math.abs(v * 2 - Math.round(v * 2)) > EPS ? 0.25 : Math.abs(v - Math.round(v)) > EPS ? 0.5 : 1);
  const finest = Math.min(grid(step), step, ...tab.notes.flatMap((x) => [grid(x.beat), x.duration]));
  return finest < 0.25 - EPS ? 184 : finest < 0.5 - EPS ? 108 : 72;
}
const LINE = 16; // px entre cordas
const LEFT = 26;
const TOP = 36;

type Cursor = { beat: number; string: number };

function TabEditor({ seg }: { seg: React.ReactNode }) {
  const project = useStore((s) => s.project);
  const tabs = project.tabs ?? [];
  const [selId, setSelId] = useState(() => pref('mm.tabSel'));
  const tab = tabs.find((t) => t.id === selId) ?? tabs[0];
  const select = (id: string) => {
    setSelId(id);
    savePref('mm.tabSel', id);
  };
  const [cursor, setCursor] = useState<Cursor>({ beat: 0, string: 0 });
  const [dur, setDurState] = useState(() => +(pref('mm.tabDur') ?? 0.5) || 0.5);
  const [dotted, setDotted] = useState(false);
  const [per, setPer] = useState(() => +(pref('mm.tabBars') ?? 4) || 4);
  const [head, setHead] = useState<number | null>(null); // tempo tocando (prévia), ou null
  const [playing, setPlaying] = useState(false);
  const playRef = useRef<{ raf: number } | null>(null);
  const digit = useRef<{ at: number; key: string; val: number } | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const [importId, setImportId] = useState('');

  const tuning = tuningOf(tab?.tuning);
  const strings = tuning.strings;
  const n = strings.length;
  const bb = barBeats(project);
  const step = dur * (dotted ? 1.5 : 1);
  const st = useStore.getState;

  // cursor sempre dentro da tablatura (troca de tablatura, de afinação, desfazer…)
  const cur: Cursor = tab
    ? { beat: Math.max(0, Math.min(cursor.beat, tab.bars * bb - step)), string: Math.min(cursor.string, n - 1) }
    : cursor;

  const playable = project.tracks.filter((t) => t.kind === 'instrument' && project.regions.some((r) => r.trackId === t.id && r.notes?.length));

  // cursor visível ao andar com as setas
  useEffect(() => {
    boxRef.current?.querySelector('.tab-cursor')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [cur.beat, cur.string, tab?.id]);

  // para a prévia ao sair da aba
  useEffect(() => () => stopPlay(), []);

  function stopPlay() {
    if (playRef.current) cancelAnimationFrame(playRef.current.raf);
    playRef.current = null;
    engine.stopPreview();
    setHead(null);
    setPlaying(false);
  }

  async function play() {
    if (!tab) return;
    if (playRef.current) return stopPlay();
    const from = Math.floor(cur.beat / bb) * bb; // do começo do compasso do cursor
    const end = tab.bars * bb;
    const notes = tabPitches(tab)
      .filter((x) => x.start >= from - EPS)
      .map((x) => ({ ...x, start: x.start - from }));
    playRef.current = { raf: 0 };
    setPlaying(true);
    await engine.previewNotes('instrument', instrumentOf(tuning), notes);
    if (!playRef.current) return; // parou enquanto carregava
    const t0 = performance.now() + 50;
    const spb = 60 / project.bpm;
    const tick = () => {
      if (!playRef.current) return;
      const b = from + Math.max(0, (performance.now() - t0) / 1000 / spb);
      if (b >= end) return stopPlay();
      setHead(b);
      playRef.current.raf = requestAnimationFrame(tick);
    };
    tick();
  }

  const setDur = (d: number, dot = dotted) => {
    setDurState(d);
    setDotted(dot);
    savePref('mm.tabDur', String(d));
    // com notas no cursor, muda a duração delas também (o acorde inteiro)
    if (tab && tab.notes.some((x) => same(x.beat, cur.beat))) {
      updateTab(tab.id, (t) => ({ ...t, notes: t.notes.map((x) => (same(x.beat, cur.beat) ? { ...x, duration: d * (dot ? 1.5 : 1) } : x)) }));
    }
  };

  const noteAt = (c: Cursor) => tab?.notes.find((x) => x.string === c.string && same(x.beat, c.beat));

  /** Ouve uma nota (ao escrever). */
  const audition = (string: number, fret: number) => {
    if (playRef.current || fret < 0) return;
    void engine.previewNotes('instrument', instrumentOf(tuning), [{ pitch: strings[string] + fret, start: 0, duration: 1, velocity: 100 }]);
  };

  const writeFret = (fret: number) => {
    if (!tab) return;
    const old = noteAt(cur);
    // na mesma coluna de um acorde, a nota nova fica com a duração dele
    const col = tab.notes.find((x) => same(x.beat, cur.beat));
    const note: TabNote = { id: old?.id ?? uid(), beat: cur.beat, string: cur.string, fret, duration: old?.duration ?? col?.duration ?? step, tech: old?.tech };
    updateTab(tab.id, (t) => ({ ...t, notes: [...t.notes.filter((x) => x !== old), note] }));
    audition(cur.string, fret);
  };

  const toggleTech = (tech: TabTech) => {
    const old = noteAt(cur);
    if (!tab || !old) return;
    updateTab(tab.id, (t) => ({ ...t, notes: t.notes.map((x) => (x === old ? { ...x, tech: x.tech === tech ? undefined : tech } : x)) }));
  };

  const removeNote = () => {
    const old = noteAt(cur);
    if (tab && old) updateTab(tab.id, (t) => ({ ...t, notes: t.notes.filter((x) => x !== old) }));
  };

  /** Anda o cursor; passando do fim, ganha um compasso novo. */
  const moveTo = (beat: number, string = cur.string) => {
    if (!tab) return;
    beat = Math.max(0, Math.round(beat * 8) / 8);
    if (beat >= tab.bars * bb - EPS) {
      const bars = Math.floor(beat / bb) + 1;
      updateTab(tab.id, (t) => ({ ...t, bars: Math.max(t.bars, bars) }), false);
    }
    setCursor({ beat, string: Math.max(0, Math.min(n - 1, string)) });
  };

  const right = () => {
    // pula a duração do que está escrito no cursor (o acorde inteiro), ou um passo da duração escolhida
    const here = tab?.notes.filter((x) => same(x.beat, cur.beat)) ?? [];
    moveTo(cur.beat + (here.length ? Math.max(...here.map((x) => x.duration)) : step));
  };
  const left = () => {
    if (!tab) return;
    // uma nota que começa antes e soa até o cursor: volta para o começo dela (o contrário de `right`)
    const covering = tab.notes.filter((x) => x.beat < cur.beat - EPS && x.beat + x.duration >= cur.beat - EPS);
    moveTo(covering.length ? Math.max(...covering.map((x) => x.beat)) : cur.beat - step);
  };

  const barStart = Math.floor(cur.beat / bb + EPS) * bb;

  const insertBar = () => {
    if (!tab) return;
    updateTab(tab.id, (t) => ({ ...t, bars: t.bars + 1, notes: t.notes.map((x) => (x.beat >= barStart - EPS ? { ...x, beat: x.beat + bb } : x)) }));
  };
  const deleteBar = () => {
    if (!tab) return;
    if (tab.bars <= 1) {
      updateTab(tab.id, (t) => ({ ...t, notes: [] }));
      return;
    }
    updateTab(tab.id, (t) => ({
      ...t,
      bars: t.bars - 1,
      notes: t.notes
        .filter((x) => x.beat < barStart - EPS || x.beat >= barStart + bb - EPS)
        .map((x) => (x.beat >= barStart + bb - EPS ? { ...x, beat: x.beat - bb } : x)),
    }));
  };
  const copyBar = () => {
    if (!tab) return;
    barClipboard = tab.notes
      .filter((x) => x.beat >= barStart - EPS && x.beat < barStart + bb - EPS)
      .map(({ id: _id, ...x }) => ({ ...x, beat: x.beat - barStart }));
  };
  const pasteBar = () => {
    if (!tab || !barClipboard) return;
    const clip = barClipboard;
    updateTab(tab.id, (t) => ({
      ...t,
      bars: Math.max(t.bars, Math.floor(barStart / bb) + 1),
      notes: [
        ...t.notes.filter((x) => x.beat < barStart - EPS || x.beat >= barStart + bb - EPS),
        ...clip.filter((x) => x.string < n).map((x) => ({ ...x, id: uid(), beat: x.beat + barStart })),
      ],
    }));
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!tab) return;
    const k = e.key;
    const ctrl = e.ctrlKey || e.metaKey;
    let handled = true;
    if (ctrl) {
      const kl = k.toLowerCase();
      if (kl === 'c') copyBar();
      else if (kl === 'v') pasteBar();
      else if (k === 'ArrowRight') moveTo(barStart + bb);
      else if (k === 'ArrowLeft') moveTo(cur.beat > barStart + EPS ? barStart : barStart - bb);
      else handled = false; // Ctrl+Z, Ctrl+S… ficam com o app
    } else if (/^[0-9]$/.test(k)) {
      const d = +k;
      const key = `${cur.beat}:${cur.string}`;
      const prev = digit.current;
      // dois dígitos seguidos no mesmo lugar formam a casa (1 e 2 = casa 12)
      if (prev && prev.key === key && performance.now() - prev.at < 900 && prev.val * 10 + d <= MAX_FRET) {
        writeFret(prev.val * 10 + d);
        digit.current = null;
      } else {
        writeFret(d);
        digit.current = { at: performance.now(), key, val: d };
      }
    } else if (k === 'ArrowRight') right();
    else if (k === 'ArrowLeft') left();
    else if (k === 'ArrowUp') moveTo(cur.beat, cur.string + 1);
    else if (k === 'ArrowDown') moveTo(cur.beat, cur.string - 1);
    else if (k === 'Home') moveTo(0);
    else if (k === 'End') moveTo(Math.max(0, tab.bars * bb - step));
    else if (k === 'Delete' || k === 'Backspace') removeNote();
    else if (k === 'x' || k === 'X') writeFret(-1);
    else if (k === ' ') void play();
    else if (k === '+' || k === '=') {
      const i = DURS.findIndex((x) => x.d === dur);
      if (i > 0) setDur(DURS[i - 1].d);
    } else if (k === '-') {
      const i = DURS.findIndex((x) => x.d === dur);
      if (i >= 0 && i < DURS.length - 1) setDur(DURS[i + 1].d);
    } else if (k === '.') setDur(dur, !dotted);
    else if (k === 'Escape') (e.currentTarget as HTMLElement).blur();
    else {
      const t = TECHS.find((x) => x.key === k.toUpperCase());
      if (t) toggleTech(t.t);
      else handled = false;
    }
    if (handled) {
      e.preventDefault();
      e.stopPropagation(); // não chega aos atalhos do app (teclado musical, marcadores…)
    }
  };

  const onPick = (beat: number, string: number) => {
    // clique: na nota, se houver uma ali; senão, na grade da duração escolhida
    const hit = tab?.notes.find((x) => x.string === string && beat >= x.beat - EPS && beat < x.beat + Math.max(step, 0.25) - EPS);
    setCursor({ beat: hit ? hit.beat : Math.max(0, Math.floor(beat / step + EPS) * step), string });
    digit.current = null;
    boxRef.current?.focus();
  };

  // as linhas são memorizadas (a marca de reprodução redesenha a cada quadro): clique e rótulos estáveis
  const pickRef = useRef(onPick);
  pickRef.current = onPick;
  const stablePick = useCallback((beat: number, string: number) => pickRef.current(beat, string), []);
  const labels = useMemo(() => (tab ? tabLabelsFor(project, tab) : []), [project.markers, project.chords, project.regions, project.meter, tab]);

  const create = (t: Tablature) => {
    st().update((p) => ({ ...p, tabs: [...(p.tabs ?? []), t] }));
    select(t.id);
    setCursor({ beat: 0, string: 0 });
    setTimeout(() => boxRef.current?.focus(), 0);
  };

  const importSelect = (
    <label>
      Gerar de uma trilha
      <select
        value={importId}
        onChange={(e) => {
          const t = e.target.value && tabFromTrack(st().project, e.target.value);
          setImportId('');
          if (t) create(t);
        }}
        disabled={!playable.length}
        title="Cria uma tablatura com as notas de uma trilha MIDI do projeto, em cordas e casas tocáveis (dá para editar depois)"
      >
        <option value="">{playable.length ? 'Escolha…' : 'Nenhuma trilha com notas'}</option>
        {playable.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
      </select>
    </label>
  );

  if (!tab) {
    return (
      <div className="tabview">
        <div className="roll-bar">{seg}</div>
        <div className="tab-scroll">
          <div className="tab-empty">
            <h2>Editor de tablatura</h2>
            <p>Escreva as tablaturas das suas músicas: escolha a afinação, clique numa corda e digite a casa.</p>
            <div className="tab-empty-actions">
              <button className="primary" onClick={() => create(newTablature(project))}>+ Nova tablatura</button>
              {importSelect}
            </div>
          </div>
        </div>
      </div>
    );
  }

  const here = noteAt(cur);
  const beatW = beatWidth(tab, step);
  const lines = [];
  for (let b0 = 0; b0 < tab.bars; b0 += per) {
    const b1 = Math.min(tab.bars, b0 + per);
    const inLine = (beat: number) => beat >= b0 * bb - EPS && beat < b1 * bb - EPS;
    lines.push(
      <TabLine
        key={b0}
        b0={b0}
        b1={b1}
        bb={bb}
        beatW={beatW}
        strings={strings}
        notes={tab.notes}
        labels={labels}
        cursor={inLine(cur.beat) ? cur : null}
        cursorW={Math.max(step, here?.duration ?? 0)}
        head={head !== null && inLine(head) ? head : null}
        onPick={stablePick}
      />,
    );
  }

  return (
    <div className="tabview">
      <div className="roll-bar">
        {seg}
        <label>
          Tablatura
          <select value={tab.id} onChange={(e) => select(e.target.value)}>
            {tabs.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
        </label>
        <button title="Nova tablatura em branco" onClick={() => create(newTablature(project, { tuning: tab.tuning }))}>+ Nova</button>
        <button
          title="Renomear esta tablatura"
          onClick={() => {
            const name = prompt('Nome da tablatura', tab.name)?.trim();
            if (name) updateTab(tab.id, (t) => ({ ...t, name }));
          }}
        >
          Renomear
        </button>
        <button
          title="Apagar esta tablatura (dá para desfazer com Ctrl+Z)"
          onClick={() => confirm(`Apagar a tablatura "${tab.name}"?`) && st().update((p) => ({ ...p, tabs: (p.tabs ?? []).filter((t) => t.id !== tab.id) }))}
        >
          Apagar
        </button>
        <label>
          Afinação
          <select
            value={tuning.id}
            onChange={(e) => {
              const nt = tuningOf(e.target.value);
              // menos cordas: as notas das cordas que sumiram saem
              updateTab(tab.id, (t) => ({ ...t, tuning: nt.id, notes: t.notes.filter((x) => x.string < nt.strings.length) }));
            }}
          >
            {[...new Set(tuningsWithStrings.map((t) => t.group))].map((g) => (
              <optgroup key={g} label={g}>
                {tuningsWithStrings.filter((t) => t.group === g).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </optgroup>
            ))}
          </select>
        </label>
        {importSelect}
      </div>
      <div className="roll-bar tab-tools">
        <button className={`play ${playing ? 'on' : ''}`} title="Ouvir a partir do compasso do cursor (Espaço, com a tablatura selecionada)" onClick={() => void play()}>
          {playing ? '■ Parar' : '▶ Ouvir'}
        </button>
        <div className="seg" title="Duração das notas (+ e − mudam; . pontua)">
          {DURS.map((x) => (
            <button key={x.d} className={dur === x.d ? 'on' : ''} title={x.name} onClick={() => setDur(x.d)}>{x.label}</button>
          ))}
          <button className={dotted ? 'on' : ''} title="Pontuada: dura metade a mais (tecla .)" onClick={() => setDur(dur, !dotted)}>•</button>
        </div>
        <div className="seg" title="Técnicas da nota no cursor">
          {TECHS.map((x) => (
            <button key={x.t} className={here?.tech === x.t ? 'on' : ''} disabled={!here} title={`${x.name} — tecla ${x.key}`} onClick={() => toggleTech(x.t)}>
              {x.t === 'pm' ? 'PM' : x.mark}
            </button>
          ))}
          <button className={here?.fret === -1 ? 'on' : ''} title="Nota morta (abafada, sem altura) — tecla X" onClick={() => writeFret(-1)}>x</button>
        </div>
        <div className="seg">
          <button title="Inserir um compasso vazio antes do compasso do cursor" onClick={insertBar}>+ Compasso</button>
          <button title="Apagar o compasso do cursor" onClick={deleteBar}>− Compasso</button>
          <button title="Copiar o compasso do cursor (Ctrl+C)" onClick={copyBar}>Copiar</button>
          <button title="Colar no compasso do cursor (Ctrl+V)" onClick={pasteBar}>Colar</button>
        </div>
        <label>
          Compassos por linha
          <select
            value={per}
            onChange={(e) => {
              setPer(+e.target.value);
              savePref('mm.tabBars', e.target.value);
            }}
          >
            {[1, 2, 3, 4, 6, 8].map((x) => <option key={x} value={x}>{x}</option>)}
          </select>
        </label>
        <span className="tab-spacer" />
        <button
          title="Cria uma trilha MIDI com esta tablatura (guitarra ou baixo), para tocar junto com a música e passar pelo amp"
          disabled={!tab.notes.some((x) => x.fret >= 0)}
          onClick={() => {
            const s = st();
            const track = s.addTrack('instrument', { name: tab.name, instrument: instrumentOf(tuning) });
            s.addRegion({ trackId: track.id, name: tab.name, start: 0, length: tab.bars * bb, notes: tabPitches(tab).map((x) => ({ ...x, id: uid() })) });
          }}
        >
          Criar trilha
        </button>
        <button title="Copiar a tablatura como texto (para colar em mensagem, e-mail, site de cifras…)" onClick={() => void copy(tabText(project, tab, per))}>Copiar texto</button>
        <button title="Imprimir (ou salvar em PDF pela janela de impressão)" onClick={() => window.print()}>Imprimir</button>
      </div>
      <div className="tab-scroll print-area">
        <div className="tab-sheet tab-editor" ref={boxRef} tabIndex={0} onKeyDown={onKeyDown}>
          <h2>{project.name || 'Música'} <small>— {tab.name} · {tuning.name} · {project.bpm} BPM</small></h2>
          <p className="tab-help">
            Clique numa corda e digite a casa (0–24) · <kbd>←</kbd><kbd>→</kbd> anda · <kbd>↑</kbd><kbd>↓</kbd> troca de corda · <kbd>Del</kbd> apaga ·{' '}
            <kbd>X</kbd> nota morta · <kbd>H</kbd> <kbd>P</kbd> <kbd>/</kbd> <kbd>\</kbd> <kbd>B</kbd> <kbd>V</kbd> <kbd>M</kbd> técnicas · <kbd>+</kbd><kbd>−</kbd> duração ·{' '}
            <kbd>Espaço</kbd> ouvir
          </p>
          {lines}
        </div>
      </div>
    </div>
  );
}

/** Rótulos por cima da tablatura: seções e acordes do projeto (o tempo 0 da tablatura é o começo da música). */
function tabLabelsFor(p: Project, tab: Tablature) {
  const end = tab.bars * barBeats(p);
  return [
    ...(p.markers ?? []).map((m) => ({ beat: m.beat, text: m.name, kind: 'sec' as const })),
    ...songChords(p).chords.map((c) => ({ beat: c.beat, text: chordName(c), kind: 'chord' as const })),
    ...tab.notes.filter((x) => x.tech === 'pm').map((x) => ({ beat: x.beat, text: 'PM', kind: 'pm' as const })),
  ].filter((l) => l.beat < end);
}

/** Uma linha da tablatura (alguns compassos), com o cursor e a marca de reprodução. */
const TabLine = memo(function TabLine(props: {
  b0: number;
  b1: number;
  bb: number;
  beatW: number;
  strings: number[];
  notes: TabNote[];
  labels: ReturnType<typeof tabLabelsFor>;
  cursor: Cursor | null;
  cursorW: number;
  head: number | null;
  onPick: (beat: number, string: number) => void;
}) {
  const { b0, b1, bb, beatW, strings, notes, labels, cursor, cursorW, head, onPick } = props;
  const n = strings.length;
  const w = (b1 - b0) * bb * beatW + LEFT + 8;
  const stemTop = TOP + (n - 1) * LINE + 8;
  const h = stemTop + 30;
  const x = (beat: number) => LEFT + (beat - b0 * bb) * beatW;
  const y = (s: number) => TOP + (n - 1 - s) * LINE; // corda mais aguda em cima
  const inLine = (beat: number) => beat >= b0 * bb - EPS && beat < b1 * bb - EPS;
  const mine = notes.filter((f) => inLine(f.beat) && f.string < n);
  // ritmo: uma haste por começo de nota, com a duração mais longa da coluna
  const cols = new Map<number, number>();
  for (const f of mine) {
    const k = Math.round(f.beat * 1000) / 1000;
    cols.set(k, Math.max(cols.get(k) ?? 0, f.duration));
  }
  const pick = (e: React.MouseEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const px = e.clientX - r.left;
    const py = e.clientY - r.top;
    const beat = b0 * bb + (px - LEFT) / beatW;
    if (beat < b0 * bb || beat >= b1 * bb) return;
    const s = Math.round(n - 1 - (py - TOP) / LINE);
    onPick(beat, Math.max(0, Math.min(n - 1, s)));
  };
  return (
    <svg className="tab-line" width={w} height={h} viewBox={`0 0 ${w} ${h}`} onMouseDown={pick}>
      {/* tempos (linhas bem claras) */}
      {Array.from({ length: (b1 - b0) * Math.ceil(bb) }, (_, i) => b0 * bb + i)
        .filter((b) => b < b1 * bb - EPS)
        .map((b) => <line key={`g${b}`} x1={x(b)} x2={x(b)} y1={y(n - 1)} y2={y(0)} className="tab-beat" />)}
      {cursor && (
        <g className="tab-cursor">
          <rect x={x(cursor.beat)} y={y(n - 1) - 8} width={cursorW * beatW} height={(n - 1) * LINE + 16} className="tab-cursor-col" />
          <rect x={x(cursor.beat)} y={y(cursor.string) - 8} width={cursorW * beatW} height={16} rx={3} className="tab-cursor-cell" />
        </g>
      )}
      {strings.map((m, s) => (
        <g key={s}>
          <text x={4} y={y(s) + 4} className="tab-str">{stringLabel(m)}</text>
          <line x1={22} x2={w - 4} y1={y(s)} y2={y(s)} className="tab-string" />
        </g>
      ))}
      {Array.from({ length: b1 - b0 + 1 }, (_, i) => (
        <g key={i}>
          <line x1={x((b0 + i) * bb)} x2={x((b0 + i) * bb)} y1={y(n - 1)} y2={y(0)} className="tab-bar" />
          {i < b1 - b0 && <text x={x((b0 + i) * bb) + 3} y={y(n - 1) - 10} className="tab-num">{b0 + i + 1}</text>}
        </g>
      ))}
      {labels
        .filter((l) => inLine(l.beat))
        .map((l, i) => (
          <text key={i} x={x(l.beat) + (l.kind === 'pm' ? 4 : 2)} y={l.kind === 'sec' ? 10 : 22} className={`tab-${l.kind}`}>{l.text}</text>
        ))}
      {mine.map((f) => {
        const cx = x(f.beat) + 10;
        const txt = (f.fret < 0 ? 'x' : String(f.fret)) + markOf(f.tech === 'pm' ? undefined : f.tech);
        return (
          <g key={f.id}>
            <rect x={cx - 3.6 * txt.length - 1} y={y(f.string) - 6} width={7.2 * txt.length + 2} height={12} className="tab-bg" />
            <text x={cx} y={y(f.string) + 4} className="tab-fret">{txt}</text>
          </g>
        );
      })}
      {[...cols].map(([beat, d]) => {
        const sx = x(beat) + 10;
        const isPow2 = (v: number) => Math.abs(Math.log2(v) - Math.round(Math.log2(v))) < 1e-6;
        const dotted = !isPow2(d) && isPow2(d / 1.5);
        const base = dotted ? d / 1.5 : d;
        const flags = base < 1 ? Math.round(Math.log2(1 / base)) : 0;
        const len = base >= 4 ? 0 : base >= 2 ? 10 : 18;
        return (
          <g key={`r${beat}`} className="tab-rhythm">
            {len > 0 && <line x1={sx} x2={sx} y1={stemTop} y2={stemTop + len} />}
            {Array.from({ length: Math.min(3, flags) }, (_, i) => <line key={i} x1={sx} x2={sx + 6} y1={stemTop + len - i * 4} y2={stemTop + len - i * 4 - 3} />)}
            {base >= 4 && <circle cx={sx} cy={stemTop + 6} r={2.5} className="tab-whole" />}
            {dotted && <circle cx={sx + 5} cy={stemTop + len + 2} r={1.3} />}
          </g>
        );
      })}
      {head !== null && <line x1={x(head)} x2={x(head)} y1={y(n - 1) - 10} y2={y(0) + 10} className="tab-head" />}
    </svg>
  );
});

// ---------- cifra ----------

function ChartControls() {
  return (
    <>
      <span className="hint">Os acordes por seção. Sem a trilha de acordes, a cifra sai dos loops.</span>
      <button title="Copiar a cifra como texto" onClick={() => void copy(chartText(useStore.getState().project))}>Copiar texto</button>
      <button title="Imprimir (ou salvar em PDF pela janela de impressão)" onClick={() => window.print()}>Imprimir</button>
    </>
  );
}

/** Compassos de cada seção, com os acordes que começam em cada um. */
function chartRows(p: Project) {
  const { chords, fromLoops } = songChords(p);
  const bb = barBeats(p);
  const total = Math.max(bb, Math.ceil(projectEnd(p) / bb - 1e-6) * bb);
  const secs = sections(p, total).map((s) => {
    const bars: string[][] = [];
    for (let b = s.start; b < s.end - 1e-6; b += bb) {
      const inBar = chords.filter((c) => c.beat >= b - 1e-6 && c.beat < b + bb - 1e-6).map((c) => chordName(c));
      // compasso sem acorde novo: continua o anterior
      if (!inBar.length) {
        const cur = chordAt(chords, b);
        inBar.push(cur ? (bars.length ? '%' : chordName(cur)) : '–');
      }
      bars.push(inBar);
    }
    return { name: s.name, bars };
  });
  return { secs, chords, fromLoops };
}

function chartText(p: Project): string {
  const { secs } = chartRows(p);
  let out = `${p.name || 'Música'}\n${p.bpm} BPM\n\n`;
  for (const s of secs) {
    out += `[${s.name}]\n`;
    for (let i = 0; i < s.bars.length; i += 4) out += '| ' + s.bars.slice(i, i + 4).map((b) => b.join(' ').padEnd(8)).join(' | ') + ' |\n';
    out += '\n';
  }
  return out;
}

function ChordChart() {
  const project = useStore((s) => s.project);
  const { secs, chords, fromLoops } = useMemo(() => chartRows(project), [project]);
  if (!chords.length) {
    return <div className="empty">Ainda não há acordes. Escreva na trilha de acordes (embaixo das seções) ou use loops de baixo, acordes ou melodia.</div>;
  }
  const unique = [...new Map(chords.map((c) => [chordName(c).split('/')[0], c])).values()];
  return (
    <div className="chart">
      <h2>{project.name || 'Música'} <small>— {project.bpm} BPM</small></h2>
      {fromLoops && <p className="hint">Sem trilha de acordes: estes são os acordes em que os loops foram escritos.</p>}
      <div className="chart-shapes">
        {unique.map((c) => <ChordDiagram key={chordName(c)} c={c} />)}
      </div>
      {secs.map((s, i) => (
        <section key={i} className="chart-sec">
          <h3>{s.name}</h3>
          <div className="chart-bars">
            {s.bars.map((b, k) => (
              <div key={k} className="chart-bar">
                {b.map((name, j) => <span key={j} className={name === '%' ? 'rep' : ''}>{name}</span>)}
              </div>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

/** Desenho de um acorde no braço do violão (6 cordas, 5 casas). */
function ChordDiagram({ c }: { c: ChordEvent }) {
  const shape = chordShape(c);
  const name = chordName({ root: c.root, q: c.q, flat: c.flat });
  const W = 70, H = 86, L = 12, T = 22, SW = 10, FH = 12;
  if (!shape) {
    return (
      <div className="chord-diagram">
        <b>{name}</b>
        <small>sem desenho</small>
      </div>
    );
  }
  const base = shape.base <= 2 ? 1 : shape.base;
  return (
    <div className="chord-diagram">
      <b>{name}</b>
      <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`}>
        {base === 1 ? <rect x={L} y={T - 3} width={SW * 5} height={3} className="cd-nut" /> : <text x={L + SW * 5 + 4} y={T + FH - 3} className="cd-base">{base}</text>}
        {Array.from({ length: 6 }, (_, i) => <line key={`s${i}`} x1={L + i * SW} x2={L + i * SW} y1={T} y2={T + FH * 5} className="cd-line" />)}
        {Array.from({ length: 6 }, (_, i) => <line key={`f${i}`} x1={L} x2={L + SW * 5} y1={T + i * FH} y2={T + i * FH} className="cd-line" />)}
        {shape.frets.map((f, s) => {
          const cx = L + s * SW;
          if (f < 0) return <text key={s} x={cx} y={T - 7} className="cd-mark">×</text>;
          if (f === 0) return <circle key={s} cx={cx} cy={T - 10} r={3} className="cd-open" />;
          const row = f - base;
          return <circle key={s} cx={cx} cy={T + row * FH + FH / 2} r={4} className="cd-dot" />;
        })}
      </svg>
    </div>
  );
}
