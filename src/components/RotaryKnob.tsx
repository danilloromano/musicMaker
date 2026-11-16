import { useEffect, useRef, useState } from 'react';
import { useStore } from '../store';

interface Props {
  label: string;
  value: number; // 0..1
  onChange: (v: number) => void;
  reset?: number;
  size?: number;
  /** texto do valor (padrão: escala 0–10) */
  fmt?: (v: number) => string;
}

const clamp = (v: number) => Math.min(1, Math.max(0, v));
const DRAG_PX = 160; // arrastar 160 px vai do mínimo ao máximo (com Shift, 4x mais fino)

/**
 * Botão giratório de pedal. Arraste para cima/baixo, use a roda do mouse ou as setas do teclado;
 * duplo clique volta ao valor padrão. Cada gesto vira uma única etapa de desfazer.
 */
export function RotaryKnob({ label, value, onChange, reset, size = 34, fmt = (v) => (v * 10).toFixed(1) }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState(false);
  const live = useRef({ value, onChange });
  live.current = { value, onChange };
  const lastWheel = useRef(0);

  // roda do mouse: o React registra wheel como passivo, então o preventDefault precisa de listener próprio
  useEffect(() => {
    const el = ref.current!;
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      const now = performance.now();
      if (now - lastWheel.current > 400) useStore.getState().snapshot();
      lastWheel.current = now;
      const step = (e.shiftKey ? 0.005 : 0.02) * (e.deltaY < 0 ? 1 : -1);
      live.current.onChange(clamp(live.current.value + step));
    };
    el.addEventListener('wheel', wheel, { passive: false });
    return () => el.removeEventListener('wheel', wheel);
  }, []);

  const down = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    useStore.getState().snapshot();
    const el = e.currentTarget as HTMLElement;
    try {
      el.setPointerCapture(e.pointerId); // continua girando mesmo se o mouse sair do botão
    } catch {
      /* ponteiro já liberado: segue sem captura */
    }
    el.focus();
    const y0 = e.clientY, v0 = value;
    setActive(true);
    const move = (ev: PointerEvent) => live.current.onChange(clamp(v0 + (y0 - ev.clientY) / (DRAG_PX * (ev.shiftKey ? 4 : 1))));
    const up = () => {
      setActive(false);
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  };

  const key = (e: React.KeyboardEvent) => {
    const step = e.shiftKey ? 0.1 : 0.01;
    const map: Record<string, number> = { ArrowUp: step, ArrowRight: step, ArrowDown: -step, ArrowLeft: -step };
    if (e.key in map) {
      e.preventDefault();
      e.stopPropagation(); // não deixa as setas chegarem aos atalhos globais
      if (!e.repeat) useStore.getState().snapshot();
      onChange(clamp(value + map[e.key]));
    } else if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      useStore.getState().snapshot();
      onChange(e.key === 'Home' ? 0 : 1);
    }
  };

  const angle = -135 + value * 270;
  const r = 15; // raio do arco de escala no viewBox de 40
  const arc = (a: number) => {
    const rad = ((a - 90) * Math.PI) / 180;
    return `${20 + r * Math.cos(rad)} ${20 + r * Math.sin(rad)}`;
  };

  return (
    <div className={`rknob ${active ? 'active' : ''}`}>
      <div
        ref={ref}
        className="rknob-dial"
        role="slider"
        tabIndex={0}
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={10}
        aria-valuenow={Math.round(value * 100) / 10}
        title={`${label}: ${fmt(value)} (arraste, roda do mouse ou setas · duplo clique volta ao padrão)`}
        style={{ width: size, height: size }}
        onPointerDown={down}
        onDoubleClick={() => {
          if (reset === undefined) return;
          useStore.getState().snapshot();
          onChange(reset);
        }}
        onKeyDown={key}
      >
        <svg viewBox="0 0 40 40" width={size} height={size} aria-hidden="true">
          {/* trilha da escala e a parte "acesa" até o valor atual */}
          <path d={`M ${arc(-135)} A ${r} ${r} 0 1 1 ${arc(135)}`} className="rk-track" />
          {value > 0.003 && <path d={`M ${arc(-135)} A ${r} ${r} 0 ${angle + 135 > 180 ? 1 : 0} 1 ${arc(angle)}`} className="rk-fill" />}
          <circle cx="20" cy="20" r="12" className="rk-skirt" />
          <circle cx="20" cy="20" r="9.5" className="rk-cap" />
          <g transform={`rotate(${angle} 20 20)`}>
            <line x1="20" y1="19" x2="20" y2="9.5" className="rk-pointer" />
          </g>
        </svg>
      </div>
      <span className="rknob-label">{active ? fmt(value) : label}</span>
    </div>
  );
}
