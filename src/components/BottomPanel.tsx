import { engine } from '../audio/engine';
import { DRUM_MAP, PRESETS } from '../audio/instruments';
import { LOOPS, Loop, addLoop } from '../audio/loops';
import { BottomTab, useStore } from '../store';
import { Track, TrackFx } from '../types';
import { PianoRoll } from './PianoRoll';
import { LOOP_MIME } from './Timeline';
import { KIND_ICON, Slider, Spectrum } from './ui';

const TABS: [BottomTab, string][] = [
  ['loops', 'Loops'],
  ['editor', 'Piano Roll'],
  ['fx', 'Efeitos'],
  ['keys', 'Teclado'],
];

export function BottomPanel() {
  const tab = useStore((s) => s.bottomTab);
  const track = useStore((s) => s.project.tracks.find((t) => t.id === s.selectedTrackId));
  const set = useStore.getState().set;
  return (
    <section className="bottom">
      <nav className="tabs">
        {TABS.map(([id, label]) => (
          <button key={id} className={tab === id ? 'on' : ''} onClick={() => set({ bottomTab: id })}>{label}</button>
        ))}
        {track && <span className="tabs-track">{KIND_ICON[track.kind]} {track.name}</span>}
      </nav>
      <div className="bottom-body">
        {tab === 'editor' && <PianoRoll />}
        {tab === 'loops' && <Loops />}
        {tab === 'fx' && (track ? <Fx track={track} /> : <div className="empty">Selecione uma trilha.</div>)}
        {tab === 'keys' && (track && track.kind !== 'audio' ? <Keys track={track} /> : <div className="empty">Selecione uma trilha de instrumento ou bateria para tocar.</div>)}
      </div>
    </section>
  );
}

// ---------- Loops ----------

function Loops() {
  const cats = [...new Set(LOOPS.map((l) => l.category))];
  const add = (l: Loop) => addLoop(l, engine.getBeat(), useStore.getState().selectedTrackId ?? undefined);
  return (
    <div className="loops">
      {cats.map((c) => (
        <div key={c} className="loop-cat">
          <h4>{c}</h4>
          {LOOPS.filter((l) => l.category === c).map((l) => (
            <div
              key={l.id}
              className="loop"
              draggable
              title="Arraste para a timeline"
              onDragStart={(e) => {
                e.dataTransfer.setData(LOOP_MIME, l.id);
                e.dataTransfer.effectAllowed = 'copy';
              }}
            >
              <button title="Ouvir" onClick={() => engine.previewNotes(l.kind, l.instrument, l.notes)}>▶</button>
              <span className="loop-name">{l.name}</span>
              <small>{l.bars} comp.</small>
              <button title="Adicionar na posição do cursor" onClick={() => add(l)}>＋</button>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

// ---------- Efeitos ----------

const FX: { key: keyof Omit<TrackFx, 'comp'>; label: string; min: number; max: number; step: number; unit: string }[] = [
  { key: 'low', label: 'Graves', min: -12, max: 12, step: 0.5, unit: 'dB' },
  { key: 'mid', label: 'Médios', min: -12, max: 12, step: 0.5, unit: 'dB' },
  { key: 'high', label: 'Agudos', min: -12, max: 12, step: 0.5, unit: 'dB' },
  { key: 'reverb', label: 'Reverb', min: 0, max: 1, step: 0.01, unit: '%' },
  { key: 'delay', label: 'Eco (delay)', min: 0, max: 1, step: 0.01, unit: '%' },
];

function Fx({ track: t }: { track: Track }) {
  const st = useStore.getState();
  const setFx = (patch: Partial<TrackFx>, history = false) => st.updateTrack(t.id, { fx: { ...t.fx, ...patch } }, history);
  return (
    <div className="fx">
      <div className="fx-card wide">
        <h4>Espectro de frequências (Hz)</h4>
        <Spectrum trackId={t.id} color={t.color} bars={96} labels className="big" />
      </div>
      {t.kind === 'instrument' && (
        <div className="fx-card wide">
          <h4>Instrumento</h4>
          <div className="presets">
            {Object.entries(PRESETS).map(([id, p]) => (
              <button key={id} className={t.instrument === id ? 'on' : ''} onClick={() => st.updateTrack(t.id, { instrument: id })}>
                {p.name}
              </button>
            ))}
          </div>
        </div>
      )}
      {FX.map((f) => (
        <div className="fx-card" key={f.key}>
          <h4>{f.label}</h4>
          <Slider min={f.min} max={f.max} step={f.step} value={t.fx[f.key]} reset={0} onChange={(v) => setFx({ [f.key]: v })} />
          <span className="fx-val">
            {f.unit === 'dB' ? `${t.fx[f.key] > 0 ? '+' : ''}${t.fx[f.key].toFixed(1)} dB` : `${Math.round(t.fx[f.key] * 100)}%`}
          </span>
        </div>
      ))}
      <div className="fx-card">
        <h4>Compressor</h4>
        <button className={t.fx.comp ? 'toggle on' : 'toggle'} onClick={() => setFx({ comp: !t.fx.comp }, true)}>
          {t.fx.comp ? 'Ligado' : 'Desligado'}
        </button>
      </div>
    </div>
  );
}

// ---------- Teclado na tela ----------

const WHITE = [0, 2, 4, 5, 7, 9, 11];
const BLACK: [number, number][] = [[1, 1], [3, 2], [6, 4], [8, 5], [10, 6]]; // [semitom, posição após a tecla branca n]
export const KEY_ROW = ['a', 'w', 's', 'e', 'd', 'f', 't', 'g', 'y', 'h', 'u', 'j', 'k', 'o', 'l', 'p'];

function Keys({ track }: { track: Track }) {
  const octave = useStore((s) => s.octave);
  const set = useStore.getState().set;
  const hold = (pitch: number) => ({
    onPointerDown: (e: React.PointerEvent) => {
      e.preventDefault();
      engine.noteOn(pitch);
      window.addEventListener('pointerup', () => engine.noteOff(pitch), { once: true });
    },
  });

  if (track.kind === 'drums') {
    return (
      <div className="pads">
        {[...DRUM_MAP].reverse().map((d) => (
          <button key={d.pitch} className="pad" {...hold(d.pitch)}>{d.name}</button>
        ))}
      </div>
    );
  }

  const OCTS = 3;
  const base = (octave + 1) * 12;
  return (
    <div className="kb-wrap">
      <div className="kb-side">
        <button onClick={() => set({ octave: Math.max(0, octave - 1) })} title="Oitava abaixo (Z)">− Oitava</button>
        <strong>C{octave}</strong>
        <button onClick={() => set({ octave: Math.min(7, octave + 1) })} title="Oitava acima (X)">+ Oitava</button>
        <small>Toque também pelas teclas<br />A S D F G H J K (brancas)<br />W E T Y U (pretas)</small>
      </div>
      <div className="kb">
        {Array.from({ length: OCTS }, (_, o) =>
          WHITE.map((s, i) => {
            const semi = o * 12 + s;
            return (
              <div key={semi} className="wk" {...hold(base + semi)}>
                <span>{KEY_ROW[semi]?.toUpperCase() ?? (s === 0 ? `C${octave + o}` : '')}</span>
              </div>
            );
          }),
        )}
        {Array.from({ length: OCTS }, (_, o) =>
          BLACK.map(([s, pos]) => (
            <div
              key={`b${o}-${s}`}
              className="bk"
              style={{ left: `calc(${((o * 7 + pos) / (OCTS * 7)) * 100}% - 13px)` }}
              {...hold(base + o * 12 + s)}
            />
          )),
        )}
      </div>
    </div>
  );
}
