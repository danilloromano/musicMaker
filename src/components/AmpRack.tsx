import { useRef } from 'react';
import { AMPS, CABS, PEDALS, PedalDef, RIG_PRESETS, defaultRig, pedalOf } from '../audio/amp';
import { engine } from '../audio/engine';
import { useStore } from '../store';
import { AmpRig, Track } from '../types';
import { RotaryKnob } from './RotaryKnob';
import { Slider } from './ui';

const ten = (v: number) => (v * 10).toFixed(1);

function Knob({ label, value, onChange, reset = 0.5 }: { label: string; value: number; onChange: (v: number) => void; reset?: number }) {
  return (
    <label className="knob">
      <span>{label}</span>
      <Slider min={0} max={1} step={0.01} value={value} reset={reset} onChange={onChange} />
      <b>{ten(value)}</b>
    </label>
  );
}

/** Pedaleira + amplificador + caixa (impulse response) da trilha selecionada. */
export function AmpRack({ track: t }: { track: Track }) {
  const st = useStore.getState();
  const irRef = useRef<HTMLInputElement>(null);
  const rig = t.amp;

  if (!rig) {
    return (
      <div className="empty">
        <p>
          {t.kind === 'audio'
            ? 'Ligue o rack para passar a guitarra ou o baixo plugado por pedais, amplificador e caixa.'
            : 'O rack também funciona em instrumentos virtuais: experimente distorção num synth.'}
        </p>
        <button className="primary" onClick={() => st.updateTrack(t.id, { amp: defaultRig() })}>Ligar rack de amp</button>
      </div>
    );
  }

  // sempre parte do estado mais recente da loja (não do render): mexer rápido em dois controles não perde nenhum
  const current = () => useStore.getState().project.tracks.find((x) => x.id === t.id)?.amp ?? rig;
  const set = (patch: Partial<AmpRig>, history = false) => st.updateTrack(t.id, { amp: { ...current(), ...patch } }, history);
  // projetos antigos podem não ter um pedal novo (ex.: noise gate): parte dos valores padrão
  const pedalState = (d: PedalDef) => pedalOf(rig, d);
  const setPedal = (d: PedalDef, patch: { on?: boolean; p?: number[] }, history = false) => {
    const cur = current();
    set({ pedals: { ...cur.pedals, [d.id]: { ...pedalOf(cur, d), ...patch } } }, history);
  };
  const amp = AMPS.find((a) => a.id === rig.amp);

  const pedal = (d: PedalDef) => {
    const ps = pedalState(d);
    return (
      <div key={d.id} className={`stomp ${ps.on ? 'on' : ''}`} style={{ ['--c' as string]: d.color }} title={d.desc}>
        <i className="screw tl" /><i className="screw tr" /><i className="screw bl" /><i className="screw br" />
        <i className="jack in" title="Entrada" /><i className="jack out" title="Saída" />
        <div className="stomp-knobs">
          {d.params.map((x, i) => (
            <RotaryKnob
              key={x.label}
              label={x.label}
              size={d.params.length > 2 ? 32 : 36}
              value={ps.p[i] ?? x.def}
              reset={x.def}
              onChange={(v) => setPedal(d, { p: ps.p.map((o, j) => (j === i ? v : o)) })}
            />
          ))}
        </div>
        <i className="stomp-led" />
        <span className="stomp-name">{d.name}</span>
        <button
          className="stomp-switch"
          aria-pressed={ps.on}
          aria-label={`${d.name}: ${ps.on ? 'ligado' : 'desligado'}`}
          title={ps.on ? 'Pisar para desligar' : 'Pisar para ligar'}
          onClick={() => setPedal(d, { on: !ps.on }, true)}
        />
      </div>
    );
  };

  return (
    <div className={`rack ${rig.on ? '' : 'off'}`}>
      <div className="rack-bar">
        <button className={rig.on ? 'toggle on' : 'toggle'} onClick={() => set({ on: !rig.on }, true)} title="Liga/desliga o rack inteiro">
          ⏻ {rig.on ? 'Rack ligado' : 'Rack desligado'}
        </button>
        <span className="rack-lbl">Timbres prontos</span>
        <div className="presets">
          {RIG_PRESETS.map((p) => (
            <button key={p.name} onClick={() => st.updateTrack(t.id, { amp: { ...p.make(), irId: rig.irId, irName: rig.irName } })}>
              {p.name}
            </button>
          ))}
        </div>
        <span className="hint">Grava limpo: dá pra trocar o timbre depois de gravar.</span>
      </div>

      <div className="rack-chain">
        {PEDALS.filter((d) => !d.post).map(pedal)}

        <div className="amp-head">
          <h5>Amplificador</h5>
          <select value={rig.amp} onChange={(e) => { set({ amp: e.target.value }, true); e.currentTarget.blur(); }}>
            {AMPS.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            <option value="none">Sem amp (direto)</option>
          </select>
          <small>{amp?.desc ?? 'O sinal passa só pelos pedais e pela caixa.'}</small>
          {amp && (
            <div className="amp-knobs">
              {([['gain', 'Ganho'], ['bass', 'Graves'], ['mid', 'Médios'], ['treble', 'Agudos'], ['presence', 'Presença'], ['master', 'Master']] as const).map(
                ([k, label]) => (
                  <Knob key={k} label={label} value={rig.knobs[k]} reset={k === 'gain' ? 0.3 : 0.5} onChange={(v) => set({ knobs: { ...rig.knobs, [k]: v } })} />
                ),
              )}
            </div>
          )}
        </div>

        <div className="cab">
          <h5>Caixa · Impulse Response</h5>
          <select
            value={rig.cab}
            onChange={(e) => {
              set({ cab: e.target.value }, true);
              e.currentTarget.blur();
            }}
          >
            <option value="none">Sem caixa (linha)</option>
            {CABS.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            {rig.irId && <option value="user">IR: {rig.irName}</option>}
          </select>
          <button onClick={() => irRef.current?.click()} title="Carregar um arquivo de impulse response (.wav) de caixa e microfone">
            Carregar IR (.wav)…
          </button>
          {rig.cab === 'user' && rig.irId && !engine.buffers.has(rig.irId) && <small className="warn">Arquivo do IR não encontrado.</small>}
          <Knob label="Mix" value={rig.cabMix} reset={1} onChange={(v) => set({ cabMix: v })} />
          <input
            ref={irRef}
            type="file"
            accept="audio/wav,.wav,audio/*"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = '';
              if (f) void engine.loadIr(f, t.id);
            }}
          />
        </div>

        {PEDALS.filter((d) => d.post).map(pedal)}
      </div>
    </div>
  );
}
