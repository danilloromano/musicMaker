// Aba "Mixer": a mesa de som — um canal por trilha e grupo (fader, medidor com aviso de clipping, pan,
// envios, saída, mudo/solo), os retornos dos efeitos de envio (configuráveis) e o master.
import { useRef } from 'react';
import { engine } from '../audio/engine';
import { faderGain } from '../audio/mixer';
import { DIVISIONS, SPACES, newSend, outputOf, sendAmount, sendsOf, sidechainOf } from '../audio/routing';
import { compOf, eqOf } from '../audio/trackfx';
import { useStore } from '../store';
import { SendFx, Track, uid } from '../types';
import { RotaryKnob } from './RotaryKnob';
import { KIND_ICON, Slider, useRaf } from './ui';

const dbText = (g: number) => {
  if (g <= 1e-4) return '–∞';
  const db = 20 * Math.log10(g);
  return `${db > 0 ? '+' : ''}${db.toFixed(1).replace('.', ',')}`;
};

const fresh = (id: string) => useStore.getState().project.tracks.find((t) => t.id === id);

function setSends(fn: (s: SendFx[]) => SendFx[], history = false) {
  useStore.getState().update((p) => ({ ...p, sends: fn(sendsOf(p)) }), history);
}

export function MixerPanel() {
  const project = useStore((s) => s.project);
  const sends = sendsOf(project);
  // grupos depois das trilhas que os alimentam
  const tracks = [...project.tracks.filter((t) => t.kind !== 'bus'), ...project.tracks.filter((t) => t.kind === 'bus')];
  const addSend = (type: SendFx['type']) =>
    setSends((s) => [...s, newSend(type, uid(), s.filter((x) => x.type === type).length + 1)], true);
  return (
    <div className="mixer">
      <div className="mx-strips">
        {tracks.map((t) => <ChannelStrip key={t.id} track={t} />)}
      </div>
      <div className="mx-returns">
        {sends.map((s) => <ReturnStrip key={s.id} fx={s} />)}
        <div className="mx-add">
          <button onClick={() => addSend('reverb')} title="Novo efeito de envio: reverb">+ Reverb</button>
          <button onClick={() => addSend('delay')} title="Novo efeito de envio: eco (delay)">+ Eco</button>
        </div>
      </div>
      <MasterStrip />
    </div>
  );
}

/** Medidor vertical de pico (escala em dB, -60 a 0) com marca de pico e aviso de clipping. */
function VMeter({ read }: { read: () => number }) {
  const fill = useRef<HTMLDivElement>(null);
  const hold = useRef<HTMLDivElement>(null);
  const clip = useRef<HTMLButtonElement>(null);
  const st = useRef({ v: 0, hold: 0, holdT: 0, clipped: false });
  const pos = (lin: number) => Math.max(0, Math.min(1, (20 * Math.log10(Math.max(lin, 1e-6)) + 60) / 60));
  useRaf(() => {
    const raw = read();
    const s = st.current;
    s.v = Math.max(raw, s.v * 0.9);
    const now = performance.now();
    if (raw >= s.hold || now - s.holdT > 1500) {
      s.hold = raw;
      s.holdT = now;
    }
    if (raw >= 0.999) s.clipped = true;
    if (fill.current) fill.current.style.height = `${pos(s.v) * 100}%`;
    if (hold.current) hold.current.style.bottom = `${pos(s.hold) * 100}%`;
    clip.current?.classList.toggle('on', s.clipped);
  });
  return (
    <div className="mx-meter">
      <button ref={clip} className="mx-clip" title="Clipping (passou de 0 dB): clique para apagar" onClick={() => (st.current.clipped = false)} />
      <div className="mx-meter-track">
        <div className="mx-meter-fill" ref={fill} />
        <div className="mx-meter-hold" ref={hold} />
        {[-6, -12, -24, -48].map((d) => <span key={d} className="mx-tick" style={{ bottom: `${((d + 60) / 60) * 100}%` }} />)}
      </div>
    </div>
  );
}

