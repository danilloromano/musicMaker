import { Fragment, useEffect, useRef, useState } from 'react';
import { engine } from '../audio/engine';
import { importFiles } from '../audio/importFiles';
import { DRUM_STYLES, FILL_CHOICES, LOOPS, addLoop, applyDrumStyle, extendPattern, setTrackFills } from '../audio/loops';
import { presetGroups } from '../audio/instruments';
import { useStore } from '../store';
import { AutoPoint, BEATS_PER_BAR, Region, Track, TrackKind, activeFreeze, fitFades, projectEnd, regionLen, uid } from '../types';
import { activeLanes, autoParams, laneOf } from '../audio/routing';
import { KIND_ICON, Meter, Slider, Spectrum, useRaf } from './ui';
import { MarkerLane, MarkerLines, jumpMarker } from './Markers';
import { clearUnusedTakes, compRange, deleteTake, takePieces, trackTakes, pickWholeTake } from '../audio/takes';

const HEADER_W = 264;
export const LOOP_MIME = 'application/x-mm-loop';

export function Timeline() {
  const project = useStore((s) => s.project);
  const ppb = useStore((s) => s.ppb);
  const selectedTrackId = useStore((s) => s.selectedTrackId);
  const selectedRegionId = useStore((s) => s.selectedRegionId);
  const recording = useStore((s) => s.recording);
  const loop = project.loop;
  const punch = project.punch;
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
   * Arrasta o trecho de loop (ou o de punch-in): 'move' (a faixa inteira), 'start'/'end' (as bordas) ou 'new'
   * (Shift + arrastar na régua). Encaixa nos tempos; com Alt, em 1/4 de tempo.
   */
  const dragLoop = (e: React.PointerEvent, mode: 'move' | 'start' | 'end' | 'new', which: 'loop' | 'punch' = 'loop') => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const l0 = useStore.getState().project[which] ?? { start: 0, end: 0, on: true };
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
      st.update((p) => ({ ...p, [which]: { start, end, on: mode === 'new' ? true : l0.on } }), false);
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
    const trackKind = project.tracks.find((t) => t.id === r.trackId)?.kind;
    let snapped = false;
    /**
     * Áudio esticado além do fim: o clipe (como estava ao começar o arraste) se repete em cópias coladas,
     * a última cortada onde o mouse está. As cópias são regiões comuns; enquanto o botão está apertado
     * elas são refeitas a cada movimento (voltar o mouse apaga as que sobraram).
     */
    const unit = r.duration ?? 0;
    const unitBeats = (unit * bpm) / 60;
    const loopIds: string[] = [];
    const stretchAudio = (total: number) => {
      const n = Math.max(1, Math.ceil(total / unit - 1e-6)); // quantas vezes o clipe aparece
      while (loopIds.length < n - 1) loopIds.push(uid());
      const keep = loopIds.slice(0, n - 1);
      st.update((p) => {
        const base = p.regions
          .filter((x) => !loopIds.includes(x.id))
          .map((x) => (x.id === r.id ? fitFades({ ...x, duration: n === 1 ? total : unit }) : x));
        const copies = keep.map((id, k) =>
          fitFades({ ...r, id, start: r.start + (k + 1) * unitBeats, duration: k === n - 2 ? total - (n - 1) * unit : unit }),
        );
        return { ...p, regions: [...base, ...copies] };
      }, false);
    };
    const move = (ev: PointerEvent) => {
      const snap = ev.altKey ? 0.25 : 1;
      const d = Math.round((ev.clientX - x0) / ppb / snap) * snap;
      let patch: Partial<Region>;
      if (mode === 'move') patch = { start: Math.max(0, r.start + d) };
      else if (r.bufferId) {
        if (!snapped && d !== 0) {
          st.snapshot();
          snapped = true;
        }
        if (snapped && unit > 0) stretchAudio(Math.max(0.1, unit + (d * 60) / bpm));
        return;
      } else {
        const length = Math.max(1, r.length + d);
        patch = { length };
        // bateria e loops: ao esticar, o padrão continua repetindo no trecho novo
        if (trackKind === 'drums' || trackKind === 'instrument') patch.notes = extendPattern(r, length, trackKind);
      }
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
      await importFiles([...e.dataTransfer.files], beat, trackId);
    })();
  };
  const allowDrop = (e: React.DragEvent) => e.preventDefault();

  const createRegion = (e: React.MouseEvent, t: Track) => {
    if (t.kind === 'audio' || t.kind === 'bus') return;
    const start = Math.floor(beatAt(e.clientX) / BEATS_PER_BAR) * BEATS_PER_BAR;
    const r = st.addRegion({ trackId: t.id, name: t.name, start, length: 4 * BEATS_PER_BAR, notes: [] });
    st.set({ selectedRegionId: r.id, selectedTrackId: t.id, editingRegionId: r.id, bottomTab: 'editor' });
  };

  const add = (kind: TrackKind) => {
    st.addTrack(kind);
    if (kind === 'audio') st.set({ bottomTab: 'fx' }); // mostra a escolha da entrada de áudio
    if (kind === 'bus') st.set({ bottomTab: 'mixer' }); // onde se escolhe quem vai para o grupo
  };

  return (
    <div className="arrange" ref={scroll} onDragOver={allowDrop} onDrop={(e) => drop(e)}>
      <div className="arr-inner" style={{ width: HEADER_W + width, ['--ppb' as string]: `${ppb}px` }}>
        <div className="ruler-row">
          <div className="corner" style={{ width: HEADER_W }}>
            <div className="corner-line">
              <span>Nova trilha:</span>
              <button title="Trilha de instrumento virtual" onClick={() => add('instrument')}>🎹</button>
              <button title="Trilha de bateria" onClick={() => add('drums')}>🥁</button>
              <button title="Trilha de áudio (microfone / arquivo)" onClick={() => add('audio')}>🎤</button>
              <button title="Trilha de grupo: soma outras trilhas (ex.: toda a bateria) para ajustar juntas" onClick={() => add('bus')}>🎚️</button>
            </div>
            <div className="corner-line">
              <span>Seções:</span>
              <button title="Novo marcador de seção no compasso do cursor (M)" onClick={() => st.addMarker(engine.getBeat())}>+ Marcador</button>
              <button title="Seção anterior (,)" onClick={() => jumpMarker(-1)}>◀</button>
              <button title="Próxima seção (.)" onClick={() => jumpMarker(1)}>▶</button>
            </div>
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
            {punch && (
              <div
                className={`punch-band ${punch.on ? 'on' : ''}`}
                style={{ left: punch.start * ppb, width: (punch.end - punch.start) * ppb }}
                title="Trecho de punch-in: a gravação só substitui o que está aqui. Arraste para mover, pelas bordas para ajustar. Duplo clique liga/desliga."
                onPointerDown={(e) => dragLoop(e, 'move', 'punch')}
                onDoubleClick={() => st.togglePunch(engine.getBeat())}
              >
                <div className="loop-edge l" onPointerDown={(e) => dragLoop(e, 'start', 'punch')} />
                <div className="loop-edge r" onPointerDown={(e) => dragLoop(e, 'end', 'punch')} />
              </div>
            )}
            <MarkerLane ppb={ppb} beatAt={beatAt} />
            <div className="ruler-head" ref={rulerHead} />
          </div>
        </div>
        <MarkerLines ppb={ppb} left={HEADER_W} />
        {punch?.on && <div className="punch-shade" style={{ left: HEADER_W + punch.start * ppb, width: (punch.end - punch.start) * ppb }} />}
        {loop?.on && <div className="loop-shade" style={{ left: HEADER_W + loop.start * ppb, width: (loop.end - loop.start) * ppb }} />}

        {project.tracks.map((t) => (
          <Fragment key={t.id}>
          <div className={`row ${t.id === selectedTrackId ? 'sel' : ''}`}>
            <TrackHeader track={t} />
            <div
              className={`lane ${freezeState(t) === 'on' ? 'frozen' : ''}`}
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
                  style={{ left: r.start * ppb, width: Math.max(6, regionLen(r, project.bpm) * ppb), ['--c' as string]: t.color }}
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
                  {r.notes ? <NotePreview region={r} /> : <Wave region={r} color={t.color} />}
                  {r.bufferId && <Fades region={r} pxPerSec={(ppb * project.bpm) / 60} />}
                  <div className="region-grip" onPointerDown={(e) => dragRegion(e, r, 'resize')} />
                </div>
              ))}
              {recording?.trackId === t.id && <div className="rec-overlay" ref={recEl} />}
              {t.kind === 'bus' && (
                <div className="lane-hint">
                  Grupo: {project.tracks.filter((c) => c.output === t.id).map((c) => c.name).join(', ') || 'nenhuma trilha ainda'} · escolha a saída das
                  trilhas na aba Mixer
                </div>
              )}
              {(t.kind === 'instrument' || t.kind === 'drums') && !project.regions.some((r) => r.trackId === t.id) && (
                <div className="lane-hint">
                  {t.kind === 'drums'
                    ? 'Escolha um estilo de bateria no seletor ao lado · ou arraste um loop'
                    : 'Duplo clique para criar uma região · ou arraste um loop'}
                </div>
              )}
              {t.kind === 'audio' && !project.regions.some((r) => r.trackId === t.id) && !recording && (
                <div className="lane-hint">Selecione a trilha e aperte ● para gravar · ou solte um arquivo de áudio</div>
              )}
            </div>
          </div>
          {t.takesView && t.kind === 'audio' && <TakeRows track={t} width={width} ppb={ppb} />}
          {t.autoView && <AutomationRow track={t} width={width} ppb={ppb} />}
          </Fragment>
        ))}

        <div className="dropzone" style={{ marginLeft: HEADER_W }}>
          Arraste loops ou arquivos de áudio para cá para criar uma nova trilha
        </div>
        <div className="playhead" ref={head} style={{ left: HEADER_W }} onPointerDown={scrub} title="Arraste para mover o cursor" />
      </div>
    </div>
  );
}

