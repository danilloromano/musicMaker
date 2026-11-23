import { useEffect, useRef, useState } from 'react';
import { engine, renderWav } from '../audio/engine';
import { masterOf } from '../audio/master';
import { download, openProjectFile, saveProjectFile } from '../audio/persist';
import { defaultProject, savePref, useStore } from '../store';
import { KEY_LETTERS, barBeatLabel, barBeats, keyLabel, keyNamePt } from '../types';
import { importFiles } from '../audio/importFiles';
import { withLoading } from '../loading';
import { Meter, useRaf } from './ui';
import { TunerModal } from './TunerModal';
import { MetronomeMenu } from './MetronomeMenu';
import { exportMidi } from '../audio/midiProject';
import { SongGenModal } from './SongGenModal';
import { redoShortcut, shortcut } from '../platform';
import { retimeAudio } from '../audio/tempo';

export function saveProject() {
  saveProjectFile(useStore.getState().project, engine.buffers);
}

export function Transport() {
  const project = useStore((s) => s.project);
  const playing = useStore((s) => s.playing);
  const recording = useStore((s) => s.recording);
  const ppb = useStore((s) => s.ppb);
  const canUndo = useStore((s) => s.past.length > 0);
  const canRedo = useStore((s) => s.future.length > 0);
  const countIn = useStore((s) => s.countIn);
  const loopOn = useStore((s) => !!s.project.loop?.on);
  const lyricsOpen = useStore((s) => s.lyricsOpen);
  const st = useStore.getState();

  const lcd = useRef<HTMLSpanElement>(null);
  const clock = useRef<HTMLSpanElement>(null);
  useRaf(() => {
    const b = engine.getBeat();
    const sec = (b * 60) / project.bpm;
    if (lcd.current) lcd.current.textContent = barBeatLabel(project, b);
    if (clock.current) {
      clock.current.textContent = `${Math.floor(sec / 60)}:${(sec % 60).toFixed(1).padStart(4, '0')}`;
    }
  });

  const [bpmText, setBpmText] = useState(String(project.bpm));
  useEffect(() => setBpmText(String(project.bpm)), [project.bpm]);
  const commitBpm = () => {
    const v = Math.round(+bpmText);
    // o áudio vai junto: as regiões continuam na grade (e são esticadas sem mudar a altura)
    if (v >= 40 && v <= 240 && v !== project.bpm) st.update((p) => retimeAudio(p, v));
    else setBpmText(String(project.bpm));
  };

  const openRef = useRef<HTMLInputElement>(null);
  const importRef = useRef<HTMLInputElement>(null);
  const [exporting, setExporting] = useState(false);
  const [tuner, setTuner] = useState(false);
  const [gen, setGen] = useState(false);

  const exportWav = async () => {
    setExporting(true);
    try {
      await engine.whenStretched();
      const project = useStore.getState().project;
      const fmt = (masterOf(project.master).exportFormat ?? 'wav').toUpperCase();
      const { blob, ext, report } = await withLoading(`Exportando ${fmt}…`, (progress) => renderWav(project, engine.buffers, progress));
      download(blob, `${project.name || 'musica'}.${ext}`);
      st.set({ lastExport: report });
    } catch (e) {
      alert('Falha ao exportar: ' + (e as Error).message);
    }
    setExporting(false);
  };

  const newProject = () => {
    if (!confirm('Começar um projeto novo? O projeto atual será descartado (salve antes se quiser mantê-lo).')) return;
    engine.stop();
    engine.seek(0);
    st.loadProject(defaultProject());
  };

  return (
    <header className="transport">
      <input
        className="proj-name"
        value={project.name}
        title="Nome do projeto"
        onChange={(e) => st.update((p) => ({ ...p, name: e.target.value }), false)}
      />
      <div className="group">
        <button className="tbtn" title="Voltar ao início (Enter ou Esc)" onClick={() => engine.seek(0)}>⏮</button>
        <button className={`tbtn ${playing ? 'on' : ''}`} title="Tocar / parar (Espaço)" onClick={() => engine.toggle()}>
          {playing ? '■' : '▶'}
        </button>
        <button
          className={`tbtn rec ${recording ? 'on' : ''}`}
          title="Gravar na trilha selecionada (R)"
          onClick={() => void engine.toggleRecord()}
        >
          ●
        </button>
      </div>
      <div className="lcd">
        <div><span className="lcd-big" ref={lcd}>1.1</span><small>compasso</small></div>
        <div><span className="lcd-big" ref={clock}>0:00.0</span><small>tempo</small></div>
        <div>
          <input
            className="lcd-big bpm"
            value={bpmText}
            onChange={(e) => setBpmText(e.target.value.replace(/\D/g, ''))}
            onBlur={commitBpm}
            onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
          />
          <small>bpm</small>
        </div>
      </div>
      <button
        className={project.metronome ? 'toggle on' : 'toggle'}
        title="Metrônomo (opções de compasso, subdivisão e treino no ▾ ao lado)"
        onClick={() => st.update((p) => ({ ...p, metronome: !p.metronome }), false)}
      >
        <span className="ico">♩</span><span className="lbl"> Metrônomo</span>
      </button>
      <MetronomeMenu />
      <button
        className={countIn ? 'toggle on' : 'toggle'}
        title="Contar 1 compasso no metrônomo antes de começar a gravar"
        onClick={() => {
          st.set({ countIn: !countIn });
          savePref('mm.countIn', countIn ? '0' : '1');
        }}
      >
        <span className="ico">①</span><span className="lbl"> Contagem</span>
      </button>
      <button
        className={project.punch?.on ? 'toggle on punch' : 'toggle'}
        title="Punch-in (I): a gravação só substitui o trecho vermelho da régua, começando um compasso antes para você entrar no tempo. Arraste a faixa vermelha para ajustar o trecho."
        onClick={() => st.togglePunch(engine.getBeat())}
      >
        <span className="ico">⤓</span><span className="lbl"> Punch</span>
      </button>
      <button
        className={loopOn ? 'toggle on' : 'toggle'}
        title="Tocar um trecho em repetição (C). Ajuste o trecho arrastando a faixa na régua; Shift + arrastar na régua marca um novo trecho."
        onClick={() => st.toggleLoop(engine.getBeat())}
      >
        <span className="ico">🔁</span><span className="lbl"> Loop</span>
      </button>
      <button className={tuner ? 'toggle on' : 'toggle'} title="Afinador: afine a guitarra ou o baixo plugado na entrada" onClick={() => setTuner(true)}>
        <span className="ico">♮</span><span className="lbl"> Afinador</span>
      </button>
      <button
        className={lyricsOpen ? 'toggle on' : 'toggle'}
        title="Letra da música: abre ao lado da timeline para ler enquanto toca e grava"
        onClick={() => {
          savePref('mm.lyricsOpen', lyricsOpen ? '0' : '1');
          st.set({ lyricsOpen: !lyricsOpen });
        }}
      >
        <span className="ico">📝</span><span className="lbl"> Letra</span>
      </button>
      {tuner && <TunerModal onClose={() => setTuner(false)} />}
      {gen && <SongGenModal onClose={() => setGen(false)} />}
      <select
        className="key-select"
        value={project.key ? `${project.key.root}:${project.key.minor ? 1 : 0}` : ''}
        title={project.key ? `Tom da música: ${keyNamePt(project.key)} (o Piano Roll destaca as notas da escala)` : 'Tom da música: escolha para o Piano Roll destacar as notas da escala'}
        aria-label="Tom da música"
        onChange={(e) => {
          const v = e.target.value;
          st.update((p) => ({ ...p, key: v ? { root: +v.split(':')[0], minor: v.endsWith(':1') } : undefined }));
          e.currentTarget.blur();
        }}
      >
        <option value="">Tom</option>
        <optgroup label="Maior">
          {KEY_LETTERS.map((_, i) => <option key={i} value={`${i}:0`}>{keyLabel({ root: i, minor: false })}</option>)}
        </optgroup>
        <optgroup label="Menor">
          {KEY_LETTERS.map((_, i) => <option key={i} value={`${i}:1`}>{keyLabel({ root: i, minor: true })}</option>)}
        </optgroup>
      </select>

      <div className="spacer" />

      <div className="group">
        <button title={`Desfazer (${shortcut('Z')})`} disabled={!canUndo} onClick={st.undo}>↶</button>
        <button title={`Refazer (${redoShortcut()})`} disabled={!canRedo} onClick={st.redo}>↷</button>
      </div>
      <div className="group">
        <button className="gen-btn" title="Gerar música: monta o esboço de uma música inteira a partir de um estilo" onClick={() => setGen(true)}>✨ Gerar música</button>
        <button title="Novo projeto" onClick={newProject}>Novo</button>
        <button title="Abrir projeto (.mmproj)" onClick={() => openRef.current?.click()}>Abrir</button>
        <button title={`Salvar projeto em arquivo (${shortcut('S')})`} onClick={saveProject}>Salvar</button>
      </div>
      <label className="zoom" title="Zoom da timeline">
        🔍
        <input type="range" min={8} max={80} step={1} value={ppb} onChange={(e) => st.set({ ppb: +e.target.value })} />
      </label>
      <Meter className="master" />
      <div className="group">
        <button title="Importar áudio (WAV, MP3, OGG…) ou MIDI (.mid): entra no compasso do cursor" onClick={() => importRef.current?.click()}>
          Importar
        </button>
        <button
          title="Exportar as notas em MIDI (.mid): uma trilha por instrumento, com andamento, compasso, seções e cifras — para abrir em outro programa"
          onClick={() => exportMidi() || alert('Não há notas para exportar: o MIDI leva as trilhas de instrumento e de bateria.')}
        >
          MIDI
        </button>
        <button className="primary" disabled={exporting} title="Exportar a música (formato e volume na aba Master)" onClick={() => void exportWav()}>
          {exporting ? 'Exportando…' : `Exportar ${(masterOf(project.master).exportFormat ?? 'wav').toUpperCase()}`}
        </button>
      </div>

      <input
        ref={openRef}
        type="file"
        accept=".mmproj,application/json"
        hidden
        onChange={async (e) => {
          const f = e.target.files?.[0];
          e.target.value = '';
          if (!f) return;
          try {
            engine.stop();
            st.loadProject(await withLoading('Abrindo projeto…', () => openProjectFile(f, engine.buffers)));
            engine.seek(0);
          } catch (err) {
            alert('Não foi possível abrir o projeto: ' + (err as Error).message);
          }
        }}
      />
      <input
        ref={importRef}
        type="file"
        accept="audio/*,.mid,.midi,.kar,audio/midi"
        multiple
        hidden
        onChange={async (e) => {
          const files = [...(e.target.files ?? [])];
          e.target.value = '';
          const bb = barBeats(useStore.getState().project);
          const at = Math.floor(engine.getBeat() / bb) * bb;
          await importFiles(files, at);
        }}
      />
    </header>
  );
}
