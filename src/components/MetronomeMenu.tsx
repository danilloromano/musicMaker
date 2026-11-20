import { useEffect, useRef, useState } from 'react';
import { useStore } from '../store';
import { METERS, meterId, meterOf } from '../types';
import { Slider } from './ui';

const SUBS_4 = [
  { v: 1, name: 'Nenhuma' },
  { v: 2, name: 'Colcheias' },
  { v: 3, name: 'Tercinas' },
  { v: 4, name: 'Semicolcheias' },
];
const SUBS_8 = [
  { v: 1, name: 'Só os tempos fortes' },
  { v: 2, name: 'Todas as colcheias' },
];

/** Opções do metrônomo: compasso da música, subdivisão, volume e o treino de velocidade. */
export function MetronomeMenu() {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const meter = meterOf({ meter: useStore((s) => s.project.meter) });
  const bpm = useStore((s) => s.project.bpm);
  const metro = useStore((s) => s.metro);
  const st = useStore.getState();
  const tr = metro.trainer;
  const subs = meter.den === 8 ? SUBS_8 : SUBS_4;

  // fecha ao clicar fora ou com Esc
  useEffect(() => {
    if (!open) return;
    const down = (e: PointerEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
    // captura + stopPropagation: o Esc só fecha o menu (sem voltar o cursor ao início)
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      setOpen(false);
    };
    window.addEventListener('pointerdown', down, true);
    window.addEventListener('keydown', key, true);
    return () => {
      window.removeEventListener('pointerdown', down, true);
      window.removeEventListener('keydown', key, true);
    };
  }, [open]);

  const setTrainer = (patch: Partial<typeof tr>) => st.setMetro({ trainer: { ...tr, ...patch } });

  return (
    <div className="metro-menu" ref={box}>
      <button className={`metro-more ${open ? 'on' : ''}`} title="Opções do metrônomo: compasso, subdivisão, volume e treino de velocidade" onClick={() => setOpen(!open)}>
        ▾
      </button>
      {open && (
        <div className="metro-pop" role="dialog" aria-label="Metrônomo">
          <label>
            Compasso
            <select
              value={meterId(meter)}
              title="Compasso da música: muda a grade, a régua, a contagem e o metrônomo"
              onChange={(e) => {
                const m = METERS.find((x) => x.id === e.target.value)!.meter;
                st.update((p) => ({ ...p, meter: m.num === 4 && m.den === 4 ? undefined : m }));
              }}
            >
              {METERS.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
            </select>
          </label>
          <label>
            Subdivisão
            <select value={Math.min(metro.sub, subs[subs.length - 1].v)} onChange={(e) => st.setMetro({ sub: +e.target.value })}>
              {subs.map((x) => <option key={x.v} value={x.v}>{x.name}</option>)}
            </select>
          </label>
          <label>
            Volume
            <Slider min={0} max={1} step={0.01} value={metro.vol} reset={0.8} onChange={(v) => st.setMetro({ vol: v })} />
          </label>

          <div className="metro-train">
            <label className="metro-check" title="Sobe o andamento aos poucos enquanto toca; ao parar, volta ao andamento original">
              <input type="checkbox" checked={tr.on} onChange={(e) => setTrainer({ on: e.target.checked, max: Math.max(tr.max, bpm + tr.step) })} />
              Treino de velocidade
            </label>
            <div className={`metro-train-row ${tr.on ? '' : 'off'}`}>
              <span>Sobe</span>
              <select value={tr.step} onChange={(e) => setTrainer({ step: +e.target.value })}>
                {[1, 2, 3, 5, 10].map((v) => <option key={v} value={v}>+{v}</option>)}
              </select>
              <span>BPM a cada</span>
              <select value={tr.every} onChange={(e) => setTrainer({ every: +e.target.value })}>
                {[1, 2, 4, 8, 16].map((v) => <option key={v} value={v}>{v}</option>)}
              </select>
              <span>compasso{tr.every > 1 ? 's' : ''}, até</span>
              <input
                type="number"
                min={41}
                max={240}
                value={tr.max}
                onChange={(e) => setTrainer({ max: Math.max(41, Math.min(240, Math.round(+e.target.value) || tr.max)) })}
              />
              <span>BPM</span>
            </div>
            {tr.on && <small className="hint">Começa em {bpm} BPM. Combine com o loop para repetir um trecho; ao parar, volta para {bpm}.</small>}
          </div>
        </div>
      )}
    </div>
  );
}