/** Seletor de estilo de bateria: troca o ritmo da região selecionada ou cria uma nova no cursor. */
function DrumStylePicker({ track: t }: { track: Track }) {
  // mostra o estilo da região selecionada desta trilha, se ela veio de um estilo
  const current = useStore((s) => {
    const r = s.project.regions.find((x) => x.id === s.selectedRegionId && x.trackId === t.id);
    return LOOPS.find((l) => l.kind === 'drums' && l.name === r?.name)?.id ?? '';
  });
  const hasSel = useStore((s) => s.project.regions.some((x) => x.id === s.selectedRegionId && x.trackId === t.id));
  return (
    <select
      className="th-style"
      value={current}
      title={hasSel ? 'Trocar o estilo da região selecionada' : 'Inserir um ritmo de bateria na posição do cursor'}
      onChange={(e) => {
        if (e.target.value) applyDrumStyle(e.target.value, t.id, engine.getBeat());
        e.currentTarget.blur();
      }}
    >
      <option value="">{hasSel ? 'Trocar…' : 'Estilo…'}</option>
      {DRUM_STYLES.map((g) => (
        <optgroup key={g.group} label={g.group}>
          {g.ids.map((id) => {
            const l = LOOPS.find((x) => x.id === id);
            return l && <option key={id} value={id}>{l.name}</option>;
          })}
        </optgroup>
      ))}
    </select>
  );
}

