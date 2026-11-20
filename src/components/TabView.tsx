import { useEffect, useMemo, useState } from 'react';
import { playedNotes } from '../audio/arp';
import { ChordEvent, chordAt, chordName } from '../audio/chords';
import { TUNINGS, tuningOf } from '../audio/tuner';
import { Fretted, asciiTab, chordShape, fingering, stringLabel } from '../audio/tab';
import { pref, savePref, useStore } from '../store';
import { Project, Track, barBeats, projectEnd } from '../types';

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

/** Aba Tablatura & Cifra: a trilha selecionada nas cordas, ou a cifra da música com os desenhos dos acordes. */
export function TabView() {
  const [mode, setMode] = useState<'tab' | 'chart'>(() => (pref('mm.tabMode') === 'chart' ? 'chart' : 'tab'));
  const choose = (m: 'tab' | 'chart') => {
    setMode(m);
    savePref('mm.tabMode', m);
  };
  return (
    <div className="tabview">
      <div className="roll-bar">
        <div className="seg">
          <button className={mode === 'tab' ? 'on' : ''} onClick={() => choose('tab')}>Tablatura</button>
          <button className={mode === 'chart' ? 'on' : ''} onClick={() => choose('chart')}>Cifra</button>
        </div>
        {mode === 'tab' ? <TabControls /> : <ChartControls />}
      </div>
      <div className="tab-scroll print-area">{mode === 'tab' ? <TabSheet /> : <ChordChart />}</div>
    </div>
  );
}

// ---------- tablatura ----------

/** Estado da tablatura (trilha e afinação) — compartilhado entre a barra e a folha. */
function useTabState() {
  const project = useStore((s) => s.project);
  const sel = useStore((s) => s.selectedTrackId);
  const playable = project.tracks.filter((t) => t.kind === 'instrument' && project.regions.some((r) => r.trackId === t.id && r.notes?.length));
  const track = playable.find((t) => t.id === sel) ?? playable[0];
  const saved = pref(`mm.tabTuning.${track?.id}`);
  const tuning = tuningOf(saved ?? (track && BASS_INSTR.has(track.instrument) ? 'bass' : 'gtr'));
  return { project, playable, track, tuning };
}