function ChannelStrip({ track: t }: { track: Track }) {
  const st = useStore.getState();
  const project = useStore((s) => s.project);
  const selected = useStore((s) => s.selectedTrackId === t.id);
  const sends = sendsOf(project);
  const buses = project.tracks.filter((b) => b.kind === 'bus');
  const up = (patch: Partial<Track>, history = false) => st.updateTrack(t.id, patch, history);
  const eq = eqOf(t.fx);
  const eqOn = eq.hp.on || eq.lp.on || eq.bands.some((b) => b.on && b.gain !== 0);
  const comp = compOf(t.fx);
  const sc = sidechainOf(t).source;
  const fedBy = t.kind === 'bus' ? project.tracks.filter((c) => outputOf(c, project.tracks)?.id === t.id).length : 0;
  const openFx = () => st.set({ selectedTrackId: t.id, bottomTab: 'fx' });
  return (
    <div className={`mx-strip ${selected ? 'sel' : ''} ${t.kind === 'bus' ? 'bus' : ''}`} style={{ ['--c' as string]: t.color }} onPointerDown={() => st.set({ selectedTrackId: t.id })}>
      <div className="mx-color" />
      <div className="mx-name" title={`${t.name} (duplo clique: efeitos)`} onDoubleClick={openFx}>{KIND_ICON[t.kind]} {t.name}</div>
      {t.kind !== 'bus' ? (
        <select className="mx-out" title="Saída: master ou um grupo" value={outputOf(t, project.tracks)?.id ?? ''} onChange={(e) => up({ output: e.target.value || undefined }, true)}>
          <option value="">→ Master</option>
          {buses.map((b) => <option key={b.id} value={b.id}>→ {b.name}</option>)}
        </select>
      ) : (
        <div className="mx-out bus-info" title="Trilhas que vão para este grupo">{fedBy} trilha{fedBy === 1 ? '' : 's'}</div>
      )}
      <div className="mx-inserts">
        <button className={eqOn ? 'on' : ''} title="EQ (abre na aba Efeitos)" onClick={openFx}>EQ</button>
        <button className={comp.on ? 'on' : ''} title={comp.on ? 'Compressor ligado: clique para desligar' : 'Compressor desligado: clique para ligar'}
          onClick={() => { const tr = fresh(t.id); if (tr) up({ fx: { ...tr.fx, compressor: { ...compOf(tr.fx), on: !compOf(tr.fx).on } } }, true); }}>
          COMP
        </button>
        {sc && <button className="on" title={`Sidechain: abaixa quando ${project.tracks.find((x) => x.id === sc)?.name ?? '?'} toca`} onClick={openFx}>SC</button>}
      </div>
      <div className="mx-sends">
        {sends.map((s) => (
          <RotaryKnob key={s.id} label={s.name} size={22} value={sendAmount(t, s.id)} reset={0}
            onChange={(v) => { const tr = fresh(t.id); if (tr) up({ sends: { ...tr.sends, [s.id]: v } }); }} />
        ))}
      </div>
      <RotaryKnob label={t.pan === 0 ? 'Pan C' : `Pan ${Math.round(Math.abs(t.pan) * 100)}${t.pan < 0 ? 'E' : 'D'}`} size={24} value={(t.pan + 1) / 2} reset={0.5} onChange={(v) => up({ pan: Math.round((v * 2 - 1) * 100) / 100 })} />
      <div className="mx-fader-row">
        <input
          type="range"
          className="mx-fader"
          min={0} max={1} step={0.005} value={t.volume}
          title="Volume (duplo clique: 0 dB)"
          onPointerDown={() => st.snapshot()}
          onChange={(e) => up({ volume: +e.target.value })}
          onDoubleClick={() => up({ volume: Math.sqrt(1 / 1.4) })}
        />
        <VMeter read={() => engine.level(t.id)} />
      </div>
      <div className="mx-foot">
        <span className="mx-db" title="Volume do canal (dB)">{dbText(faderGain(t.volume))}</span>
        <button className={`ms ${t.mute ? 'mute' : ''}`} title="Mudo" onClick={() => up({ mute: !t.mute }, true)}>M</button>
        <button className={`ms ${t.solo ? 'solo' : ''}`} title="Solo" onClick={() => up({ solo: !t.solo }, true)}>S</button>
      </div>
    </div>
  );
}

