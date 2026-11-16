// Editores de EQ paramétrico e de compressor de uma trilha (aba Efeitos).
import { useEffect, useMemo, useRef, useState } from 'react';
import { engine } from '../audio/engine';
import {
  BAND_COLORS, BAND_NAMES, BAND_TYPES, COMP_PRESETS, DEFAULT_COMP, EQ_F_MAX, EQ_F_MIN, EQ_GAIN_MAX,
  compOf, defaultEq, eqOf, eqResponse,
} from '../audio/trackfx';
import { useStore } from '../store';
import { Sidechain, Track, TrackComp, TrackEq } from '../types';
import { outputOf, sendAmount, sendsOf, sidechainOf } from '../audio/routing';
import { KIND_ICON, Reduction, Slider, Spectrum } from './ui';

const num = (v: number, d = 1) => v.toFixed(d).replace('.', ',');
const hz = (f: number) => (f >= 1000 ? `${num(f / 1000, f >= 10000 ? 1 : 2)} kHz` : `${Math.round(f)} Hz`);
const signed = (v: number) => `${v > 0 ? '+' : ''}${num(v)} dB`;

/** posição 0..1 de uma frequência no gráfico (escala logarítmica, igual à do espectro) */
const fx = (f: number) => Math.log(f / EQ_F_MIN) / Math.log(EQ_F_MAX / EQ_F_MIN);
const fFromX = (x: number) => EQ_F_MIN * (EQ_F_MAX / EQ_F_MIN) ** Math.min(1, Math.max(0, x));
/** posição 0..1 (de cima para baixo) de um ganho no gráfico */
const gy = (db: number) => 0.5 - (db / EQ_GAIN_MAX) * 0.46;
const gFromY = (y: number) => Math.max(-EQ_GAIN_MAX, Math.min(EQ_GAIN_MAX, ((0.5 - y) / 0.46) * EQ_GAIN_MAX));

/** Trilha atual do store (dentro de gestos, para não usar um valor velho). */
const fresh = (id: string) => useStore.getState().project.tracks.find((t) => t.id === id);

function setEq(id: string, fn: (eq: TrackEq) => TrackEq, history = false) {
  const t = fresh(id);
  if (t) useStore.getState().updateTrack(id, { fx: { ...t.fx, eq: fn(eqOf(t.fx)) } }, history);
}
function setComp(id: string, fn: (c: TrackComp) => TrackComp, history = false) {
  const t = fresh(id);
  if (t) useStore.getState().updateTrack(id, { fx: { ...t.fx, compressor: fn(compOf(t.fx)) } }, history);
}

type Handle = 'hp' | 'lp' | 0 | 1 | 2 | 3;
const N_POINTS = 240;
const FREQS = Float32Array.from({ length: N_POINTS }, (_, i) => fFromX(i / (N_POINTS - 1)));

// ---------- EQ ----------

