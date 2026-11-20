import { RATES, engine, wantedRate } from '../audio/engine';
import { lowLatencyMissing, refreshLowLatencyDevices, setLowLatency } from '../audio/lowLatency';
import { DRUM_MAP, presetGroups } from '../audio/instruments';
import { LOOPS, Loop, STYLES, STYLE_GROUPS, STYLE_PARTS, addLoop, addStyleBand } from '../audio/loops';
import { useEffect, useState } from 'react';
import { BottomTab, pref, savePref, useStore } from '../store';
import { Track } from '../types';
import { AmpRack } from './AmpRack';
import { AudioEditor } from './AudioEditor';
import { ArpCard, CompEditor, EqEditor, FeelCard, SendsCard, SidechainCard } from './TrackFxPanels';
import { MasterPanel } from './MasterPanel';
import { MixerPanel } from './MixerPanel';
import { PianoRoll } from './PianoRoll';
import { TabView } from './TabView';
import { PracticePanel } from './PracticePanel';
import { LOOP_MIME } from './Timeline';
import { KIND_ICON, Meter, Slider, Spectrum } from './ui';
import { inputSettingsPath, isMac } from '../platform';

const TABS: [BottomTab, string][] = [
  ['loops', 'Loops'],
  ['editor', 'Piano Roll'],
  ['fx', 'Efeitos'],
  ['amp', 'Amp & Pedais'],
  ['keys', 'Teclado'],
  ['audio', 'Editor de Áudio'],
  ['tab', 'Tablatura & Cifra'],
  ['study', 'Tirar Música'],
  ['mixer', 'Mixer'],
  ['master', 'Master'],
];

const PANEL_H = 320; // altura padrão (duplo clique na alça volta para ela)
const PANEL_MIN = 140;
/** Altura máxima: sempre sobra espaço para a barra de transporte e algumas trilhas. */
const panelMax = () => Math.max(PANEL_MIN, window.innerHeight - 230);
const clampH = (h: number) => Math.round(Math.min(panelMax(), Math.max(PANEL_MIN, h)));

/** Altura do painel de baixo, arrastável pela borda de cima e lembrada entre sessões. */
function usePanelHeight() {
  const [h, setH] = useState(() => clampH(Number(pref('mm.bottomH')) || PANEL_H));
  useEffect(() => {
    const fit = () => setH((v) => clampH(v));
    window.addEventListener('resize', fit);
    return () => window.removeEventListener('resize', fit);
  }, []);
  const save = (v: number) => { setH(v); savePref('mm.bottomH', String(v)); };
  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    const y0 = e.clientY;
    const h0 = h;
    let last = h0;
    document.body.classList.add('resizing-v');
    const move = (ev: PointerEvent) => { last = clampH(h0 + y0 - ev.clientY); setH(last); };
    const up = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      document.body.classList.remove('resizing-v');
      save(last);
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  };
  return { h, onPointerDown, reset: () => save(clampH(PANEL_H)) };
}

export function BottomPanel() {
  const tab = useStore((s) => s.bottomTab);
  const track = useStore((s) => s.project.tracks.find((t) => t.id === s.selectedTrackId));
  const set = useStore.getState().set;
  const panel = usePanelHeight();
  return (
    <section className="bottom" style={{ height: panel.h }}>
      <div
        className="bottom-resize"
        title="Arraste para aumentar ou diminuir o painel (duplo clique: tamanho padrão)"
        onPointerDown={panel.onPointerDown}
        onDoubleClick={panel.reset}
      />
      <nav className="tabs">
        {TABS.map(([id, label]) => (
          <button key={id} className={tab === id ? 'on' : ''} onClick={() => set({ bottomTab: id })}>{label}</button>
        ))}
        {track && <span className="tabs-track">{KIND_ICON[track.kind]} {track.name}</span>}
      </nav>
      <div className="bottom-body">
        {tab === 'editor' && <PianoRoll />}
        {tab === 'loops' && <Loops />}
        {tab === 'audio' && <AudioEditor />}
        {tab === 'mixer' && <MixerPanel />}
        {tab === 'master' && <MasterPanel />}
        {tab === 'tab' && <TabView />}
        {tab === 'study' && <PracticePanel />}
        {tab === 'fx' && (track ? <Fx track={track} /> : <div className="empty">Selecione uma trilha.</div>)}
        {tab === 'amp' && (track ? <AmpRack track={track} /> : <div className="empty">Selecione uma trilha.</div>)}
        {tab === 'keys' && (track && track.kind !== 'audio' && track.kind !== 'bus' ? <Keys track={track} /> : <div className="empty">Selecione uma trilha de instrumento ou bateria para tocar.</div>)}
      </div>
    </section>
  );
}

