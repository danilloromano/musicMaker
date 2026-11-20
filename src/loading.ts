// Carregamentos com a nave: envolve uma operação demorada e mostra o progresso na tela.
import { useStore } from './store';

const MIN_VISIBLE_MS = 700; // não deixa a nave só piscar quando o carregamento é rápido
let depth = 0;

/**
 * Mostra a barra da nave enquanto `fn` roda. `fn` recebe `progress(0..1)` para avançar a nave;
 * se nunca for chamado, a nave cruza a barra continuamente (progresso desconhecido).
 */
export async function withLoading<T>(label: string, fn: (progress: (p: number) => void) => Promise<T>): Promise<T> {
  const { set } = useStore.getState();
  const t0 = performance.now();
  depth++;
  set({ loading: { label, progress: null } });
  const progress = (p: number) => {
    const cur = useStore.getState().loading;
    if (cur?.label === label) set({ loading: { label, progress: Math.min(1, Math.max(0, p)) } });
  };
  try {
    return await fn(progress);
  } finally {
    const left = MIN_VISIBLE_MS - (performance.now() - t0);
    if (left > 0) await new Promise((r) => setTimeout(r, left));
    if (--depth === 0) set({ loading: null });
  }
}