function TabControls() {
  const { playable, track, tuning } = useTabState();
  const [, force] = useState(0);
  const [bars, setBars] = useState(() => +(pref('mm.tabBars') ?? 4) || 4);
  const st = useStore.getState();
  const groups = [...new Set(TUNINGS.filter((t) => t.strings.length).map((t) => t.group))];
  return (
    <>
      <label>
        Trilha
        <select value={track?.id ?? ''} onChange={(e) => st.set({ selectedTrackId: e.target.value })}>
          {!playable.length && <option value="">Nenhuma trilha com notas</option>}
          {playable.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
        </select>
      </label>
      <label>
        Instrumento
        <select
          value={tuning.id}
          disabled={!track}
          onChange={(e) => {
            if (track) savePref(`mm.tabTuning.${track.id}`, e.target.value);
            force((n) => n + 1);
            window.dispatchEvent(new Event('mm-tab'));
          }}
        >
          {groups.map((g) => (
            <optgroup key={g} label={g}>
              {TUNINGS.filter((t) => t.group === g && t.strings.length).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </optgroup>
          ))}
        </select>
      </label>
      <label>
        Compassos por linha
        <select
          value={bars}
          onChange={(e) => {
            setBars(+e.target.value);
            savePref('mm.tabBars', e.target.value);
            window.dispatchEvent(new Event('mm-tab'));
          }}
        >
          {[2, 4, 6, 8].map((n) => <option key={n} value={n}>{n}</option>)}
        </select>
      </label>
      <button title="Copiar a tablatura como texto (para colar em mensagem, e-mail, site de cifras…)" disabled={!track} onClick={() => void copy(tabText())}>
        Copiar texto
      </button>
      <button title="Imprimir (ou salvar em PDF pela janela de impressão)" onClick={() => window.print()}>Imprimir</button>
    </>
  );
}

/** As notas da trilha nas cordas. */
function useFrets(project: Project, track: Track | undefined, strings: number[]) {
  return useMemo(() => {
    if (!track) return { frets: [] as Fretted[], total: 0 };
    // sem o toque humano: a tablatura mostra o ritmo escrito
    const t = { ...track, feel: 0 };
    const notes = project.regions
      .filter((r) => r.trackId === track.id && r.notes?.length)
      .flatMap((r) =>
        playedNotes(r, t, project.bpm, project.chords)
          .filter((n) => n.start < r.length)
          .map((n) => ({ pitch: n.pitch, start: r.start + n.start, duration: Math.min(n.duration, r.length - n.start) })),
      );
    const max = BASS_INSTR.has(track.instrument) && strings.length <= 5 ? 20 : 22;
    const frets = fingering(notes, strings, max);
    const bb = barBeats(project);
    const end = Math.max(0, ...notes.map((n) => n.start + n.duration));
    return { frets, total: Math.max(1, Math.ceil(end / bb - 1e-6)) };
  }, [project.regions, project.bpm, project.chords, project.meter, track, strings]);
}

/** Rótulos por cima da tablatura: seções e acordes. */
function tabLabels(p: Project) {
  const { chords } = songChords(p);
  return [
    ...(p.markers ?? []).map((m) => ({ beat: m.beat, text: m.name, kind: 'sec' as const })),
    ...chords.map((c) => ({ beat: c.beat, text: chordName(c), kind: 'chord' as const })),
  ];
}

function tabText(): string {
  const s = useStore.getState();
  const p = s.project;
  const playable = p.tracks.filter((t) => t.kind === 'instrument' && p.regions.some((r) => r.trackId === t.id && r.notes?.length));
  const track = playable.find((t) => t.id === s.selectedTrackId) ?? playable[0];
  if (!track) return '';
  const tuning = tuningOf(pref(`mm.tabTuning.${track.id}`) ?? (BASS_INSTR.has(track.instrument) ? 'bass' : 'gtr'));
  const t = { ...track, feel: 0 };
  const notes = p.regions
    .filter((r) => r.trackId === track.id && r.notes?.length)
    .flatMap((r) => playedNotes(r, t, p.bpm, p.chords).filter((n) => n.start < r.length).map((n) => ({ pitch: n.pitch, start: r.start + n.start, duration: n.duration })));
  const frets = fingering(notes, tuning.strings);
  const bb = barBeats(p);
  const total = Math.max(1, Math.ceil(Math.max(0, ...notes.map((n) => n.start + n.duration)) / bb - 1e-6));
  const labels = tabLabels(p).filter((l) => l.kind === 'chord');
  const head = `${p.name || 'Música'} — ${track.name}\nAfinação: ${tuning.name} · ${p.bpm} BPM\n\n`;
  return head + asciiTab(frets, tuning.strings, bb, total, +(pref('mm.tabBars') ?? 4) || 4, labels);
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

const BEAT_W = 54; // px por tempo
const LINE = 13; // px entre cordas

function TabSheet() {
  const { project, track, tuning } = useTabState();
  const [, force] = useState(0);
  // a barra muda afinação e compassos por linha (preferências): redesenha
  useEffect(() => {
    const f = () => force((n) => n + 1);
    window.addEventListener('mm-tab', f);
    return () => window.removeEventListener('mm-tab', f);
  }, []);
  const strings = tuning.strings;
  const { frets, total } = useFrets(project, track, strings);
  const bb = barBeats(project);
  const per = +(pref('mm.tabBars') ?? 4) || 4;
  const labels = useMemo(() => tabLabels(project), [project]);
  if (!track) return <div className="empty">Nenhuma trilha de instrumento com notas. Grave ou arraste um loop de baixo, acordes ou melodia.</div>;
  const shifted = frets.some((f) => f.shifted);
  const n = strings.length;
  const lines = [];
  for (let b0 = 0; b0 < total; b0 += per) {
    const b1 = Math.min(total, b0 + per);
    const w = (b1 - b0) * bb * BEAT_W + 30;
    const top = 30;
    const h = top + (n - 1) * LINE + 18;
    const x = (beat: number) => 26 + (beat - b0 * bb) * BEAT_W;
    const y = (s: number) => top + (n - 1 - s) * LINE; // corda mais aguda em cima
    lines.push(
      <svg key={b0} className="tab-line" width={w} height={h} viewBox={`0 0 ${w} ${h}`}>
        {strings.map((m, s) => (
          <g key={s}>
            <text x={4} y={y(s) + 4} className="tab-str">{stringLabel(m)}</text>
            <line x1={22} x2={w - 4} y1={y(s)} y2={y(s)} className="tab-string" />
          </g>
        ))}
        {Array.from({ length: b1 - b0 + 1 }, (_, i) => (
          <g key={i}>
            <line x1={x((b0 + i) * bb)} x2={x((b0 + i) * bb)} y1={y(n - 1)} y2={y(0)} className="tab-bar" />
            {i < b1 - b0 && <text x={x((b0 + i) * bb) + 3} y={y(0) + 14} className="tab-num">{b0 + i + 1}</text>}
          </g>
        ))}
        {labels
          .filter((l) => l.beat >= b0 * bb - 1e-6 && l.beat < b1 * bb - 1e-6)
          .map((l, i) => (
            <text key={i} x={x(l.beat) + 2} y={l.kind === 'sec' ? 10 : 22} className={l.kind === 'sec' ? 'tab-sec' : 'tab-chord'}>{l.text}</text>
          ))}
        {frets
          .filter((f) => f.start >= b0 * bb - 1e-6 && f.start < b1 * bb - 1e-6)
          .map((f, i) => {
            const cx = x(f.start) + 9;
            const txt = String(f.fret);
            return (
              <g key={i}>
                <rect x={cx - 4 * txt.length - 1} y={y(f.string) - 6} width={8 * txt.length + 2} height={12} className="tab-bg" />
                <text x={cx} y={y(f.string) + 4} className={`tab-fret ${f.shifted ? 'shifted' : ''}`}>
                  {txt}
                  {f.shifted && <title>Nota fora da extensão do instrumento: tocada uma oitava acima/abaixo</title>}
                </text>
              </g>
            );
          })}
      </svg>,
    );
  }
  return (
    <div className="tab-sheet">
      <h2>{project.name || 'Música'} <small>— {track.name} · {tuning.name}</small></h2>
      {shifted && <p className="hint">Notas em laranja estavam fora da extensão do instrumento e aparecem uma oitava acima ou abaixo.</p>}
      {lines}
    </div>
  );
}

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