export function EqEditor({ track: t }: { track: Track }) {
  const eq = eqOf(t.fx);
  const [sel, setSel] = useState<Handle>(1);
  const plot = useRef<HTMLDivElement>(null);
  const lastWheel = useRef(0);

  const curve = useMemo(() => {
    const db = eqResponse(eq, FREQS);
    const pts = Array.from(db, (v, i) => `${((i / (N_POINTS - 1)) * 1000).toFixed(1)},${(gy(Math.max(-EQ_GAIN_MAX * 1.1, Math.min(EQ_GAIN_MAX * 1.1, v))) * 100).toFixed(2)}`);
    return { line: `M${pts.join(' L')}`, area: `M0,50 L${pts.join(' L')} L1000,50 Z` };
  }, [eq]);

  const pos = (h: Handle): [number, number] => {
    if (h === 'hp') return [fx(eq.hp.freq), gy(0)];
    if (h === 'lp') return [fx(eq.lp.freq), gy(0)];
    const b = eq.bands[h];
    return [fx(b.freq), gy(b.on ? b.gain : 0)];
  };
  const isOn = (h: Handle) => (h === 'hp' ? eq.hp.on : h === 'lp' ? eq.lp.on : eq.bands[h].on);

  const drag = (h: Handle) => (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    setSel(h);
    useStore.getState().snapshot();
    const el = e.currentTarget as HTMLElement;
    try {
      el.setPointerCapture(e.pointerId);
    } catch {
      /* segue sem captura */
    }
    const move = (ev: PointerEvent) => {
      const r = plot.current!.getBoundingClientRect();
      const x = (ev.clientX - r.left) / r.width;
      const y = (ev.clientY - r.top) / r.height;
      const f = Math.round(fFromX(x));
      setEq(t.id, (q) => {
        if (h === 'hp') return { ...q, hp: { ...q.hp, on: true, freq: Math.min(f, 2000) } };
        if (h === 'lp') return { ...q, lp: { ...q.lp, on: true, freq: Math.max(f, 1000) } };
        const bands = q.bands.slice();
        bands[h] = { ...bands[h], on: true, freq: f, gain: Math.round(gFromY(y) * 2) / 2 };
        return { ...q, bands };
      });
    };
    const up = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  };

  // roda do mouse sobre um ponto: largura (Q) dos médios
  useEffect(() => {
    const el = plot.current!;
    const wheel = (e: WheelEvent) => {
      const target = (e.target as HTMLElement).closest('[data-band]') as HTMLElement | null;
      if (!target) return;
      const h = Number(target.dataset.band);
      if (BAND_TYPES[h] !== 'peaking') return;
      e.preventDefault();
      const now = performance.now();
      if (now - lastWheel.current > 400) useStore.getState().snapshot();
      lastWheel.current = now;
      setSel(h as Handle);
      setEq(t.id, (q) => {
        const bands = q.bands.slice();
        const b = bands[h];
        bands[h] = { ...b, q: Math.min(12, Math.max(0.2, b.q * (e.deltaY < 0 ? 1.12 : 1 / 1.12))) };
        return { ...q, bands };
      });
    };
    el.addEventListener('wheel', wheel, { passive: false });
    return () => el.removeEventListener('wheel', wheel);
  }, [t.id]);

  const toggle = (h: Handle) =>
    setEq(t.id, (q) => {
      if (h === 'hp') return { ...q, hp: { ...q.hp, on: !q.hp.on } };
      if (h === 'lp') return { ...q, lp: { ...q.lp, on: !q.lp.on } };
      const bands = q.bands.slice();
      bands[h] = { ...bands[h], on: !bands[h].on };
      return { ...q, bands };
    }, true);

  const handles: Handle[] = ['hp', 0, 1, 2, 3, 'lp'];
  const color = (h: Handle) => (h === 'hp' || h === 'lp' ? '#5fb4ff' : BAND_COLORS[h]);
  const label = (h: Handle) => (h === 'hp' ? 'PA' : h === 'lp' ? 'PB' : String(h + 1));

  return (
    <div className="fx-card wide eq-card">
      <div className="eq-head">
        <h4>Equalizador</h4>
        <small className="eq-tip">Arraste os pontos · roda do mouse num médio ajusta a largura · duplo clique liga/desliga</small>
        <button className="eq-reset" onClick={() => setEq(t.id, () => defaultEq(), true)}>Zerar EQ</button>
      </div>
      <div className="eq-graph">
        <Spectrum trackId={t.id} color={t.color} points={200} labels className="eq-spec" />
        <div className="eq-plot" ref={plot}>
          <svg viewBox="0 0 1000 100" preserveAspectRatio="none">
            {[-12, -6, 6, 12].map((g) => (
              <line key={g} x1="0" x2="1000" y1={gy(g) * 100} y2={gy(g) * 100} className="eq-grid" />
            ))}
            <line x1="0" x2="1000" y1="50" y2="50" className="eq-zero" />
            <path d={curve.area} className="eq-area" />
            <path d={curve.line} className="eq-line" />
          </svg>
          {[12, 6, -6, -12].map((g) => (
            <span key={g} className="eq-db" style={{ top: `${gy(g) * 100}%` }}>{g > 0 ? `+${g}` : g}</span>
          ))}
          {handles.map((h) => {
            const [x, y] = pos(h);
            return (
              <div
                key={h}
                data-band={h}
                className={`eq-handle ${sel === h ? 'sel' : ''} ${isOn(h) ? '' : 'off'}`}
                style={{ left: `${x * 100}%`, top: `${y * 100}%`, '--c': color(h) } as React.CSSProperties}
                onPointerDown={drag(h)}
                onDoubleClick={() => toggle(h)}
                title={h === 'hp' ? 'Passa-altas' : h === 'lp' ? 'Passa-baixas' : BAND_NAMES[h]}
              >
                {label(h)}
              </div>
            );
          })}
        </div>
      </div>
      <div className="eq-bands">
        {handles.map((h) => (
          <BandControls key={h} h={h} eq={eq} trackId={t.id} selected={sel === h} color={color(h)} onSelect={() => setSel(h)} onToggle={() => toggle(h)} />
        ))}
      </div>
    </div>
  );
}

