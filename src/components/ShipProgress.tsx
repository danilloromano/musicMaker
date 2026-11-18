import { useStore } from '../store';

/** Disco voador (desenho original) com um ET verde na cúpula, inclinado para a frente, com luzes piscando. */
function Ship() {
  return (
    <svg className="ship" viewBox="0 0 64 28" width="64" height="28" overflow="visible" aria-hidden="true">
      <defs>
        <linearGradient id="ship-body" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" stopColor="#f2f3ee" />
          <stop offset="0.5" stopColor="#b9bdb6" />
          <stop offset="1" stopColor="#6f746e" />
        </linearGradient>
        <radialGradient id="ship-dome" cx="0.4" cy="0.35" r="0.75">
          <stop offset="0" stopColor="#d8f4ff" stopOpacity="0.45" />
          <stop offset="1" stopColor="#5fa8c8" stopOpacity="0.3" />
        </radialGradient>
      </defs>
      <g transform="rotate(6 32 16)">
        {/* ET na cúpula */}
        <ellipse cx="32" cy="7.6" rx="4.2" ry="4.6" fill="#5fe86a" />
        <ellipse cx="30.3" cy="7.9" rx="1.5" ry="0.85" transform="rotate(25 30.3 7.9)" fill="#0b0d10" />
        <ellipse cx="33.7" cy="7.9" rx="1.5" ry="0.85" transform="rotate(-25 33.7 7.9)" fill="#0b0d10" />
        {/* cúpula de vidro */}
        <path d="M22 13 Q22 0.8 32 0.8 Q42 0.8 42 13 Z" fill="url(#ship-dome)" stroke="#2b2e32" strokeWidth="0.8" />
        <path d="M25 7 Q26.5 3.4 30.5 2.8" fill="none" stroke="#fff" strokeWidth="1" strokeLinecap="round" opacity="0.7" />
        {/* disco */}
        <ellipse cx="32" cy="18.5" rx="20" ry="4" fill="#4a4e4a" stroke="#2b2e32" strokeWidth="0.8" />
        <ellipse cx="32" cy="16" rx="30" ry="4.6" fill="url(#ship-body)" stroke="#2b2e32" strokeWidth="0.9" />
        <path d="M4 16 Q32 20 60 16" fill="none" stroke="#00d455" strokeWidth="1.2" />
        {/* luzes */}
        <g className="ship-lights">
          {[10, 21, 32, 43, 54].map((cx, i) => (
            <circle key={cx} className={i % 2 ? 'odd' : 'even'} cx={cx} cy={cx === 32 ? 18.6 : cx === 21 || cx === 43 ? 18 : 16.8} r="1.3" fill="#eafff0" />
          ))}
        </g>
      </g>
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
