import { useRef } from 'react';
import { PEDALS, PedalDef, RIG_PRESETS, defaultRig, pedalDefaults, pedalOf } from '../audio/amp';
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
        {d.toggles && (
          <div className="stomp-toggles">
            {d.toggles.map((tg, ti) => {
              const idx = d.params.length + ti;
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
