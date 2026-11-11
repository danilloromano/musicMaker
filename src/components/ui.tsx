import { useEffect, useRef } from 'react';
import { engine } from '../audio/engine';
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

export const KIND_ICON = { instrument: '🎹', drums: '🥁', audio: '🎤' } as const;
