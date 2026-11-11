import { useEffect } from 'react';
import { engine } from './audio/engine';
import { BottomPanel, KEY_ROW } from './components/BottomPanel';
import { Timeline } from './components/Timeline';
import { Transport, saveProject } from './components/Transport';
import { useStore } from './store';

const isTyping = (el: EventTarget | null) => {
  if (!(el instanceof HTMLElement)) return false;
  if (el instanceof HTMLInputElement) return el.type !== 'range';
  return el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement;
};

// campos onde a barra de espaço digita um espaço de verdade
const typesText = (el: EventTarget | null) =>
  el instanceof HTMLTextAreaElement ||
  (el instanceof HTMLElement && el.isContentEditable) ||
  (el instanceof HTMLInputElement && ['text', 'search', 'email', 'url', 'tel', 'password'].includes(el.type));

function useShortcuts() {
  useEffect(() => {
    const held = new Map<string, number>(); // tecla → nota que ela disparou

    const down = (e: KeyboardEvent) => {
      // Espaço toca/pausa de qualquer lugar (lista de entradas, BPM, botões…), exceto ao digitar texto
      if (e.code === 'Space' && !e.ctrlKey && !e.metaKey && !e.altKey && !typesText(e.target)) {
        e.preventDefault();
        if (e.repeat) return;
        (document.activeElement as HTMLElement | null)?.blur?.();
        engine.toggle();
        return;
      }
      if (isTyping(e.target)) return;
      const s = useStore.getState();
      const k = e.key.toLowerCase();

      if (e.ctrlKey || e.metaKey) {
        if (k === 'z') (e.shiftKey ? s.redo : s.undo)();
        else if (k === 'y') s.redo();
        else if (k === 's') saveProject();
        else if (k === 'd' && s.selectedRegionId) s.duplicateRegion(s.selectedRegionId);
        else if (k === 't' && s.selectedRegionId) {
          // áudio é cortado exatamente no cursor; MIDI, na grade de 1/16
          const audio = s.project.regions.find((r) => r.id === s.selectedRegionId)?.bufferId;
          s.splitRegion(s.selectedRegionId, audio ? engine.getBeat() : Math.round(engine.getBeat() * 4) / 4);
        }
        else return;
        e.preventDefault();
        return;
      }
      if (e.altKey) return;

      if (k === 'enter') engine.seek(0);
      else if (k === 'c' && !e.repeat) s.toggleLoop(engine.getBeat());
      else if (k === 'r' && !e.repeat) void engine.toggleRecord();
      else if (k === 'escape') s.set({ audioSel: null });
      else if ((k === 'delete' || k === 'backspace') && s.audioSel && s.bottomTab === 'audio') {
        // trecho selecionado no editor de áudio: apaga só ele
        s.deleteAudioRange(s.audioSel.trackId, s.audioSel.start, s.audioSel.end);
      } else if (k === 'delete' || k === 'backspace') {
        const region = s.project.regions.find((r) => r.id === s.editingRegionId);
        if (s.selectedNoteId && region?.notes?.some((n) => n.id === s.selectedNoteId)) {
          s.setNotes(region.id, region.notes.filter((n) => n.id !== s.selectedNoteId));
          s.set({ selectedNoteId: null });
        } else if (s.selectedRegionId) s.removeRegion(s.selectedRegionId);
      } else if (k === 'z') s.set({ octave: Math.max(0, s.octave - 1) });
      else if (k === 'x') s.set({ octave: Math.min(7, s.octave + 1) });
      else {
        const i = KEY_ROW.indexOf(k);
        if (i < 0 || e.repeat || held.has(k)) return;
        const pitch = (s.octave + 1) * 12 + i;
        held.set(k, pitch);
        engine.noteOn(pitch);
      }
    };

    const up = (e: KeyboardEvent) => {
      const k = e.key.toLowerCase();
      const pitch = held.get(k);
      if (pitch !== undefined) {
        held.delete(k);
        engine.noteOff(pitch);
      }
    };

    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
    };
  }, []);
}

/** Teclado controlador MIDI (só no app desktop, onde a permissão é concedida automaticamente). */
function useMidiInput() {
  useEffect(() => {
    if (!navigator.userAgent.includes('Electron') || !navigator.requestMIDIAccess) return;
    navigator
      .requestMIDIAccess()
      .then((access) => {
        const hook = () =>
          access.inputs.forEach((input) => {
            input.onmidimessage = (m) => {
              if (!m.data) return;
              const [status, pitch, vel] = m.data;
              const cmd = status & 0xf0;
              if (cmd === 0x90 && vel > 0) engine.noteOn(pitch, vel);
              else if (cmd === 0x80 || cmd === 0x90) engine.noteOff(pitch);
            };
          });
        hook();
        access.onstatechange = hook;
      })
      .catch(() => {});
  }, []);
}

/** Mantém a lista de entradas de áudio em dia: detecta placas conectadas/desconectadas com o app aberto. */
function useAudioDevices() {
  useEffect(() => {
    const refresh = () => void engine.refreshInputs();
    refresh();
    navigator.mediaDevices?.addEventListener('devicechange', refresh);
    return () => navigator.mediaDevices?.removeEventListener('devicechange', refresh);
  }, []);
}

export function App() {
  useShortcuts();
  useMidiInput();
  useAudioDevices();
  return (
    <div className="app">
      <Transport />
      <Timeline />
      <BottomPanel />
    </div>
  );
}