/** Slider de frequência em escala logarítmica. */
function FreqSlider({ value, min, max, onChange, reset }: { value: number; min: number; max: number; onChange: (f: number) => void; reset: number }) {
  const to = (f: number) => (Math.log(f / min) / Math.log(max / min)) * 1000;
  const from = (v: number) => Math.round(min * (max / min) ** (v / 1000));
  return <Slider min={0} max={1000} step={1} value={to(value)} reset={to(reset)} onChange={(v) => onChange(from(v))} />;
}

function BandControls({ h, eq, trackId, selected, color, onSelect, onToggle }: {
  h: Handle; eq: TrackEq; trackId: string; selected: boolean; color: string; onSelect: () => void; onToggle: () => void;
}) {
  const band = typeof h === 'number' ? eq.bands[h] : null;
  const on = h === 'hp' ? eq.hp.on : h === 'lp' ? eq.lp.on : band!.on;
  const name = h === 'hp' ? 'Passa-altas' : h === 'lp' ? 'Passa-baixas' : BAND_NAMES[h];
  const setBand = (patch: Partial<TrackEq['bands'][number]>) =>
    setEq(trackId, (q) => {
      const bands = q.bands.slice();
      bands[h as number] = { ...bands[h as number], ...patch };
      return { ...q, bands };
    });
  const def = defaultEq();
  return (
    <div className={`eq-band ${selected ? 'sel' : ''} ${on ? '' : 'off'}`} style={{ '--c': color } as React.CSSProperties} onPointerDown={onSelect}>
      <div className="eq-band-head">
        <button className={on ? 'toggle on' : 'toggle'} onClick={onToggle} title={on ? 'Desligar' : 'Ligar'}>{on ? '●' : '○'}</button>
        <b>{name}</b>
      </div>
      {h === 'hp' && (
        <>
          <span className="eq-v">{hz(eq.hp.freq)}</span>
          <FreqSlider value={eq.hp.freq} min={EQ_F_MIN} max={2000} reset={def.hp.freq} onChange={(f) => setEq(trackId, (q) => ({ ...q, hp: { ...q.hp, freq: f } }))} />
          <div className="presets">
            {([12, 24] as const).map((s) => (
              <button key={s} className={eq.hp.slope === s ? 'on' : ''} onClick={() => setEq(trackId, (q) => ({ ...q, hp: { ...q.hp, slope: s } }), true)}>
                {s} dB/oit
              </button>
            ))}
          </div>
        </>
      )}
      {h === 'lp' && (
        <>
          <span className="eq-v">{hz(eq.lp.freq)}</span>
          <FreqSlider value={eq.lp.freq} min={1000} max={EQ_F_MAX} reset={def.lp.freq} onChange={(f) => setEq(trackId, (q) => ({ ...q, lp: { ...q.lp, freq: f } }))} />
        </>
      )}
      {band && (
        <>
          <span className="eq-v">{hz(band.freq)} · {signed(band.gain)}</span>
          <FreqSlider value={band.freq} min={EQ_F_MIN} max={EQ_F_MAX} reset={def.bands[h as number].freq} onChange={(f) => setBand({ freq: f })} />
          <Slider min={-EQ_GAIN_MAX} max={EQ_GAIN_MAX} step={0.5} value={band.gain} reset={0} onChange={(g) => setBand({ gain: g })} title="Ganho" />
          {BAND_TYPES[h as number] === 'peaking' && (
            <>
              <span className="eq-v small">Largura Q {num(band.q, 2)}</span>
              <Slider min={0} max={1000} step={1} value={(Math.log(band.q / 0.2) / Math.log(60)) * 1000} reset={(Math.log(1 / 0.2) / Math.log(60)) * 1000}
                onChange={(v) => setBand({ q: Math.round(0.2 * 60 ** (v / 1000) * 100) / 100 })} title="Largura (Q): baixo = largo, alto = estreito" />
            </>
          )}
        </>
      )}
    </div>
  );
}

