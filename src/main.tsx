import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { engine } from './audio/engine';
import { loadLocal, saveProjectLocal } from './audio/persist';
import { withLoading } from './loading';
import { useStore } from './store';
import './styles.css';

async function boot() {
  // a tela aparece já com a nave; o projeto salvo carrega por trás
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );

  await withLoading('Abrindo o Alien Studio…', async () => {
    try {
      const saved = await loadLocal(engine.buffers);
      if (saved) useStore.getState().loadProject(saved);
    } catch (e) {
      console.warn('Não foi possível restaurar o projeto salvo', e);
    }
  });
  const s = useStore.getState();
  if (!s.selectedTrackId) s.set({ selectedTrackId: s.project.tracks[0]?.id ?? null });

  // salvamento automático (só depois de carregar, para não gravar o projeto vazio por cima do salvo)
  let timer = 0;
  useStore.subscribe((state, prev) => {
    if (state.project === prev.project) return;
    clearTimeout(timer);
    timer = window.setTimeout(() => void saveProjectLocal(useStore.getState().project).catch(console.warn), 600);
  });
}

void boot();
