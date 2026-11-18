// Aba "Master": medidores de loudness (LUFS, pico real, correlação), presets e a cadeia do master
// (EQ, compressor de cola, saturação, limitador) e o alvo de loudness da exportação.
import { useEffect, useRef, useState } from 'react';
import { analyzeProject, engine, renderStems } from '../audio/engine';
import { download } from '../audio/persist';
import { Analysis, BANDS, SPEC_MAX, SPEC_MIN, SPEC_POINTS } from '../audio/analysis';
import { Suggestion, suggestMaster } from '../audio/autoMaster';
import { withLoading } from '../loading';
import { DEFAULT_MASTER, DEFAULT_MULTIBAND, DEFAULT_STEREO, EXPORT_TARGETS, MASTER_GROUPS, MASTER_PRESETS, activePreset, applyPreset, masterOf } from '../audio/master';
import { MAX_AUTO_GAIN } from '../audio/export';
import { useStore } from '../store';
import { MasterSettings } from '../types';
import { Reduction, Slider, Spectrum, useRaf } from './ui';

const fmt = (v: number | undefined, digits = 1) => (v === undefined || !Number.isFinite(v) ? '–∞' : v.toFixed(digits).replace('.', ','));
const signed = (v: number, unit: string) => `${v > 0 ? '+' : ''}${fmt(v)} ${unit}`;

/** Muda o master do projeto (sliders: o próprio Slider já marca o desfazer; botões: `history`). */
function setMaster(fn: (m: MasterSettings) => MasterSettings, history = false) {
  useStore.getState().update((p) => ({ ...p, master: fn(masterOf(p.master)) }), history);
}

/** Exporta os stems (uma faixa por trilha) num .zip. */
async function exportStems() {
  const project = useStore.getState().project;
  try {
    const { blob, count } = await withLoading('Exportando stems…', (progress) => renderStems(project, engine.buffers, progress));
    if (!count) {
      alert('Nenhuma trilha com som para exportar (veja se não estão todas no mudo).');
      return;
    }
    download(blob, `${project.name || 'musica'} - stems.zip`);
  } catch (e) {
    alert('Falha ao exportar os stems: ' + (e as Error).message);
  }
}