// ---------- Loops ----------

/**
 * Loops organizados por estilo: à esquerda os estilos (os mesmos para as quatro partes), à direita a
 * bateria, o baixo, os acordes e a melodia do estilo escolhido — que combinam entre si.
 */
function Loops() {
  const [styleId, setStyleId] = useState(() => pref('mm.loopStyle') ?? STYLES[0].id);
  const style = STYLES.find((x) => x.id === styleId) ?? STYLES[0];
  const choose = (id: string) => {
    setStyleId(id);
    savePref('mm.loopStyle', id);
  };
  const add = (l: Loop) => addLoop(l, engine.getBeat(), useStore.getState().selectedTrackId ?? undefined);
  return (
    <div className="loops by-style">
      <nav className="style-list">
        {STYLE_GROUPS.map((g) => (
          <div key={g} className="style-group">
            <small>{g}</small>
            {STYLES.filter((x) => x.group === g).map((x) => (
              <button key={x.id} className={x.id === style.id ? 'on' : ''} onClick={() => choose(x.id)}>{x.name}</button>
            ))}
          </div>
        ))}
      </nav>
      <div className="style-body">
        <div className="style-head">
          <h3>{style.name}</h3>
          <button className="primary" title="Bateria, baixo, acordes e melodia deste estilo, cada um numa trilha nova, no compasso do cursor" onClick={() => addStyleBand(style, engine.getBeat())}>
            ＋ Banda completa
          </button>
          <span className="hint">As quatro partes estão no mesmo tom e combinam entre si. Arraste um loop para a timeline ou use ＋.</span>
        </div>
        <div className="style-parts">
          {STYLE_PARTS.map((part) => (
            <LoopColumn key={part.key} title={part.category} loops={style[part.key].map((id) => LOOPS.find((l) => l.id === id)!)} add={add} />
          ))}
        </div>
      </div>
    </div>
  );
}

function LoopColumn({ title, loops, add }: { title: string; loops: Loop[]; add: (l: Loop) => void }) {
  return (
    <div className="loop-cat">
      <h4>{title}</h4>
      {loops.map((l, i) => (
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
              <span className="loop-name">{l.name}{i > 0 && <em> · variação</em>}</span>
              <small>{l.bars} comp.</small>
              <button title="Adicionar na posição do cursor" onClick={() => add(l)}>＋</button>
            </div>
      ))}
    </div>
  );
}

// ---------- Efeitos ----------