/** Viradas automáticas: de quantos em quantos compassos (na região selecionada ou em toda a trilha). */
function FillPicker({ track: t }: { track: Track }) {
  const value = useStore((s) => {
    const rs = s.project.regions.filter((x) => x.trackId === t.id && x.notes);
    return (rs.find((x) => x.id === s.selectedRegionId) ?? rs[0])?.fills ?? 0;
  });
  const hasSel = useStore((s) => s.project.regions.some((x) => x.id === s.selectedRegionId && x.trackId === t.id));
  return (
    <select
      className="th-fills"
      value={value}
      title={`Viradas automáticas ${hasSel ? 'na região selecionada' : 'em todas as regiões da trilha'}`}
      onChange={(e) => {
        setTrackFills(t.id, +e.target.value);
        e.currentTarget.blur();
      }}
    >
      <optgroup label="Virada a cada">
        {FILL_CHOICES.map((n) => (
          <option key={n} value={n}>{n ? `${n} comp.` : 'Sem virada'}</option>
        ))}
      </optgroup>
    </select>
  );
}

/** Estado do congelamento: 'on' (tocando o áudio congelado), 'stale' (mudou depois de congelar) ou 'off'. */
function freezeState(t: Track): 'on' | 'stale' | 'off' {
  const p = useStore.getState().project;
  if (!t.frozen || !engine.buffers.has(t.frozen.bufferId)) return 'off';
  return activeFreeze(p, t, (id) => engine.buffers.has(id)) ? 'on' : 'stale';
}

