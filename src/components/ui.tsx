import { useEffect, useRef } from 'react';
import { SPECTRUM_BINS, engine } from '../audio/engine';
import { useStore } from '../store';

/** Executa `cb` a cada quadro de animação (playhead, medidores). */
export function useRaf(cb: () => void) {
  const ref = useRef(cb);
  ref.current = cb;
  useEffect(() => {
    let id = requestAnimationFrame(function loop() {
      ref.current();
      id = requestAnimationFrame(loop);
    });
    return () => cancelAnimationFrame(id);
  }, []);
}

interface SliderProps {
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
  reset?: number;
  title?: string;
  className?: string;
}

/** Controle deslizante: um arrasto inteiro vira uma única etapa de desfazer. Duplo clique restaura o padrão. */
export function Slider({ value, min, max, step, onChange, reset, title, className }: SliderProps) {
  return (
    <input
      type="range"
      className={className}
      title={title}
      min={min}
      max={max}
      step={step}
      value={value}
      onPointerDown={() => useStore.getState().snapshot()}
      onChange={(e) => onChange(+e.target.value)}
      onDoubleClick={() => reset !== undefined && onChange(reset)}
    />
  );
}

export function Meter({ trackId, className = '' }: { trackId?: string; className?: string }) {
  const fill = useRef<HTMLDivElement>(null);
  const val = useRef(0);
  useRaf(() => {
    val.current = Math.max(engine.level(trackId), val.current * 0.88);
    if (fill.current) fill.current.style.transform = `scaleX(${Math.min(1, val.current ** 0.6)})`;
  });
  return (
    <div className={`meter ${className}`}>
      <div className="meter-fill" ref={fill} />
    </div>
  );
}

const F_MIN = 30, F_MAX = 18000;
const F_LABELS: [number, string][] = [[50, '50'], [100, '100'], [200, '200'], [500, '500'], [1000, '1k'], [2000, '2k'], [5000, '5k'], [10000, '10k']];
const fx = (f: number) => Math.log(f / F_MIN) / Math.log(F_MAX / F_MIN); // posição 0..1 em escala logarítmica

/** Analisador de espectro em tempo real (graves à esquerda, agudos à direita) de uma trilha ou do master. */
export function Spectrum({ trackId, color, bars, labels = false, className = '' }: {
  trackId?: string;
  color: string;
  bars: number;
  labels?: boolean;
  className?: string;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const data = useRef(new Uint8Array(SPECTRUM_BINS));
  const idle = useRef(false);

  useRaf(() => {
    const cv = ref.current;
    if (!cv) return;
    const dpr = window.devicePixelRatio || 1;
    const w = Math.round(cv.clientWidth * dpr), h = Math.round(cv.clientHeight * dpr);
    if (!w || !h) return;
    const resized = cv.width !== w || cv.height !== h;
    if (resized) {
      cv.width = w;
      cv.height = h;
    }
    const ok = engine.spectrum(data.current, trackId);
    const d = data.current;
    const silent = !ok || !d.some((v) => v > 0);
    if (silent && idle.current && !resized) return; // nada mudou: não redesenha
    idle.current = silent;

    const g = cv.getContext('2d')!;
    g.clearRect(0, 0, w, h);
    const foot = labels ? Math.round(13 * dpr) : 0;
    const ph = h - foot;

    if (labels) {
      g.font = `${10 * dpr}px Consolas, monospace`;
      g.textAlign = 'center';
      for (const [f, text] of F_LABELS) {
        const x = Math.round(fx(f) * w);
        g.fillStyle = 'rgba(255,255,255,0.08)';
        g.fillRect(x, 0, 1, ph);
        g.fillStyle = '#8d93a0';
        g.fillText(text, x, h - 2 * dpr);
      }
    }
    if (silent) return;

    const hzPerBin = engine.ctx.sampleRate / 2 / SPECTRUM_BINS;
    const bw = w / bars;
    g.fillStyle = color;
    for (let i = 0; i < bars; i++) {
      const lo = F_MIN * (F_MAX / F_MIN) ** (i / bars), hi = F_MIN * (F_MAX / F_MIN) ** ((i + 1) / bars);
      const a = Math.floor(lo / hzPerBin), b = Math.max(a, Math.min(SPECTRUM_BINS - 1, Math.floor(hi / hzPerBin)));
      let v = 0;
      for (let k = a; k <= b; k++) v = Math.max(v, d[k]);
      const bh = (v / 255) ** 1.6 * ph;
      if (bh >= 1) g.fillRect(Math.round(i * bw), ph - bh, Math.max(1, Math.ceil(bw) - (bw > 3 ? 1 : 0)), bh);
    }
  });

  return <canvas className={`spectrum ${className}`} ref={ref} />;
}

export const KIND_ICON = { instrument: '🎹', drums: '🥁', audio: '🎤' } as const;
