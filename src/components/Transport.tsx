import { useEffect, useRef, useState } from 'react';
import { engine, renderWav } from '../audio/engine';
import { download, openProjectFile, saveProjectFile } from '../audio/persist';
import { defaultProject, savePref, useStore } from '../store';
import { BEATS_PER_BAR } from '../types';
import { Meter, useRaf } from './ui';

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
  const st = useStore.getState();

  const lcd = useRef<HTMLSpanElement>(null);
  const clock = useRef<HTMLSpanElement>(null);
  useRaf(() => {
    const b = engine.getBeat();
    const bar = Math.floor(b / BEATS_PER_BAR) + 1;
    const beat = Math.floor(b % BEATS_PER_BAR) + 1;
    const sec = (b * 60) / project.bpm;
    if (lcd.current) lcd.current.textContent = `${bar}.${beat}`;
    if (clock.current) {
      clock.current.textContent = `${Math.floor(sec / 60)}:${(sec % 60).toFixed(1).padStart(4, '0')}`;
    }
  });

  const [bpmText, setBpmText] = useState(String(project.bpm));
  useEffect(() => setBpmText(String(project.bpm)), [project.bpm]);
  const commitBpm = () => {
    const v = Math.round(+bpmText);
    if (v >= 40 && v <= 240 && v !== project.bpm) st.update((p) => ({ ...p, bpm: v }));
    else setBpmText(String(project.bpm));
  };

  const openRef = useRef<HTMLInputElement>(null);
  const importRef = useRef<HTMLInputElement>(null);
  const [exporting, setExporting] = useState(false);

  const exportWav = async () => {
    setExporting(true);
    try {
      download(await renderWav(project, engine.buffers), `${project.name || 'musica'}.wav`);
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
        <button title="Novo projeto" onClick={newProject}>Novo</button>
        <button title="Abrir projeto (.mmproj)" onClick={() => openRef.current?.click()}>Abrir</button>
        <button title="Salvar projeto em arquivo (Ctrl+S)" onClick={saveProject}>Salvar</button>
      </div>
      <div className="group">
        <button title="Desfazer (Ctrl+Z)" disabled={!canUndo} onClick={st.undo}>↶</button>
        <button title="Refazer (Ctrl+Y)" disabled={!canRedo} onClick={st.redo}>↷</button>
      </div>

      <div className="spacer" />

      <div className="group">
        <button className="tbtn" title="Voltar ao início (Enter)" onClick={() => engine.seek(0)}>⏮</button>
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
        title="Metrônomo (clique em cada tempo)"
        onClick={() => st.update((p) => ({ ...p, metronome: !p.metronome }), false)}
      >
        <span className="ico">♩</span><span className="lbl"> Metrônomo</span>
      </button>
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
        className={loopOn ? 'toggle on' : 'toggle'}
        title="Tocar um trecho em repetição (C). Ajuste o trecho arrastando a faixa na régua; Shift + arrastar na régua marca um novo trecho."
        onClick={() => st.toggleLoop(engine.getBeat())}
      >
        <span className="ico">🔁</span><span className="lbl"> Loop</span>
      </button>

      <div className="spacer" />

      <label className="zoom" title="Zoom da timeline">
        🔍
        <input type="range" min={8} max={80} step={1} value={ppb} onChange={(e) => st.set({ ppb: +e.target.value })} />
      </label>
      <Meter className="master" />
      <div className="group">
        <button title="Importar arquivo de áudio (WAV, MP3, OGG...)" onClick={() => importRef.current?.click()}>
          Importar áudio
        </button>
        <button className="primary" disabled={exporting} title="Exportar a música em WAV" onClick={() => void exportWav()}>
          {exporting ? 'Exportando…' : 'Exportar WAV'}
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
            st.loadProject(await openProjectFile(f, engine.buffers));
            engine.seek(0);
          } catch (err) {
            alert('Não foi possível abrir o projeto: ' + (err as Error).message);
          }
        }}
      />
      <input
        ref={importRef}
        type="file"
        accept="audio/*"
        multiple
        hidden
        onChange={async (e) => {
          const files = [...(e.target.files ?? [])];
          e.target.value = '';
          for (const f of files) await engine.importAudio(f, Math.floor(engine.getBeat() / BEATS_PER_BAR) * BEATS_PER_BAR);
        }}
      />
    </header>
  );
}