function TrackHeader({ track: t }: { track: Track }) {
  const st = useStore.getState();
  useStore((s) => s.project.regions); // o estado do congelamento depende das regiões da trilha
  const nTakes = useStore((s) => (t.kind === 'audio' ? trackTakes(s.project, t.id).length : 0));
  const up = (patch: Partial<Track>, history = false) => st.updateTrack(t.id, patch, history);
  const frozen = freezeState(t);
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
        <button
          className={`ms auto ${t.autoView ? 'on' : ''} ${activeLanes(t).length ? 'has' : ''}`}
          title="Automação: volume, pan e envios mudando ao longo da música"
          onClick={() => up({ autoView: t.autoView ? undefined : activeLanes(t)[0]?.param ?? 'volume' }, false)}
        >
          A
        </button>
        {nTakes > 1 && (
          <button
            className={`ms takes ${t.takesView ? 'on' : ''}`}
            title={`Takes (${nTakes} gravações): abre as faixas para escolher o melhor pedaço de cada uma`}
            onClick={() => up({ takesView: !t.takesView || undefined }, false)}
          >
            T
          </button>
        )}
        {t.kind !== 'bus' && (
          <button
            className={`ms freeze ${frozen}`}
            title={
              frozen === 'on'
                ? 'Trilha congelada: o instrumento e os pedais/amp já estão renderizados em áudio (alivia o processador). Clique para descongelar.'
                : frozen === 'stale'
                  ? 'A trilha mudou depois de congelar e está tocando ao vivo. Clique para congelar de novo.'
                  : 'Congelar: renderiza o instrumento e os pedais/amp em áudio para aliviar o processador. Volume, pan, EQ, compressor e envios continuam ajustáveis; mudar notas ou pedais volta a tocar ao vivo.'
            }
            onClick={() => (frozen === 'on' ? engine.unfreezeTrack(t.id) : void engine.freezeTrack(t.id))}
          >
            ❄
          </button>
        )}
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
            {presetGroups().map((g) => (
              <optgroup key={g.group} label={g.group}>
                {g.items.map(([id, p]) => <option key={id} value={id}>{p.name}</option>)}
              </optgroup>
            ))}
          </select>
        ) : (
          t.kind === 'drums' ? <><DrumStylePicker track={t} /><FillPicker track={t} /></> : t.kind === 'bus' ? <span className="th-input">Grupo</span> : <InputButton />

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

function Wave({ region: r, color }: { region: Region; color: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const cv = ref.current;
    const buf = r.bufferId && engine.buffers.get(r.bufferId);
    if (!cv || !buf) return;
    const w = (cv.width = Math.min(4000, Math.max(50, Math.round((r.duration ?? 0) * 60))));
    const h = (cv.height = 48);
    const g = cv.getContext('2d')!;
    g.clearRect(0, 0, w, h);
    g.fillStyle = color;
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
  }, [r.bufferId, r.offset, r.duration, color]);
  return <canvas className="region-body" ref={ref} />;
}

// ---------- Takes (comping) ----------

const TAKE_H = 46;

/**
 * Faixas de takes de uma trilha de áudio: uma por gravação (a mais nova em cima). Os pedaços acesos são os
 * que estão tocando. Clique num pedaço apagado para usá-lo, ou arraste sobre um take para usar só aquele
 * trecho dele (encaixa em 1/4 de tempo; com Alt, livre).
 */
