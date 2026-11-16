// Aba "Master": medidores de loudness (LUFS, pico real, correlação), presets e a cadeia do master
// (EQ, compressor de cola, saturação, limitador) e o alvo de loudness da exportação.
import { useRef } from 'react';
import { engine } from '../audio/engine';
import { DEFAULT_MASTER, EXPORT_TARGETS, MASTER_PRESETS, masterOf } from '../audio/master';
import { MAX_AUTO_GAIN } from '../audio/export';
import { useStore } from '../store';
import { MasterSettings } from '../types';
import { Slider, Spectrum, useRaf } from './ui';

const fmt = (v: number | undefined, digits = 1) => (v === undefined || !Number.isFinite(v) ? '–∞' : v.toFixed(digits).replace('.', ','));
const signed = (v: number, unit: string) => `${v > 0 ? '+' : ''}${fmt(v)} ${unit}`;

/** Muda o master do projeto (sliders: o próprio Slider já marca o desfazer; botões: `history`). */
function setMaster(fn: (m: MasterSettings) => MasterSettings, history = false) {
  useStore.getState().update((p) => ({ ...p, master: fn(masterOf(p.master)) }), history);
}

export function MasterPanel() {
  const m = useStore((s) => masterOf(s.project.master));
  const last = useStore((s) => s.lastExport);
  const target = EXPORT_TARGETS.find((t) => t.id === m.exportTarget)!;
  const active = MASTER_PRESETS.find(
    (p) => JSON.stringify(p.s) === JSON.stringify({ eq: m.eq, comp: m.comp, saturation: m.saturation, limiter: m.limiter }),
  );
  const eq = (k: keyof MasterSettings['eq']) => (v: number) => setMaster((x) => ({ ...x, eq: { ...x.eq, [k]: v } }));
  const comp = (k: keyof MasterSettings['comp']) => (v: number | boolean) => setMaster((x) => ({ ...x, comp: { ...x.comp, [k]: v } }), typeof v === 'boolean');
  const lim = (k: keyof MasterSettings['limiter']) => (v: number | boolean) => setMaster((x) => ({ ...x, limiter: { ...x.limiter, [k]: v } }), typeof v === 'boolean');

  return (
    <div className="fx master">
      <div className="fx-card wide">
        <h4>Preset de master</h4>
        <div className="presets">
          {MASTER_PRESETS.map((p) => (
            <button key={p.id} className={active?.id === p.id ? 'on' : ''} title={p.desc} onClick={() => setMaster((x) => ({ ...x, ...p.s }), true)}>
              {p.name}
            </button>
          ))}
        </div>
      </div>

      <Meters target={target.lufs} ceiling={m.limiter.ceiling} />

      <div className="fx-card wide">
        <h4>Espectro do master (Hz)</h4>
        <Spectrum color="#00d455" points={160} labels className="big" />
      </div>

      <div className="fx-card">
        <h4>EQ</h4>
        <Row label="Graves 100 Hz" v={m.eq.low} unit="dB" min={-12} max={12} step={0.5} reset={0} onChange={eq('low')} />
        <Row label="Médio-graves 400 Hz" v={m.eq.lowMid} unit="dB" min={-12} max={12} step={0.5} reset={0} onChange={eq('lowMid')} />
        <Row label="Presença 3 kHz" v={m.eq.highMid} unit="dB" min={-12} max={12} step={0.5} reset={0} onChange={eq('highMid')} />
        <Row label="Brilho 10 kHz" v={m.eq.high} unit="dB" min={-12} max={12} step={0.5} reset={0} onChange={eq('high')} />
      </div>

      <div className="fx-card">
        <h4>Compressor (cola)</h4>
        <button className={m.comp.on ? 'toggle on' : 'toggle'} onClick={() => comp('on')(!m.comp.on)}>{m.comp.on ? 'Ligado' : 'Desligado'}</button>
        <Row label="Limiar" v={m.comp.threshold} unit="dB" min={-40} max={0} step={0.5} reset={DEFAULT_MASTER.comp.threshold} onChange={comp('threshold')} />
        <Row label="Razão" v={m.comp.ratio} unit=": 1" min={1} max={10} step={0.1} reset={DEFAULT_MASTER.comp.ratio} onChange={comp('ratio')} />
        <Row label="Ataque" v={m.comp.attack} unit="ms" min={1} max={100} step={1} reset={DEFAULT_MASTER.comp.attack} onChange={comp('attack')} />
        <Row label="Recuperação" v={m.comp.release} unit="ms" min={30} max={1000} step={10} reset={DEFAULT_MASTER.comp.release} onChange={comp('release')} />
        <Row label="Compensação" v={m.comp.makeup} unit="dB" min={0} max={12} step={0.5} reset={0} onChange={comp('makeup')} />
        <Reduction get={() => engine.ready ? engine.mixer.chain.compReduction() : 0} />
      </div>

      <div className="fx-card">
        <h4>Saturação</h4>
        <Row label="Calor" v={m.saturation * 100} unit="%" min={0} max={100} step={1} reset={0} onChange={(v) => setMaster((x) => ({ ...x, saturation: v / 100 }))} />
        <small className="hint">Harmônicos suaves de fita/válvula: deixa a mix mais encorpada.</small>
      </div>

      <div className="fx-card">
        <h4>Limitador</h4>
        <button className={m.limiter.on ? 'toggle on' : 'toggle'} onClick={() => lim('on')(!m.limiter.on)}>{m.limiter.on ? 'Ligado' : 'Desligado'}</button>
        <Row label="Ganho" v={m.limiter.gain} unit="dB" min={0} max={20} step={0.5} reset={0} onChange={lim('gain')} />
        <Row label="Teto (pico real)" v={m.limiter.ceiling} unit="dBTP" min={-3} max={-0.1} step={0.1} reset={-1} onChange={lim('ceiling')} />
        <Row label="Recuperação" v={m.limiter.release} unit="ms" min={10} max={500} step={5} reset={120} onChange={lim('release')} />
        <Reduction get={() => (engine.ready ? engine.mixer.chain.reading?.reduction ?? 0 : 0)} />
      </div>

      <div className="fx-card export">
        <h4>Exportação</h4>
        <label className="hint">Alvo de loudness</label>
        <select value={m.exportTarget} onChange={(e) => setMaster((x) => ({ ...x, exportTarget: e.target.value as MasterSettings['exportTarget'] }), true)}>
          {EXPORT_TARGETS.map((t) => (
            <option key={t.id} value={t.id}>{t.label}</option>
          ))}
        </select>
        <label className="hint">Formato</label>
        <div className="presets">
          {([24, 16] as const).map((b) => (
            <button key={b} className={m.exportBits === b ? 'on' : ''} onClick={() => setMaster((x) => ({ ...x, exportBits: b }), true)}>
              WAV {b} bits
            </button>
          ))}
        </div>
        <small className="hint">
          {target.lufs !== null
            ? `Na exportação, o ganho do limitador é ajustado sozinho até a música ficar em ${target.lufs} LUFS, com picos até ${fmt(m.limiter.ceiling)} dBTP.`
            : 'A música sai com o ganho do limitador ajustado aqui.'}
          {m.exportBits === 16 ? ' 16 bits recebe dither (ruído inaudível que evita distorção).' : ''}
        </small>
        {last && (
          <div className="last-export">
            Última exportação: <b>{fmt(last.lufs)} LUFS</b> · pico real <b>{fmt(last.truePeak)} dBTP</b>
            {last.target !== null ? ` · alvo ${last.target}` : ''} · limitador {signed(last.gain, 'dB')}
            {last.target !== null && last.lufs < last.target - 0.5 && (
              <div className="warn">
                Não deu para chegar ao alvo só com o limitador sem distorcer a música (limite de +{MAX_AUTO_GAIN} dB). Ligue o compressor e a
                saturação do master, ou escolha um alvo menor.
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function Row({ label, v, unit, min, max, step, reset, onChange }: {
  label: string; v: number; unit: string; min: number; max: number; step: number; reset: number; onChange: (v: number) => void;
}) {
  return (
    <div className="m-row">
      <span className="m-label">{label}</span>
      <Slider min={min} max={max} step={step} value={v} reset={reset} onChange={onChange} />
      <span className="fx-val">{unit === 'dB' ? signed(v, unit) : `${fmt(v, step < 1 ? 1 : 0)} ${unit}`}</span>
    </div>
  );
}

/** Barra de redução de ganho (0 a -12 dB), atualizada a cada quadro. */
function Reduction({ get }: { get: () => number }) {
  const bar = useRef<HTMLDivElement>(null);
  const txt = useRef<HTMLSpanElement>(null);
  const shown = useRef(0);
  useRaf(() => {
    const r = Math.min(0, get());
    shown.current = r < shown.current ? r : shown.current * 0.9 + r * 0.1;
    if (bar.current) bar.current.style.width = `${Math.min(100, (-shown.current / 12) * 100)}%`;
    if (txt.current) txt.current.textContent = `${fmt(shown.current)} dB`;
  });
  return (
    <div className="m-gr" title="Redução de ganho">
      <div className="m-gr-track"><div className="m-gr-fill" ref={bar} /></div>
      <span ref={txt} />
    </div>
  );
}

/** Leituras de loudness do master, atualizadas a cada quadro. */
function Meters({ target, ceiling }: { target: number | null; ceiling: number }) {
  const refs = {
    m: useRef<HTMLSpanElement>(null),
    s: useRef<HTMLSpanElement>(null),
    i: useRef<HTMLSpanElement>(null),
    tp: useRef<HTMLSpanElement>(null),
    corr: useRef<HTMLDivElement>(null),
    corrTxt: useRef<HTMLSpanElement>(null),
  };
  useRaf(() => {
    const chain = engine.ready ? engine.mixer.chain : null;
    const r = chain?.reading;
    const put = (el: HTMLElement | null, v: number | undefined) => el && (el.textContent = fmt(v));
    // abaixo de -70 LUFS é silêncio para o padrão (comporta absoluta)
    const lu = (v: number | undefined) => (v !== undefined && v > -70 ? v : undefined);
    put(refs.m.current, lu(r?.momentary));
    put(refs.s.current, lu(r?.shortTerm));
    put(refs.i.current, lu(r?.integrated));
    put(refs.tp.current, chain?.maxTruePeak);
    refs.tp.current?.classList.toggle('over', (chain?.maxTruePeak ?? -Infinity) > ceiling + 0.05);
    const c = r?.correlation ?? 0;
    if (refs.corr.current) {
      refs.corr.current.style.left = `${((c + 1) / 2) * 100}%`;
      refs.corr.current.classList.toggle('bad', c < 0);
    }
    if (refs.corrTxt.current) refs.corrTxt.current.textContent = fmt(c, 2);
  });
  return (
    <div className="fx-card wide m-meters">
      <h4>Loudness</h4>
      <div className="m-readouts">
        <div><small>Momentâneo</small><span ref={refs.m} /><em>LUFS</em></div>
        <div><small>Curto prazo (3 s)</small><span ref={refs.s} /><em>LUFS</em></div>
        <div className="main">
          <small>Integrado {target !== null ? `(alvo ${target})` : ''}</small>
          <span ref={refs.i} />
          <em>LUFS</em>
        </div>
        <div>
          <small>Pico real máx.</small>
          <span ref={refs.tp} className="tp" title="Clique para zerar" onClick={() => engine.ready && (engine.mixer.chain.maxTruePeak = -Infinity)} />
          <em>dBTP</em>
        </div>
        <div className="m-corr">
          <small>Correlação de fase</small>
          <div className="m-corr-track"><div className="m-corr-dot" ref={refs.corr} /></div>
          <span ref={refs.corrTxt} className="small" />
        </div>
      </div>
      <small className="hint">
        O integrado mede desde o último play. Plataformas de streaming baixam o volume de músicas acima de -14 LUFS; correlação
        abaixo de 0 indica problema de fase (a música pode sumir em som mono).
      </small>
    </div>
  );
}
