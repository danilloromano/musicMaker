import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { engine } from './audio/engine';
import { loadLocal, saveProjectLocal } from './audio/persist';
import { useStore } from './store';
import './styles.css';

async function boot() {
  try {
    const saved = await loadLocal(engine.buffers);
    if (saved) useStore.getState().loadProject(saved);
  } catch (e) {
    console.warn('Não foi possível restaurar o projeto salvo', e);
  }
  const s = useStore.getState();
  if (!s.selectedTrackId) s.set({ selectedTrackId: s.project.tracks[0]?.id ?? null });

  // salvamento automático
  let timer = 0;
  useStore.subscribe((state, prev) => {
    if (state.project === prev.project) return;
    clearTimeout(timer);
    timer = window.setTimeout(() => void saveProjectLocal(useStore.getState().project).catch(console.warn), 600);
  });

  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

void boot();