function TakeRows({ track: t, width, ppb }: { track: Track; width: number; ppb: number }) {
  const project = useStore((s) => s.project);
  const st = useStore.getState();
  const takes = trackTakes(project, t.id).reverse();
  const [sel, setSel] = useState<{ n: number; a: number; b: number } | null>(null);

  const down = (e: React.PointerEvent, n: number) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const left = (e.currentTarget as HTMLElement).getBoundingClientRect().left;
    const at = (ev: { clientX: number; altKey: boolean }) => {
      const raw = Math.max(0, (ev.clientX - left) / ppb);
      return ev.altKey ? raw : Math.round(raw * 4) / 4;
    };
    const x0 = e.clientX;
    const b0 = at(e);
    let moved = false;
    const move = (ev: PointerEvent) => {
      if (Math.abs(ev.clientX - x0) > 3) moved = true;
      if (moved) {
        const b = at(ev);
        setSel({ n, a: Math.min(b0, b), b: Math.max(b0, b) });
      }
    };
    const up = (ev: PointerEvent) => {
      window.removeEventListener('pointermove', move);
      setSel(null);
      if (moved) {
        const b = at(ev);
        st.update((p) => compRange(p, t.id, n, Math.min(b0, b), Math.max(b0, b)));
        return;
      }
      // clique: usa o pedaço inteiro sob o mouse
      const beat = Math.max(0, (ev.clientX - left) / ppb);
      const hit = takePieces(useStore.getState().project, t.id, n).find(
        ({ region: r }) => beat >= r.start && beat <= r.start + regionLen(r, project.bpm),
      );
      if (hit && !hit.active) st.update((p) => compRange(p, t.id, n, hit.region.start, hit.region.start + regionLen(hit.region, p.bpm)));
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up, { once: true });
  };

  return (
    <>
      {takes.map((n, i) => {
        const ps = takePieces(project, t.id, n);
        const playing = ps.some((x) => x.active);
        return (
          <div key={n} className="row take-row" style={{ height: TAKE_H }}>
            <div className="th take-th" style={{ width: HEADER_W, ['--c' as string]: t.color }}>
              <span className={`take-label ${playing ? 'on' : ''}`}>Take {n}</span>
              <button title="Usar este take inteiro" onClick={() => st.update((p) => pickWholeTake(p, t.id, n))}>Usar</button>
              <button className="x" title="Apagar este take (onde ele tocava, entra o take mais novo que tem áudio ali)" onClick={() => st.update((p) => deleteTake(p, t.id, n))}>✕</button>
              {i === 0 && (project.takes ?? []).some((r) => r.trackId === t.id) && (
                <button title="Descartar os pedaços que não estão em uso (fica só o que está tocando)" onClick={() => st.update((p) => clearUnusedTakes(p, t.id))}>
                  Limpar
                </button>
              )}
            </div>
            <div className="lane take-lane" style={{ width, height: TAKE_H }} onPointerDown={(e) => down(e, n)}>
              {ps.map(({ region: r, active }) => (
                <div
                  key={r.id}
                  className={`take-piece ${active ? 'on' : ''}`}
                  style={{ left: r.start * ppb, width: Math.max(3, regionLen(r, project.bpm) * ppb), ['--c' as string]: t.color }}
                  title={active ? 'Tocando' : 'Clique para usar este pedaço · arraste para usar só um trecho'}
                >
                  <Wave region={r} color={t.color} />
                </div>
              ))}
              {sel?.n === n && <div className="take-sel" style={{ left: sel.a * ppb, width: (sel.b - sel.a) * ppb }} />}
            </div>
          </div>
        );
      })}
    </>
  );
}

// ---------- Automação ----------

const AUTO_H = 72;