function Fx({ track: t }: { track: Track }) {
  const st = useStore.getState();
  return (
    <div className="fx">
      {t.kind === 'audio' && <AudioInput />}
      {t.kind === 'instrument' && (
        <div className="fx-card wide">
          <h4>Instrumento</h4>
          {presetGroups().map((g) => (
            <div key={g.group} className="preset-group">
              <small>{g.group}</small>
              <div className="presets">
                {g.items.map(([id, p]) => (
                  <button key={id} className={t.instrument === id ? 'on' : ''} onClick={() => st.updateTrack(t.id, { instrument: id })}>
                    {p.name}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
      {(t.kind === 'instrument' || t.kind === 'drums') && <FeelCard track={t} />}
      {t.kind === 'instrument' && <ArpCard track={t} />}
      <EqEditor track={t} />
      <CompEditor track={t} />
      <SendsCard track={t} />
      <SidechainCard track={t} />

    </div>
  );
}

const LL_BUFFERS = [32, 64, 128, 256, 512];

/**
 * Motor da monitoração: pelo áudio do sistema (Chromium, ~70 ms) ou direto pelo driver da placa (ASIO no
 * Windows, CoreAudio no Mac, ~10 ms). Só aparece no app instalado (no navegador não há processo de áudio).
 */
function LowLatencyRow() {
  const available = useStore((s) => s.llAvailable);
  const engineSel = useStore((s) => s.monitorEngine);
  const api = useStore((s) => s.llApi) || (isMac ? 'CoreAudio' : 'ASIO');
  const devices = useStore((s) => s.llDevices);
  const deviceId = useStore((s) => s.llDeviceId);
  const buffer = useStore((s) => s.llBuffer);
  const safe = useStore((s) => s.llSafe);
  const status = useStore((s) => s.llStatus);
  const meter = useStore((s) => s.llMeter);
  const open = useStore((s) => s.inputOpen);
  const track = useStore((s) => s.project.tracks.find((t) => t.id === s.selectedTrackId));
  if (!available) return null;
  const missing = lowLatencyMissing(track);
  const low = engineSel === 'low';
  const load = meter && meter.budget ? Math.round((100 * meter.loadAvg) / meter.budget) : 0;

  return (
    <>
      <div className="input-row">
        <label>
          Monitoração
          <select
            title="Por onde você ouve o instrumento enquanto toca"
            value={engineSel}
            onChange={(e) => {
              setLowLatency({ monitorEngine: e.target.value as 'system' | 'low' });
              e.currentTarget.blur();
            }}
          >
            <option value="system">Áudio do sistema (~70 ms)</option>
            <option value="low">{api}: baixa latência (~10 ms)</option>
          </select>
        </label>
        {low && (
          <>
            <label>
              Placa {api}
              <select
                value={deviceId ?? ''}
                onFocus={refreshLowLatencyDevices}
                onChange={(e) => {
                  setLowLatency({ llDeviceId: +e.target.value });
                  e.currentTarget.blur();
                }}
              >
                {!devices.length && <option value="">Nenhuma placa {api} encontrada</option>}
                {devices.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
              </select>
            </label>
            <label>
              Buffer
              <select
                title="Menor = menos atraso. Se ouvir estalos, aumente."
                value={buffer}
                onChange={(e) => {
                  setLowLatency({ llBuffer: +e.target.value });
                  e.currentTarget.blur();
                }}
              >
                {LL_BUFFERS.map((b) => <option key={b} value={b}>{b} amostras</option>)}
              </select>
            </label>
            <label className="check" title="Um bloco a mais de folga na saída: evita estalos raros ao custo de ~1,5 ms">
              <input type="checkbox" checked={safe} onChange={(e) => setLowLatency({ llSafe: e.target.checked })} />
              Folga contra estalos
            </label>
          </>
        )}
      </div>
      {low && (
        <small className={status.error ? 'input-warn' : 'input-hint'}>
          {status.error
            ? `⚠ ${status.error}`
            : !devices.length
              ? `Nenhum driver ${api} encontrado. Instale o driver da sua placa de áudio (ou o ASIO4ALL) e abra esta lista de novo.`
              : status.running
                ? `● ${api} ligado: ${status.latencyMs.toFixed(1).replace('.', ',')} ms de ida e volta (buffer de ${status.buffer})` +
                  ` · processamento ${load}%` +
                  (meter?.late ? ` · ${meter.late} atraso(s) do processo: se ouvir estalos, aumente o buffer ou ligue a folga` : '') +
                  (missing.length
                    ? `. Ainda fora da monitoração (só na gravação/reprodução): ${missing.join(', ')}.`
                    : '.')
                : open
                  ? `Abrindo a placa pelo ${api}…`
                  : `A placa abre pelo ${api} quando você ligar a entrada. A gravação continua pelo caminho normal.`}
        </small>
      )}
    </>
  );
}

/** Escolha da placa/entrada onde a guitarra ou o microfone estão ligados, com medidor e monitoração. */
function AudioInput() {
  const inputs = useStore((s) => s.inputs);
  const deviceId = useStore((s) => s.inputDeviceId);
  const channel = useStore((s) => s.inputChannel);
  const channels = useStore((s) => s.inputChannels);
  const open = useStore((s) => s.inputOpen);
  const muted = useStore((s) => s.inputMuted);
  const monitor = useStore((s) => s.monitor);
  const outputs = useStore((s) => s.outputs);
  const outputId = useStore((s) => s.outputDeviceId);
  const defaults = useStore((s) => s.defaultGroups);
  const inputRate = useStore((s) => s.inputRate);
  const appRate = useStore((s) => s.appRate);
  const rateSetting = useStore((s) => s.rateSetting);
  const recording = useStore((s) => !!s.recording);
  const set = useStore.getState().set;
  // taxa que o app usaria se reiniciasse agora (no automático, a da placa aberta por último; a entrada
  // guarda a taxa dela antes de atualizar inputRate, então isto acompanha a placa aberta)
  const pendingRate = wantedRate(rateSetting);

  const changeOutput = async (id: string | null) => {
    set({ outputDeviceId: id });
    savePref('mm.outputDevice', id ?? '');
    if (!(await engine.applyOutput())) {
      alert('Não foi possível usar essa saída de áudio. O som continua saindo pela saída padrão do sistema.');
      set({ outputDeviceId: null });
      savePref('mm.outputDevice', '');
    }
  };
  // entrada e saída na mesma placa física? (o groupId é o mesmo para entrada e saída de um aparelho USB)
  const inGroup = deviceId ? inputs.find((i) => i.id === deviceId)?.group : defaults.input;
  const outGroup = outputId ? outputs.find((o) => o.id === outputId)?.group : defaults.output;
  const splitBoards = open && !!inGroup && !!outGroup && inGroup !== outGroup;
  const sameBoardOut = splitBoards ? outputs.find((o) => o.group === inGroup) : undefined;
  const outMissing = outputId && outputs.length > 0 && !outputs.some((o) => o.id === outputId);

  // muda uma preferência e, se a entrada já estiver ligada, reabre com a nova configuração
  const change = (patch: { inputDeviceId?: string | null; inputChannel?: number }) => {
    set(patch);
    if (patch.inputDeviceId !== undefined) savePref('mm.inputDevice', patch.inputDeviceId ?? '');
    if (patch.inputChannel !== undefined) savePref('mm.inputChannel', String(patch.inputChannel));
    if (open) void engine.openInput();
  };
  const missing = deviceId && inputs.length > 0 && !inputs.some((i) => i.id === deviceId);

  return (
    <div className="fx-card wide input-card">
      <h4>Entrada e saída de áudio — guitarra, microfone, placa de áudio</h4>
      <div className="input-row">
        <label>
          Dispositivo
          <select
            value={deviceId ?? ''}
            onChange={(e) => {
              change({ inputDeviceId: e.target.value || null });
              e.currentTarget.blur();
            }}
          >
            <option value="">Padrão do sistema</option>
            {inputs.map((i) => <option key={i.id} value={i.id}>{i.label}</option>)}
            {missing && <option value={deviceId}>(dispositivo desconectado)</option>}
          </select>
        </label>
        <label>
          Canal
          <select
            value={channel}
            onChange={(e) => {
              change({ inputChannel: +e.target.value });
              e.currentTarget.blur();
            }}
          >
            <option value={0}>Entrada 1</option>
            <option value={1}>Entrada 2</option>
            <option value={2}>1 + 2 (somadas)</option>
          </select>
        </label>
        <label>
          Saída
          <select
            title="Por onde o som do app sai. Para menos atraso ao monitorar, use a saída da mesma placa da entrada."
            value={outputId ?? ''}
            onChange={(e) => {
              void changeOutput(e.target.value || null);
              e.currentTarget.blur();
            }}
          >
            <option value="">Padrão do sistema</option>
            {outputs.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
            {outMissing && <option value={outputId}>(dispositivo desconectado)</option>}
          </select>
        </label>
        <label>
          Taxa
          <select
            title="Taxa de amostragem do app. Automática: a mesma da placa de entrada, sem conversão no caminho."
            value={rateSetting}
            onChange={(e) => {
              const v = e.target.value as typeof rateSetting;
              set({ rateSetting: v });
              savePref('mm.sampleRate', v === 'auto' ? '' : v);
              e.currentTarget.blur();
            }}
          >
            <option value="auto">Automática (da placa)</option>
            {RATES.map((r) => <option key={r} value={String(r)}>{r} Hz</option>)}
          </select>
        </label>
        <button className={open ? 'toggle on' : 'toggle'} onClick={() => (open ? engine.closeInput() : void engine.openInput())}>
          {open ? 'Entrada ligada' : 'Ligar entrada'}
        </button>
        <button
          className={monitor ? 'toggle on' : 'toggle'}
          title="Ouvir a entrada pela trilha selecionada, com os efeitos dela. Use fones para evitar microfonia."
          onClick={() => {
            set({ monitor: !monitor });
            if (!monitor && !open) void engine.openInput();
          }}
        >
          🎧 Monitorar
        </button>
        <div className="input-meter">
          <small>Nível de entrada</small>
          <Meter input />
        </div>
      </div>
      <LowLatencyRow />
      {open && muted && (
        <div className="input-warn">
          ⚠ Esta entrada está no mudo no {isMac ? 'Mac' : 'Windows'}, então não chega som nenhum ao app. Tire do mudo{' '}
          {isMac ? 'em ' : ''}{inputSettingsPath()} (ou escolha outro dispositivo acima).
        </div>
      )}
      {splitBoards && (
        <div className="input-warn">
          ⚠ A entrada e a saída estão em placas diferentes. O som da guitarra demora mais para chegar às caixas.
          {sameBoardOut ? (
            <>
              {' '}
              <button className="link" onClick={() => void changeOutput(sameBoardOut.id)}>
                Usar a saída {sameBoardOut.label}
              </button>{' '}
              e ligue as caixas ou o fone nela.
            </>
          ) : (
            ' Para monitorar com menos atraso, ligue as caixas ou o fone na própria placa de áudio.'
          )}
        </div>
      )}
      {appRate && pendingRate && pendingRate !== appRate ? (
        <div className="input-warn">
          ⚠ O app está rodando a {appRate} Hz{rateSetting === 'auto' && inputRate ? ` e a placa a ${inputRate} Hz` : ''}. Para
          passar a {pendingRate} Hz o áudio precisa reiniciar (o projeto continua salvo).{' '}
          <button className="link" disabled={recording} onClick={() => void engine.restartAudio()}>
            Reiniciar o áudio agora
          </button>
        </div>
      ) : (
        open &&
        inputRate &&
        appRate &&
        inputRate !== appRate && (
          <div className="input-warn">
            ⚠ A placa está a {inputRate} Hz e o app a {appRate} Hz, então o som é convertido no caminho (mais atraso).
            Escolha a taxa "Automática" ou coloque a placa em {appRate} Hz{' '}
            {isMac ? 'no app Configuração de Áudio e MIDI' : 'no Painel de controle de som (Propriedades → Avançado)'}.
          </div>
        )
      )}
      <small className="input-hint">
        {open && channels < 2 && channel === 1
          ? 'Este dispositivo só entrega 1 canal ao sistema, então está sendo usada a Entrada 1.'
          : open
            ? 'Toque o instrumento: o medidor deve se mexer. Se ficar parado, troque o canal (em placas de 2 entradas a guitarra entra só em uma) ou o dispositivo.'
            : 'Conecte a placa, escolha-a na lista e clique em "Ligar entrada". Depois é só apertar ● para gravar nesta trilha.'}
      </small>
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
