import { useRef } from 'react';
import { PEDALS, PedalDef, RIG_PRESETS, defaultRig, modelOf, paramsOf, pedalDefaults, pedalOf } from '../audio/amp';
import { engine } from '../audio/engine';
import { useStore } from '../store';
import { AmpRig, Track } from '../types';
import { AmpHead, CabView } from './AmpVisuals';
import { RotaryKnob } from './RotaryKnob';

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
  /** troca o circuito de um pedal com modelos: guarda os botões do atual e recupera os do novo */
  const setModel = (d: PedalDef, id: string) => {
    const cur = current();
    const ps = pedalOf(cur, d);
    const saved = { ...ps.saved, [modelOf(d, ps.model)!.id]: ps.p };
    set({ pedals: { ...cur.pedals, [d.id]: { ...ps, model: id, p: saved[id] ?? pedalDefaults(d, id), saved } } }, true);
  };

  const pedal = (d: PedalDef) => {
    const ps = pedalState(d);
    const model = modelOf(d, ps.model);
    const params = paramsOf(d, ps.model);
    // os valores salvos podem ter menos posições que o pedal tem hoje (botão novo): completa com os padrões
    const withValue = (i: number, v: number) => pedalDefaults(d, ps.model).map((def, j) => (j === i ? v : ps.p[j] ?? def));
    return (
      <div key={d.id} className={`stomp ${ps.on ? 'on' : ''}`} style={{ ['--c' as string]: model?.color ?? d.color }} title={model?.desc ?? d.desc}>
        <i className="screw tl" /><i className="screw tr" /><i className="screw bl" /><i className="screw br" />
        <i className="jack in" title="Entrada" /><i className="jack out" title="Saída" />
        {d.faders ? (
          <div className="stomp-faders">
            {params.map((x, i) => {
              const v = ps.p[i] ?? x.def;
              const text = x.fmt ? x.fmt(v, ps.p) : (v * 10).toFixed(1);
              return (
                <label key={x.label} className="stomp-fader" title={`${x.label}: ${text} (duplo clique volta ao padrão)`}>
                  <input
                    type="range"
                    min={0}
                    max={1}
                    step={0.01}
                    value={v}
                    aria-label={`${x.label}: ${text}`}
                    onPointerDown={() => useStore.getState().snapshot()}
                    onKeyDown={(e) => e.stopPropagation()}
                    onChange={(e) => setPedal(d, { p: withValue(i, +e.target.value) })}
                    onDoubleClick={() => {
                      useStore.getState().snapshot();
                      setPedal(d, { p: withValue(i, x.def) });
                    }}
                  />
                  <span>{x.short ?? x.label}</span>
                </label>
              );
            })}
          </div>
        ) : (
        <div className="stomp-knobs">
          {params.map((x, i) => (
            <RotaryKnob
              key={`${model?.id ?? ''}${x.label}`}
              label={x.label}
              size={params.length > 3 ? 28 : params.length > 2 ? 32 : 36}
              value={ps.p[i] ?? x.def}
              reset={x.def}
              fmt={x.fmt && ((v: number) => x.fmt!(v, ps.p))}
              onChange={(v) => setPedal(d, { p: withValue(i, v) })}
            />
          ))}
        </div>
        )}
        {d.toggles && (
          <div className="stomp-toggles">
            {d.toggles.map((tg, ti) => {
              const idx = params.length + ti;
              const side = (ps.p[idx] ?? tg.def) >= 0.5 ? 1 : 0;
              return (
                <button
                  key={tg.labels.join()}
                  className="stomp-toggle"
                  role="switch"
                  aria-checked={side === 1}
                  aria-label={`${tg.titles[side]}. Clique para trocar para ${tg.labels[1 - side]}.`}
                  title={`${tg.titles[side]} · clique para trocar`}
                  onClick={() => {
                    const p = [...ps.p];
                    const defs = pedalDefaults(d);
                    while (p.length <= idx) p.push(defs[p.length]);
                    p[idx] = 1 - side;
                    setPedal(d, { p }, true);
                  }}
                >
                  <span className={side === 0 ? 'on' : ''}>{tg.labels[0]}</span>
                  <i className={`lever ${side ? 'right' : 'left'}`} />
                  <span className={side === 1 ? 'on' : ''}>{tg.labels[1]}</span>
                </button>
              );
            })}
          </div>
        )}
        {d.models && model && (
          <select
            className="stomp-model"
            value={model.id}
            title="Circuito do pedal"
            aria-label={`${d.name}: circuito`}
            onChange={(e) => {
              setModel(d, e.target.value);
              e.currentTarget.blur();
            }}
          >
            {d.models.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
          </select>
        )}
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

        <AmpHead rig={rig} power={rig.on} set={set} />
        <CabView
          rig={rig}
          set={set}
          onLoadIr={() => irRef.current?.click()}
          irMissing={rig.cab === 'user' && !!rig.irId && !engine.buffers.has(rig.irId)}
        />
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

        {PEDALS.filter((d) => d.post).map(pedal)}
      </div>
    </div>
  );
}