/** Faixa de automação de uma trilha: cabeçalho (parâmetro) + curva editável. */
function AutomationRow({ track: t, width, ppb }: { track: Track; width: number; ppb: number }) {
  const project = useStore((s) => s.project);
  const params = autoParams(project, t);
  const info = params.find((p) => p.id === t.autoView) ?? params[0];
  const lane = laneOf(t, info.id);
  const points = lane?.points ?? [];
  const st = useStore.getState();
  const svg = useRef<SVGSVGElement>(null);

  const y = (v: number) => 4 + (1 - (v - info.min) / (info.max - info.min)) * (AUTO_H - 8);
  const vAt = (py: number) => Math.min(info.max, Math.max(info.min, info.min + (1 - (py - 4) / (AUTO_H - 8)) * (info.max - info.min)));

  const save = (pts: AutoPoint[], history = false) => {
    const tr = useStore.getState().project.tracks.find((x) => x.id === t.id);
    if (!tr) return;
    const others = (tr.automation ?? []).filter((l) => l.param !== info.id);
    const sorted = [...pts].sort((a, b) => a.beat - b.beat);
    st.updateTrack(t.id, { automation: sorted.length ? [...others, { param: info.id, points: sorted }] : others }, history);
  };

  /** Arrasta o ponto `i` de `pts` (já com o ponto novo, se for um clique na faixa). */
  const dragPoint = (e: React.PointerEvent, pts: AutoPoint[], i: number) => {
    const el = svg.current!;
    const r = el.getBoundingClientRect();
    const move = (ev: { clientX: number; clientY: number; altKey: boolean }) => {
      const raw = Math.max(0, (ev.clientX - r.left) / ppb);
      const beat = ev.altKey ? raw : Math.round(raw * 4) / 4;
      const next = pts.slice();
      next[i] = { beat, value: Math.round(vAt(ev.clientY - r.top) * 1000) / 1000 };
      save(next);
    };
    const pm = (ev: PointerEvent) => move(ev);
    window.addEventListener('pointermove', pm);
    window.addEventListener('pointerup', () => window.removeEventListener('pointermove', pm), { once: true });
    move(e);
  };

  /** pontos atuais direto do store (vários cliques podem chegar antes de a tela redesenhar) */
  const current = () => {
    const tr = useStore.getState().project.tracks.find((x) => x.id === t.id);
    return (tr && laneOf(tr, info.id)?.points) ?? [];
  };

  const down = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    st.snapshot();
    const points = current();
    const hit = (e.target as Element).getAttribute('data-i');
    if (hit !== null) return dragPoint(e, points, +hit);
    // clique na faixa: cria um ponto ali e já começa a arrastá-lo
    const r = svg.current!.getBoundingClientRect();
    const beat = Math.round(Math.max(0, (e.clientX - r.left) / ppb) * 4) / 4;
    const pts = [...points, { beat, value: vAt(e.clientY - r.top) }].sort((a, b) => a.beat - b.beat);
    dragPoint(e, pts, pts.findIndex((p) => p.beat === beat));
  };

  const remove = (e: React.MouseEvent) => {
    const hit = (e.target as Element).getAttribute('data-i');
    if (hit === null) return;
    e.stopPropagation();
    save(current().filter((_, i) => i !== +hit), true);
  };

  const line = points.length
    ? [`M0,${y(points[0].value)}`, ...points.map((p) => `L${p.beat * ppb},${y(p.value)}`), `L${width},${y(points[points.length - 1].value)}`].join(' ')
    : '';
  const used = (t.automation ?? []).filter((l) => l.points.length).map((l) => l.param);

  return (
    <div className="row auto-row">
      <div className="th auto-th" style={{ width: HEADER_W, ['--c' as string]: t.color }}>
        <span className="auto-label">Automação</span>
        <select value={info.id} onChange={(e) => st.updateTrack(t.id, { autoView: e.target.value }, false)}>
          {params.map((p) => (
            <option key={p.id} value={p.id}>{used.includes(p.id) ? '● ' : ''}{p.name}</option>
          ))}
        </select>
        <div className="auto-tools">
          <span className="auto-val">{points.length ? `${points.length} ponto${points.length > 1 ? 's' : ''}` : `fixo: ${info.format(info.base(t))}`}</span>
          {points.length > 0 && <button title="Apagar todos os pontos deste parâmetro" onClick={() => save([], true)}>Limpar</button>}
        </div>
      </div>
      <div className="lane auto-lane" style={{ width, height: AUTO_H }}>
        <svg ref={svg} width={width} height={AUTO_H} onPointerDown={down} onDoubleClick={remove}>
          {!points.length && <line x1={0} x2={width} y1={y(info.base(t))} y2={y(info.base(t))} className="auto-base" />}
          {line && <path d={line} className="auto-line" style={{ stroke: t.color }} />}
          {points.map((p, i) => (
            <circle key={i} data-i={i} cx={p.beat * ppb} cy={y(p.value)} r={5} className="auto-pt" style={{ fill: t.color }}>
              <title>{`${info.format(p.value)} · compasso ${Math.floor(p.beat / BEATS_PER_BAR) + 1}.${Math.floor(p.beat % BEATS_PER_BAR) + 1} (duplo clique apaga)`}</title>
            </circle>
          ))}
        </svg>
        {!points.length && <div className="lane-hint auto-hint">Clique para criar pontos e arraste para desenhar a curva de {info.name.toLowerCase()}</div>}
      </div>
    </div>
  );
}