export function MasterPanel() {
  const raw = useStore((s) => s.project.master);
  const m = masterOf(raw);
  const last = useStore((s) => s.lastExport);
  const target = EXPORT_TARGETS.find((t) => t.id === m.exportTarget)!;
  const active = activePreset(m);
  const eq = (k: keyof MasterSettings['eq']) => (v: number) => setMaster((x) => ({ ...x, eq: { ...x.eq, [k]: v } }));
  const comp = (k: keyof MasterSettings['comp']) => (v: number | boolean) => setMaster((x) => ({ ...x, comp: { ...x.comp, [k]: v } }), typeof v === 'boolean');
  const lim = (k: keyof MasterSettings['limiter']) => (v: number | boolean) => setMaster((x) => ({ ...x, limiter: { ...x.limiter, [k]: v } }), typeof v === 'boolean');

  return (
    <div className="fx master">
      <div className="fx-card wide">
        <h4>Preset de master</h4>
        {MASTER_GROUPS.map((g) => (
          <div key={g.group} className="preset-group">
            <small>{g.group}</small>
            <div className="presets">
              {g.ids.map((id) => MASTER_PRESETS.find((p) => p.id === id)!).map((p) => (
                <button key={p.id} className={active?.id === p.id ? 'on' : ''} title={p.desc} onClick={() => setMaster((x) => applyPreset(x, p.s), true)}>
                  {p.name}
                </button>
              ))}
            </div>
          </div>
        ))}
        {active && <p className="hint preset-desc">{active.desc}</p>}
      </div>

      <AutoMasterCard />
      <Meters target={target.lufs} ceiling={m.limiter.ceiling} />
      <ReferenceCard />

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

      <MultibandCard m={m} />
      <StereoCard m={m} />

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
          {([['wav', 'WAV'], ['flac', 'FLAC'], ['mp3', 'MP3']] as const).map(([f, name]) => (
            <button key={f} className={m.exportFormat === f ? 'on' : ''} onClick={() => setMaster((x) => ({ ...x, exportFormat: f }), true)}
              title={f === 'wav' ? 'Sem compressão: o padrão de estúdio' : f === 'flac' ? 'Sem perda de qualidade e ~30% menor que o WAV' : 'Com perda, bem menor (~1/5 do WAV em 320 kbps): para mandar por mensagem, celular, redes'}>
              {name}
            </button>
          ))}
        </div>
        {m.exportFormat === 'mp3' ? (
          <div className="presets">
            {([320, 256, 192, 128] as const).map((k) => (
              <button key={k} className={m.exportKbps === k ? 'on' : ''} title={k >= 256 ? 'Qualidade alta' : k === 192 ? 'Boa qualidade, arquivo menor' : 'Arquivo pequeno; perde um pouco de agudo e definição'} onClick={() => setMaster((x) => ({ ...x, exportKbps: k }), true)}>
                {k} kbps
              </button>
            ))}
          </div>
        ) : (
          <div className="presets">
            {([24, 16] as const).map((b) => (
              <button key={b} className={m.exportBits === b ? 'on' : ''} onClick={() => setMaster((x) => ({ ...x, exportBits: b }), true)}>
                {b} bits
              </button>
            ))}
          </div>
        )}
        <small className="hint">
          {target.lufs !== null
            ? `Na exportação, o ganho do limitador é ajustado sozinho até a música ficar em ${target.lufs} LUFS, com picos até ${fmt(m.limiter.ceiling)} dBTP.`
            : 'A música sai com o ganho do limitador ajustado aqui.'}
          {m.exportFormat === 'mp3'
            ? ' MP3 com codificador próprio: para ouvir e compartilhar; para mixar ou masterizar em outro lugar, prefira WAV ou FLAC.'
            : m.exportBits === 16
              ? ' 16 bits recebe dither (ruído inaudível que evita distorção).'
              : ''}
        </small>
        <button
          className="stems-btn"
          title="Um arquivo por trilha (no formato escolhido acima), todos começando no início da música, num .zip. Cada stem é a trilha como soa na mix, com os efeitos dela, mas sem o master: para mixar ou masterizar em outro programa."
          onClick={() => void exportStems()}
        >
          Exportar stems (.zip)
        </button>
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

/** Frequência em Hz/kHz. */
const hz = (f: number) => (f >= 1000 ? `${fmt(f / 1000, 1)} kHz` : `${Math.round(f)} Hz`);

/** Slider de frequência em escala logarítmica. */
function FreqRow({ label, v, min, max, reset, onChange }: { label: string; v: number; min: number; max: number; reset: number; onChange: (f: number) => void }) {
  const to = (f: number) => (Math.log(f / min) / Math.log(max / min)) * 1000;
  const from = (x: number) => Math.round(min * (max / min) ** (x / 1000));
  return (
    <div className="m-row">
      <span className="m-label">{label}</span>
      <Slider min={0} max={1000} step={1} value={to(v)} reset={to(reset)} onChange={(x) => onChange(from(x))} />
      <span className="fx-val">{hz(v)}</span>
    </div>
  );
}

const BAND_LABELS = ['Graves', 'Médios', 'Agudos'];

/** Compressor multibanda: graves, médios e agudos comprimidos separadamente. */
function MultibandCard({ m }: { m: Required<MasterSettings> }) {
  const mb = m.multiband;
  const set = (fn: (x: typeof mb) => typeof mb, history = false) => setMaster((x) => ({ ...x, multiband: fn(masterOf(x).multiband) }), history);
  const band = (i: number, k: 'threshold' | 'ratio' | 'gain') => (v: number) =>
    set((x) => ({ ...x, bands: x.bands.map((b, j) => (j === i ? { ...b, [k]: v } : b)) }));
  return (
    <div className="fx-card mb-card">
      <div className="eq-head">
        <h4>Multibanda</h4>
        <button className={mb.on ? 'toggle on' : 'toggle'} onClick={() => set((x) => ({ ...x, on: !x.on }), true)}>{mb.on ? 'Ligado' : 'Desligado'}</button>
      </div>
      <small className="hint">Comprime graves, médios e agudos separadamente: segura um grave que estoura sem abafar o resto.</small>
      <FreqRow label="Graves | médios" v={mb.lowFreq} min={60} max={500} reset={DEFAULT_MULTIBAND.lowFreq} onChange={(f) => set((x) => ({ ...x, lowFreq: Math.min(f, x.highFreq / 2) }))} />
      <FreqRow label="Médios | agudos" v={mb.highFreq} min={1000} max={10000} reset={DEFAULT_MULTIBAND.highFreq} onChange={(f) => set((x) => ({ ...x, highFreq: Math.max(f, x.lowFreq * 2) }))} />
      <div className="mb-bands">
        {mb.bands.map((b, i) => (
          <div key={i} className="mb-band">
            <b>{BAND_LABELS[i]}</b>
            <Row label="Limiar" v={b.threshold} unit="dB" min={-48} max={0} step={0.5} reset={DEFAULT_MULTIBAND.bands[i].threshold} onChange={band(i, 'threshold')} />
            <Row label="Razão" v={b.ratio} unit=": 1" min={1} max={10} step={0.1} reset={DEFAULT_MULTIBAND.bands[i].ratio} onChange={band(i, 'ratio')} />
            <Row label="Ganho" v={b.gain} unit="dB" min={-12} max={12} step={0.5} reset={0} onChange={band(i, 'gain')} />
            <Reduction get={() => (engine.ready ? engine.mixer.chain.multiband.reductions()[i] : 0)} />
          </div>
        ))}
      </div>
    </div>
  );
}

/** Imagem estéreo: largura e graves em mono. */
function StereoCard({ m }: { m: Required<MasterSettings> }) {
  const st = m.stereo;
  const set = (patch: Partial<typeof st>, history = false) => setMaster((x) => ({ ...x, stereo: { ...masterOf(x).stereo, ...patch } }), history);
  return (
    <div className="fx-card">
      <h4>Imagem estéreo</h4>
      <Row label="Largura" v={st.width * 100} unit="%" min={0} max={200} step={1} reset={100} onChange={(v) => set({ width: v / 100 })} />
      <small className="hint">0% = mono · 100% = original · acima abre o estéreo (cuidado: abaixo de 0 na correlação some no celular).</small>
      <button className={st.monoBass ? 'toggle on' : 'toggle'} onClick={() => set({ monoBass: !st.monoBass }, true)}>
        Graves em mono: {st.monoBass ? 'sim' : 'não'}
      </button>
      {st.monoBass && <FreqRow label="Abaixo de" v={st.monoFreq} min={40} max={300} reset={DEFAULT_STEREO.monoFreq} onChange={(f) => set({ monoFreq: f })} />}
      <small className="hint">Graves em mono deixam o grave firme e centrado (padrão em vinil, rádio e pista).</small>
    </div>
  );
}

// ---------- Referência (A/B) e master automático ----------

const ANALYSIS_ROWS: { label: string; get: (a: Analysis) => number; unit: string; digits?: number; tip: string }[] = [
  { label: 'Loudness', get: (a) => a.lufs, unit: 'LUFS', tip: 'Volume médio percebido da música inteira' },
  { label: 'Pico real', get: (a) => a.truePeak, unit: 'dBTP', tip: 'O pico mais alto, contando os entre amostras' },
  { label: 'Dinâmica (PLR)', get: (a) => a.plr, unit: 'dB', tip: 'Pico − loudness: baixo = muito comprimido' },
  { label: 'Variação (LRA)', get: (a) => a.lra, unit: 'LU', tip: 'Diferença de volume entre as partes calmas e as fortes' },
  { label: 'Correlação', get: (a) => a.correlation, unit: '', digits: 2, tip: '1 = mono, 0 = muito aberto, negativo = problema de fase' },
];

/** Espectros médios sobrepostos (mix e referência). */
function SpectrumCompare({ mix, refA }: { mix: Analysis | null; refA: Analysis | null }) {
  const line = (a: Analysis) =>
    a.spectrum.map((v, i) => `${((i / (SPEC_POINTS - 1)) * 1000).toFixed(1)},${(Math.min(1, -v / 60) * 100).toFixed(1)}`).join(' ');
  return (
    <div className="ab-spec">
      <svg viewBox="0 0 1000 100" preserveAspectRatio="none">
        {[100, 1000, 10000].map((f) => {
          const x = (Math.log(f / SPEC_MIN) / Math.log(SPEC_MAX / SPEC_MIN)) * 1000;
          return <line key={f} x1={x} x2={x} y1={0} y2={100} className="eq-grid" />;
        })}
        {refA && <polyline points={line(refA)} className="ab-ref" />}
        {mix && <polyline points={line(mix)} className="ab-mix" />}
      </svg>
      <div className="ab-legend">
        <span className="mix">■ sua mix</span> <span className="ref">■ referência</span> <small>linhas: 100 Hz · 1 kHz · 10 kHz</small>
      </div>
    </div>
  );
}

function ReferenceCard() {
  const reference = useStore((s) => s.project.reference);
  const abRef = useStore((s) => s.abRef);
  const abMatch = useStore((s) => s.abMatch);
  const refA = useStore((s) => s.refAnalysis);
  const mixA = useStore((s) => s.mixAnalysis);
  const st = useStore.getState();
  const file = useRef<HTMLInputElement>(null);

  // projeto aberto com referência: analisa de novo (as análises não são salvas)
  useEffect(() => {
    if (reference && !useStore.getState().refAnalysis) void engine.analyzeReference();
  }, [reference?.bufferId]);

  const analyzeMix = async () => {
    const p = useStore.getState().project;
    const a = await withLoading('Analisando a mix…', (progress) => analyzeProject(p, engine.buffers, 'mastered', progress));
    useStore.getState().set({ mixAnalysis: a });
  };

  return (
    <div className="fx-card wide ab-card">
      <div className="eq-head">
        <h4>Referência (A/B)</h4>
        <input
          ref={file}
          type="file"
          accept="audio/*"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = '';
            if (f) void engine.importReference(f).catch((err) => alert('Não foi possível abrir a referência: ' + (err as Error).message));
          }}
        />
        <button onClick={() => file.current?.click()}>{reference ? 'Trocar referência…' : 'Carregar referência…'}</button>
        {reference && (
          <button
            onClick={() => {
              st.update((p) => ({ ...p, reference: undefined }));
              st.set({ refAnalysis: null, abRef: false });
            }}
          >
            Remover
          </button>
        )}
        <small className="eq-tip">{reference ? `♪ ${reference.name}` : 'Uma música profissional parecida com a sua, para comparar volume e timbre.'}</small>
      </div>
      {reference && (
        <>
          <div className="ab-switch">
            <button className={!abRef ? 'on' : ''} onClick={() => st.set({ abRef: false })}>A · Sua mix</button>
            <button className={abRef ? 'on' : ''} onClick={() => st.set({ abRef: true })}>B · Referência</button>
            <button
              className={abMatch ? 'toggle on' : 'toggle'}
              title="Deixa a referência no mesmo volume da sua mix, para comparar o timbre e não o volume"
              onClick={() => st.set({ abMatch: !abMatch })}
            >
              Igualar volume: {abMatch ? 'sim' : 'não'}
            </button>
            <button onClick={() => void analyzeMix()} title="Renderiza a música como sairia na exportação e mede">Analisar minha mix</button>
          </div>
          <div className="ab-body">
            <table className="ab-table">
              <thead>
                <tr><th /><th>Sua mix</th><th>Referência</th></tr>
              </thead>
              <tbody>
                {ANALYSIS_ROWS.map((r) => (
                  <tr key={r.label} title={r.tip}>
                    <td>{r.label}</td>
                    <td>{mixA ? `${fmt(r.get(mixA), r.digits ?? 1)} ${r.unit}` : '—'}</td>
                    <td>{refA ? `${fmt(r.get(refA), r.digits ?? 1)} ${r.unit}` : '…'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="ab-bands">
              {BANDS.map((b, i) => {
                const d = mixA && refA ? mixA.bands[i] - refA.bands[i] : null;
                return (
                  <div key={b.name} className="ab-band" title={`${b.lo}–${b.hi} Hz`}>
                    <span>{b.name}</span>
                    <div className="ab-bar">
                      {d !== null && (
                        <div className={`ab-fill ${d > 0 ? 'pos' : 'neg'}`} style={{ width: `${Math.min(50, (Math.abs(d) / 12) * 50)}%`, [d > 0 ? 'left' : 'right']: '50%' }} />
                      )}
                    </div>
                    <span className="ab-d">{d === null ? '—' : `${d > 0 ? '+' : ''}${fmt(d)} dB`}</span>
                  </div>
                );
              })}
              <small className="hint">Diferença da sua mix para a referência em cada região (com o mesmo volume total).</small>
            </div>
            <SpectrumCompare mix={mixA} refA={refA} />
          </div>
          {!mixA && <small className="hint">Clique em "Analisar minha mix" para comparar os números (leva alguns segundos).</small>}
        </>
      )}
    </div>
  );
}

function AutoMasterCard() {
  const refA = useStore((s) => s.refAnalysis);
  const [result, setResult] = useState<{ notes: Suggestion[]; settings: MasterSettings } | null>(null);
  const run = async () => {
    const p = useStore.getState().project;
    const raw = await withLoading('Analisando a mix…', (progress) => analyzeProject(p, engine.buffers, 'raw', progress));
    setResult(suggestMaster(raw, useStore.getState().refAnalysis, p.master));
  };
  return (
    <div className="fx-card wide auto-card">
      <div className="eq-head">
        <h4>Master automático</h4>
        <button onClick={() => void run()}>Analisar e sugerir</button>
        {result && (
          <button
            className="primary"
            onClick={() => {
              setMaster(() => result.settings, true);
              setResult(null);
            }}
          >
            Aplicar no master
          </button>
        )}
        <small className="eq-tip">{refA ? 'Usa a referência carregada como alvo.' : 'Sem referência: usa o equilíbrio típico de músicas masterizadas.'}</small>
      </div>
      {result && (
        <ul className="auto-notes">
          {result.notes.map((n, i) => (
            <li key={i} className={n.kind}>
              {n.kind === 'fix' ? '✔' : n.kind === 'warn' ? '⚠' : '•'} {n.text}
            </li>
          ))}
        </ul>
      )}
      {result && <small className="hint">As sugestões partem da mix sem nada no master. Depois de aplicar, ajuste tudo à vontade (dá para desfazer).</small>}
    </div>
  );
}