// ---------- Compressor ----------

export function CompEditor({ track: t }: { track: Track }) {
  const c = compOf(t.fx);
  const set = (k: keyof TrackComp) => (v: number) => setComp(t.id, (x) => ({ ...x, [k]: v }));
  const active = COMP_PRESETS.find((p) => (Object.keys(p.c) as (keyof typeof p.c)[]).every((k) => p.c[k] === c[k]));
  return (
    <div className="fx-card comp-card">
      <div className="eq-head">
        <h4>Compressor</h4>
        <button className={c.on ? 'toggle on' : 'toggle'} onClick={() => setComp(t.id, (x) => ({ ...x, on: !x.on }), true)}>{c.on ? 'Ligado' : 'Desligado'}</button>
      </div>
      <div className="presets">
        {COMP_PRESETS.map((p) => (
          <button key={p.id} title={p.desc} className={active?.id === p.id ? 'on' : ''} onClick={() => setComp(t.id, () => ({ on: true, ...p.c }), true)}>
            {p.name}
          </button>
        ))}
      </div>
      <div className="comp-body">
        <div className="comp-sliders">
          <CRow label="Limiar" v={`${num(c.threshold)} dB`}><Slider min={-60} max={0} step={0.5} value={c.threshold} reset={DEFAULT_COMP.threshold} onChange={set('threshold')} /></CRow>
          <CRow label="Razão" v={`${num(c.ratio)} : 1`}><Slider min={1} max={20} step={0.1} value={c.ratio} reset={DEFAULT_COMP.ratio} onChange={set('ratio')} /></CRow>
          <CRow label="Ataque" v={`${num(c.attack, c.attack < 10 ? 1 : 0)} ms`}><Slider min={0.1} max={100} step={0.1} value={c.attack} reset={DEFAULT_COMP.attack} onChange={set('attack')} /></CRow>
          <CRow label="Recuperação" v={`${Math.round(c.release)} ms`}><Slider min={10} max={1000} step={5} value={c.release} reset={DEFAULT_COMP.release} onChange={set('release')} /></CRow>
          <CRow label="Joelho" v={`${num(c.knee)} dB`}><Slider min={0} max={30} step={0.5} value={c.knee} reset={DEFAULT_COMP.knee} onChange={set('knee')} /></CRow>
          <CRow label="Compensação" v={signed(c.makeup)}><Slider min={0} max={24} step={0.5} value={c.makeup} reset={0} onChange={set('makeup')} /></CRow>
        </div>
        <TransferCurve c={c} />
      </div>
      <Reduction get={() => (c.on && engine.ready ? engine.mixer.strips.get(t.id)?.comp.reduction ?? 0 : 0)} />
    </div>
  );
}

function CRow({ label, v, children }: { label: string; v: string; children: React.ReactNode }) {
  return (
    <div className="m-row">
      <span className="m-label">{label}</span>
      {children}
      <span className="fx-val">{v}</span>
    </div>
  );
}

/** Curva de transferência: volume de entrada × saída (com o joelho e a compensação). */
function TransferCurve({ c }: { c: TrackComp }) {
  const out = (x: number) => {
    if (!c.on) return x;
    const { threshold: T, ratio: R, knee: K } = c;
    let y: number;
    if (2 * (x - T) < -K) y = x;
    else if (2 * Math.abs(x - T) <= K && K > 0) y = x + ((1 / R - 1) * (x - T + K / 2) ** 2) / (2 * K);
    else y = T + (x - T) / R;
    return y + c.makeup;
  };
  const pts = Array.from({ length: 61 }, (_, i) => {
    const x = -60 + i;
    const y = Math.max(-60, Math.min(0, out(x)));
    return `${((x + 60) / 60) * 100},${(-y / 60) * 100}`;
  });
  return (
    <svg className="comp-curve" viewBox="0 0 100 100" preserveAspectRatio="none">
      <line x1="0" y1="100" x2="100" y2="0" className="eq-grid" />
      {c.on && <line x1={((c.threshold + 60) / 60) * 100} x2={((c.threshold + 60) / 60) * 100} y1="0" y2="100" className="eq-zero" />}
      <polyline points={pts.join(' ')} className="eq-line" />
    </svg>
  );
}