function ReturnStrip({ fx }: { fx: SendFx }) {
  const set = (fn: (f: SendFx) => SendFx, history = false) => setSends((all) => all.map((x) => (x.id === fx.id ? fn(x) : x)), history);
  return (
    <div className="mx-strip ret">
      <div className="mx-color" />
      <div className="mx-ret-head">
        <span className="mx-ret-ico" title={fx.type === 'reverb' ? 'Reverb' : 'Eco'}>{fx.type === 'reverb' ? '≈' : '↻'}</span>
        <input className="mx-ret-name" value={fx.name} onChange={(e) => set((f) => ({ ...f, name: e.target.value }))} title="Nome do efeito" />
        <button className="mx-remove" title="Remover este efeito de envio" onClick={() => {
          if (confirm(`Remover o efeito "${fx.name}"? As trilhas deixam de mandar sinal para ele.`)) setSends((all) => all.filter((x) => x.id !== fx.id), true);
        }}>✕</button>
      </div>
      {fx.type === 'reverb' && fx.reverb && (
        <div className="mx-ret-cfg">
          <select value={fx.reverb.space} onChange={(e) => set((f) => ({ ...f, reverb: { ...f.reverb!, space: e.target.value as typeof fx.reverb.space } }), true)}>
            {SPACES.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
          <label>Pré-delay {Math.round(fx.reverb.predelay)} ms</label>
          <Slider min={0} max={120} step={1} value={fx.reverb.predelay} reset={20} onChange={(v) => set((f) => ({ ...f, reverb: { ...f.reverb!, predelay: v } }))} />
          <label>Brilho {Math.round(fx.reverb.tone * 100)}%</label>
          <Slider min={0} max={1} step={0.01} value={fx.reverb.tone} reset={0.5} onChange={(v) => set((f) => ({ ...f, reverb: { ...f.reverb!, tone: v } }))} />
        </div>
      )}
      {fx.type === 'delay' && fx.delay && (
        <div className="mx-ret-cfg">
          <select value={fx.delay.division} onChange={(e) => set((f) => ({ ...f, delay: { ...f.delay!, division: e.target.value as typeof fx.delay.division } }), true)}>
            {DIVISIONS.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select>
          <label>Repetições {Math.round(fx.delay.feedback * 100)}%</label>
          <Slider min={0} max={0.9} step={0.01} value={fx.delay.feedback} reset={0.35} onChange={(v) => set((f) => ({ ...f, delay: { ...f.delay!, feedback: v } }))} />
          <label>Brilho {Math.round(fx.delay.tone * 100)}%</label>
          <Slider min={0} max={1} step={0.01} value={fx.delay.tone} reset={0.5} onChange={(v) => set((f) => ({ ...f, delay: { ...f.delay!, tone: v } }))} />
          <button className={fx.delay.pingpong ? 'toggle on' : 'toggle'} onClick={() => set((f) => ({ ...f, delay: { ...f.delay!, pingpong: !f.delay!.pingpong } }), true)}>
            Pingue-pongue
          </button>
        </div>
      )}
      <div className="mx-fader-row">
        <input type="range" className="mx-fader" min={0} max={1.5} step={0.01} value={fx.level} title="Volume do retorno"
          onPointerDown={() => useStore.getState().snapshot()} onChange={(e) => set((f) => ({ ...f, level: +e.target.value }))} onDoubleClick={() => set((f) => ({ ...f, level: 1 }))} />
        <VMeter read={() => engine.returnLevel(fx.id)} />
      </div>
      <div className="mx-db">{dbText(fx.level)} dB</div>
    </div>
  );
}

function MasterStrip() {
  const lufs = useRef<HTMLSpanElement>(null);
  useRaf(() => {
    const r = engine.ready ? engine.mixer.chain.reading : null;
    if (lufs.current) lufs.current.textContent = r && r.shortTerm > -70 ? r.shortTerm.toFixed(1).replace('.', ',') : '–∞';
  });
  return (
    <div className="mx-strip master">
      <div className="mx-color" />
      <div className="mx-name">Master</div>
      <div className="mx-master-info">
        <small>Curto prazo</small>
        <span ref={lufs} />
        <small>LUFS</small>
      </div>
      <button onClick={() => useStore.getState().set({ bottomTab: 'master' })}>Abrir Master</button>
      <div className="mx-fader-row">
        <VMeter read={() => engine.level()} />
      </div>
    </div>
  );
}
