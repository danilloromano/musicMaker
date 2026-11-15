import { useStore } from '../store';

/** Nave (desenho original), virada para a direita, com chama animada no motor. */
function Ship() {
  return (
    <svg className="ship" viewBox="0 0 64 28" width="64" height="28" aria-hidden="true">
      <defs>
        <linearGradient id="ship-body" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" stopColor="#f2f3ee" />
          <stop offset="0.55" stopColor="#b9bdb6" />
          <stop offset="1" stopColor="#7d827c" />
        </linearGradient>
        <linearGradient id="ship-flame" x1="1" x2="0">
          <stop offset="0" stopColor="#fffbe0" />
          <stop offset="0.35" stopColor="#c8f031" />
          <stop offset="1" stopColor="#c8f031" stopOpacity="0" />
        </linearGradient>
      </defs>
      {/* chama */}
      <path className="ship-flame" d="M14 10 Q2 14 14 18 Q8 14 14 10 Z M14 11 L0 14 L14 17 Z" fill="url(#ship-flame)" />
      {/* aletas */}
      <path d="M22 9 L14 1 L28 8 Z" fill="#c8f031" stroke="#2b2e32" strokeWidth="0.8" />
      <path d="M22 19 L14 27 L28 20 Z" fill="#c8f031" stroke="#2b2e32" strokeWidth="0.8" />
      {/* corpo */}
      <path d="M14 9 H40 Q56 9 62 14 Q56 19 40 19 H14 Q12 14 14 9 Z" fill="url(#ship-body)" stroke="#2b2e32" strokeWidth="0.9" />
      {/* faixa e janela */}
      <rect x="18" y="12.6" width="18" height="2.8" rx="1.4" fill="#c8f031" />
      <ellipse cx="46" cy="13.2" rx="5" ry="2.6" fill="#1f2124" stroke="#2b2e32" strokeWidth="0.6" />
      <ellipse cx="47.4" cy="12.4" rx="1.8" ry="0.9" fill="#9fd7ff" opacity="0.8" />
    </svg>
  );
}

/**
 * Barra de progresso com uma nave: com `progress` (0..1) a nave fica na ponta do preenchimento;
 * com `progress` null ela cruza a barra continuamente.
 */
export function ShipProgress({ progress, label }: { progress: number | null; label?: string }) {
  const known = progress !== null;
  const pct = Math.round((progress ?? 0) * 100);
  return (
    <div
      className={`shipbar ${known ? '' : 'indeterminate'}`}
      role="progressbar"
      aria-label={label ?? 'Carregando'}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={known ? pct : undefined}
      style={{ ['--p' as string]: known ? progress : 0 }}
    >
      <div className="shipbar-space">
        <i className="stars s1" />
        <i className="stars s2" />
      </div>
      <div className="shipbar-track">
        <div className="shipbar-fill" />
      </div>
      <div className="shipbar-rider">
        <span className="ship-trail" />
        <Ship />
      </div>
    </div>
  );
}

/** Tela de carregamento por cima do app enquanto houver algo carregando. */
export function LoadingOverlay() {
  const loading = useStore((s) => s.loading);
  if (!loading) return null;
  const pct = loading.progress === null ? null : Math.round(loading.progress * 100);
  return (
    <div className="loading-overlay" aria-live="polite">
      <div className="loading-card">
        <ShipProgress progress={loading.progress} label={loading.label} />
        <div className="loading-text">
          <span>{loading.label}</span>
          {pct !== null && <b>{pct}%</b>}
        </div>
      </div>
    </div>
  );
}