// ---------- Envios, saída e sidechain ----------

/** Quanto a trilha manda para cada efeito de envio, e para onde vai a saída dela. */
export function SendsCard({ track: t }: { track: Track }) {
  const sends = useStore((s) => sendsOf(s.project));
  const tracks = useStore((s) => s.project.tracks);
  const buses = tracks.filter((b) => b.kind === 'bus');
  const setSend = (id: string, v: number) => {
    const tr = fresh(t.id);
    if (tr) useStore.getState().updateTrack(t.id, { sends: { ...tr.sends, [id]: v } }, false);
  };
  return (
    <div className="fx-card sends-card">
      <h4>Envios e saída</h4>
      {sends.map((s) => (
        <CRow key={s.id} label={s.name} v={`${Math.round(sendAmount(t, s.id) * 100)}%`}>
          <Slider min={0} max={1} step={0.01} value={sendAmount(t, s.id)} reset={0} onChange={(v) => setSend(s.id, v)} />
        </CRow>
      ))}
      {t.kind !== 'bus' && (
        <>
          <span className="m-label">Saída</span>
          <select className="out-select" value={outputOf(t, tracks)?.id ?? ''} onChange={(e) => useStore.getState().updateTrack(t.id, { output: e.target.value || undefined })}>
            <option value="">Master</option>
            {buses.map((b) => <option key={b.id} value={b.id}>Grupo: {b.name}</option>)}
          </select>
        </>
      )}
      <small className="hint">Os efeitos de envio (tipo de reverb, tempo do eco) se configuram na aba Mixer.</small>
    </div>
  );
}

/** Sidechain: outra trilha (normalmente o bumbo) abaixa o volume desta quando toca. */
export function SidechainCard({ track: t }: { track: Track }) {
  const tracks = useStore((s) => s.project.tracks);
  const sc = sidechainOf(t);
  const sources = tracks.filter((x) => x.id !== t.id && x.kind !== 'bus');
  const set = (patch: Partial<Sidechain>, history = false) => {
    const tr = fresh(t.id);
    if (tr) useStore.getState().updateTrack(t.id, { fx: { ...tr.fx, sidechain: { ...sidechainOf(tr), ...patch } } }, history);
  };
  return (
    <div className="fx-card sc-card">
      <h4>Sidechain</h4>
      <span className="m-label">Abaixar quando toca</span>
      <select className="out-select" value={sc.source ?? ''} onChange={(e) => set({ source: e.target.value || null }, true)}>
        <option value="">Desligado</option>
        {sources.map((x) => <option key={x.id} value={x.id}>{KIND_ICON[x.kind]} {x.name}</option>)}
      </select>
      {sc.source && (
        <>
          <CRow label="Quanto abaixa" v={`-${num(sc.depth)} dB`}><Slider min={1} max={30} step={0.5} value={sc.depth} reset={9} onChange={(v) => set({ depth: v })} /></CRow>
          <CRow label="Sensibilidade" v={`${Math.round(sc.sens * 100)}%`}><Slider min={0} max={0.95} step={0.01} value={sc.sens} reset={0.6} onChange={(v) => set({ sens: v })} /></CRow>
          <CRow label="Volta em" v={`${Math.round(sc.release)} ms`}><Slider min={30} max={800} step={5} value={sc.release} reset={180} onChange={(v) => set({ release: v })} /></CRow>
          <Reduction get={() => {
            const g = engine.ready ? engine.duckLevel(t.id) : 1;
            return 20 * Math.log10(Math.max(1e-4, g));
          }} />
        </>
      )}
      <small className="hint">O "bombeado" do pop e do eletrônico: o bumbo abaixa o baixo ou o pad para cada batida aparecer.</small>
    </div>
  );
}
