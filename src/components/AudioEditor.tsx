import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { engine } from '../audio/engine';
import { useStore } from '../store';
import { Region, regionGainAt } from '../types';
import { gainDb } from './Timeline';
import { Slider, useRaf } from './ui';

const RULER_H = 20;
const HANDLE = 10; // alça de fade (px)
const EDGE = 5; // distância (px) para agarrar a borda de uma região
const MAX_PPS = 40000; // pixels por segundo no zoom máximo (amostras individuais visíveis)
const MAX_WIDTH = 30_000_000; // limite de largura de elemento do navegador
const STEPS = [0.001, 0.002, 0.005, 0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300];

function fmt(sec: number, step: number) {
  const m = Math.floor(sec / 60);
  const s = sec - m * 60;
  const dec = step < 0.01 ? 3 : step < 0.1 ? 2 : step < 1 ? 1 : 0;
  return `${m}:${s.toFixed(dec).padStart(dec ? 3 + dec : 2, '0')}`;
}

const fmtLen = (sec: number) => (sec >= 1 ? `${sec.toFixed(2)} s` : `${Math.round(sec * 1000)} ms`);

/** Editor de forma de onda com zoom profundo, para cortar regiões de áudio com precisão. */
export function AudioEditor() {
  const region = useStore((s) => s.project.regions.find((r) => r.id === s.audioEditId && r.bufferId));
  const track = useStore((s) => s.project.tracks.find((t) => t.id === region?.trackId));
  const regions = useStore((s) => s.project.regions);
  const bpm = useStore((s) => s.project.bpm);
  const st = useStore.getState();

  const scroll = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const head = useRef<HTMLDivElement>(null);
  const [pps, setPps] = useState(200);
  const [vzoom, setVzoom] = useState(1);
  const sel = useStore((s) => s.audioSel);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const anchor = useRef<{ sec: number; x: number } | null>(null);

  const spb = 60 / bpm;
  const trackRegions = regions.filter((r) => r.trackId === track?.id && r.bufferId);
  const endSec = trackRegions.reduce((m, r) => Math.max(m, r.start * spb + (r.duration ?? 0)), 0);
  const totalSec = Math.max(endSec + 2, 4);
  const maxPps = Math.min(MAX_PPS, MAX_WIDTH / totalSec);
  const minPps = Math.max(0.5, size.w / totalSec);

  // tamanho visível do editor
  useEffect(() => {
    const sc = scroll.current;
    if (!sc) return;
    const ro = new ResizeObserver(() => setSize({ w: sc.clientWidth, h: sc.clientHeight }));
    ro.observe(sc);
    return () => ro.disconnect();
  }, [region?.id]);

  /** Muda o zoom mantendo fixo o instante que está sob a posição x (px a partir da borda esquerda). */
  const applyZoom = useCallback(
    (next: number, sec: number, x: number) => {
      const sc = scroll.current;
      if (!sc) return;
      const z = Math.min(maxPps, Math.max(minPps, next));
      if (z === pps) sc.scrollLeft = Math.max(0, sec * pps - x);
      else {
        anchor.current = { sec, x };
        setPps(z);
      }
    },
    [pps, maxPps, minPps],
  );
  const zoomTo = useCallback(
    (next: number, x?: number) => {
      const sc = scroll.current;
      if (!sc) return;
      const px = x ?? sc.clientWidth / 2;
      applyZoom(next, (sc.scrollLeft + px) / pps, px);
    },
    [pps, applyZoom],
  );

  useLayoutEffect(() => {
    const sc = scroll.current;
    const a = anchor.current;
    if (!sc || !a) return;
    anchor.current = null;
    sc.scrollLeft = Math.max(0, a.sec * pps - a.x);
  }, [pps]);

  /** Enquadra a região inteira na tela. */
  const fit = useCallback(() => {
    const sc = scroll.current;
    const r = useStore.getState().project.regions.find((x) => x.id === useStore.getState().audioEditId);
    if (!sc || !r || !sc.clientWidth) return;
    const dur = Math.max(0.05, r.duration ?? 0);
    const start = r.start * spb;
    applyZoom((sc.clientWidth * 0.92) / dur, Math.max(0, start - dur * 0.04), 0);
  }, [spb, applyZoom]);

  // ao trocar de região (ou abrir o editor), enquadra a região
  const fitted = useRef<string | null>(null);
  useEffect(() => {
    if (!region || !size.w || fitted.current === region.id) return;
    fitted.current = region.id;
    fit();
  }, [region, size.w, fit]);

  // roda do mouse = zoom no ponto do mouse; Shift + roda (ou rolagem lateral) = andar no tempo
  useEffect(() => {
    const sc = scroll.current;
    if (!sc) return;
    const wheel = (e: WheelEvent) => {
      if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
        if (e.shiftKey && !e.deltaX) {
          e.preventDefault();
          sc.scrollLeft += e.deltaY;
        }
        return;
      }
      e.preventDefault();
      zoomTo(pps * Math.pow(1.0018, -e.deltaY), e.clientX - sc.getBoundingClientRect().left);
    };
    sc.addEventListener('wheel', wheel, { passive: false });
    return () => sc.removeEventListener('wheel', wheel);
  }, [zoomTo, pps]);

  // ---------- desenho ----------
  const draw = useCallback(() => {
    const cv = canvas.current;
    const sc = scroll.current;
    if (!cv || !sc || !track || !size.w || !size.h) return;
    const dpr = window.devicePixelRatio || 1;
    const W = Math.round(size.w * dpr);
    const H = Math.round(size.h * dpr);
    if (cv.width !== W) cv.width = W;
    if (cv.height !== H) cv.height = H;
    cv.style.width = `${size.w}px`;
    cv.style.height = `${size.h}px`;
    const g = cv.getContext('2d')!;
    const dpps = pps * dpr; // pixels de tela por segundo
    const view0 = sc.scrollLeft / pps; // segundo na borda esquerda
    const xOf = (sec: number) => (sec - view0) * dpps;
    const top = RULER_H * dpr;
    const mid = top + (H - top) / 2;
    const amp = ((H - top) / 2 - 4 * dpr) * vzoom;

    g.fillStyle = '#1b1d22';
    g.fillRect(0, 0, W, H);

    // grade de tempos e compassos
    const beatPx = spb * dpps;
    if (beatPx >= 6) {
      const b0 = Math.floor(view0 / spb);
      const b1 = Math.ceil((view0 + W / dpps) / spb);
      for (let b = b0; b <= b1; b++) {
        g.fillStyle = b % 4 === 0 ? '#3a3f4b' : '#2a2d35';
        g.fillRect(Math.round(xOf(b * spb)), top, 1, H - top);
      }
    }

    // regiões da trilha
    const selId = useStore.getState().audioEditId;
    for (const r of trackRegions) {
      const buf = engine.buffers.get(r.bufferId!);
      if (!buf) continue;
      const rs = r.start * spb;
      const dur = r.duration ?? 0;
      const x0 = Math.max(0, Math.floor(xOf(rs)));
      const x1 = Math.min(W, Math.ceil(xOf(rs + dur)));
      if (x1 <= 0 || x0 >= W) continue;
      const sel = r.id === selId;
      g.globalAlpha = sel ? 0.32 : 0.14;
      g.fillStyle = track.color;
      g.fillRect(x0, top, x1 - x0, H - top);
      g.globalAlpha = 1;

      const data = buf.getChannelData(0);
      const sr = buf.sampleRate;
      const off = r.offset ?? 0;
      const sampleAt = (sec: number) => (sec - rs + off) * sr; // posição (fracionária) da amostra
      const first = Math.floor(off * sr);
      const last = Math.min(data.length, Math.floor((off + dur) * sr));
      g.fillStyle = sel ? '#eef1f6' : '#9aa1ae';
      g.strokeStyle = g.fillStyle;
      const per = sr / dpps; // amostras por pixel

      if (per >= 1) {
        const stride = Math.max(1, Math.floor(per / 3000));
        for (let x = x0; x < x1; x++) {
          const a = Math.max(first, Math.floor(sampleAt(view0 + x / dpps)));
          const b = Math.min(last, Math.floor(sampleAt(view0 + (x + 1) / dpps)));
          let lo = 0, hi = 0;
          for (let i = a; i < b; i += stride) {
            const v = data[i];
            if (v < lo) lo = v;
            if (v > hi) hi = v;
          }
          // mostra o som como vai tocar: com o volume e os fades da região
          const env = regionGainAt(r, view0 + (x + 0.5) / dpps - rs);
          const yHi = mid - Math.min(1, hi * env * vzoom) * (amp / vzoom);
          const yLo = mid - Math.max(-1, lo * env * vzoom) * (amp / vzoom);
          g.fillRect(x, yHi, 1, Math.max(1, yLo - yHi));
        }
      } else {
        // zoom além de 1 amostra por pixel: liga as amostras com linhas (e marca cada uma quando há espaço)
        const a = Math.max(first, Math.floor(sampleAt(view0 + x0 / dpps)) - 1);
        const b = Math.min(last - 1, Math.ceil(sampleAt(view0 + x1 / dpps)) + 1);
        const xs = (i: number) => xOf(rs + (i / sr - off));
        const ys = (i: number) =>
          mid - Math.max(-1, Math.min(1, data[i] * regionGainAt(r, i / sr - off) * vzoom)) * (amp / vzoom);
        g.lineWidth = Math.max(1, dpr);
        g.beginPath();
        for (let i = a; i <= b; i++) (i === a ? g.moveTo : g.lineTo).call(g, xs(i), ys(i));
        g.stroke();
        if (1 / per >= 8) for (let i = a; i <= b; i++) g.fillRect(xs(i) - 1.5 * dpr, ys(i) - 1.5 * dpr, 3 * dpr, 3 * dpr);
      }

      // bordas e nome
      g.fillStyle = sel ? track.color : '#5a606d';
      g.fillRect(Math.round(xOf(rs)), top, Math.max(1, dpr * (sel ? 2 : 1)), H - top);
      g.fillRect(Math.round(xOf(rs + dur)) - 1, top, Math.max(1, dpr * (sel ? 2 : 1)), H - top);
      g.fillStyle = '#d7dbe3';
      g.font = `${11 * dpr}px system-ui, sans-serif`;
      g.fillText(r.name, Math.max(x0, 0) + 6 * dpr, top + 26 * dpr);

      // curvas de fade e alças (quadrados no alto, arrastáveis)
      const fi = r.fadeIn ?? 0;
      const fo = r.fadeOut ?? 0;
      g.strokeStyle = 'rgba(255,255,255,0.8)';
      g.lineWidth = dpr;
      g.beginPath();
      if (fi > 0) {
        g.moveTo(xOf(rs), H);
        g.lineTo(xOf(rs + fi), top);
      }
      if (fo > 0) {
        g.moveTo(xOf(rs + dur - fo), top);
        g.lineTo(xOf(rs + dur), H);
      }
      g.stroke();
      const hs = HANDLE * dpr;
      g.fillStyle = '#fff';
      g.fillRect(xOf(rs + fi), top + dpr, hs, hs);
      g.fillRect(xOf(rs + dur - fo) - hs, top + dpr, hs, hs);
    }

    // linha do zero
    g.fillStyle = 'rgba(255,255,255,0.12)';
    g.fillRect(0, Math.round(mid), W, 1);

    // trecho selecionado
    if (sel && sel.trackId === track.id) {
      const a = xOf(sel.start * spb);
      const b = xOf(sel.end * spb);
      g.fillStyle = 'rgba(79,156,249,0.28)';
      g.fillRect(a, top, b - a, H - top);
      g.fillStyle = 'rgba(79,156,249,0.9)';
      g.fillRect(Math.round(a), top, dpr, H - top);
      g.fillRect(Math.round(b), top, dpr, H - top);
    }

    // régua em segundos
    g.fillStyle = '#22242a';
    g.fillRect(0, 0, W, top);
    g.fillStyle = '#000';
    g.fillRect(0, top - 1, W, 1);
    const step = STEPS.find((s) => s * pps >= 80) ?? 600;
    g.fillStyle = '#8b92a0';
    g.font = `${10 * dpr}px system-ui, sans-serif`;
    for (let t = Math.floor(view0 / step) * step; t <= view0 + W / dpps; t += step) {
      const x = Math.round(xOf(t));
      g.fillRect(x, top - 7 * dpr, 1, 7 * dpr);
      g.fillText(fmt(t + 1e-9, step), x + 3 * dpr, 13 * dpr);
      for (let k = 1; k < 5; k++) g.fillRect(Math.round(xOf(t + (k * step) / 5)), top - 3 * dpr, 1, 3 * dpr);
    }
  }, [track, trackRegions, pps, vzoom, spb, size, sel]);

  useEffect(() => draw());
  useEffect(() => {
    const sc = scroll.current;
    if (!sc) return;
    let raf = 0;
    const on = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(draw);
    };
    sc.addEventListener('scroll', on);
    return () => {
      sc.removeEventListener('scroll', on);
      cancelAnimationFrame(raf);
    };
  }, [draw]);

  // cursor de reprodução; acompanha a música quando sai da tela
  useRaf(() => {
    const sc = scroll.current;
    if (!sc || !head.current) return;
    const x = engine.getBeat() * spb * pps;
    if (useStore.getState().playing && (x > sc.scrollLeft + sc.clientWidth - 20 || x < sc.scrollLeft)) {
      sc.scrollLeft = Math.max(0, x - 40);
    }
    const vx = x - sc.scrollLeft;
    head.current.style.display = vx >= 0 && vx <= sc.clientWidth ? 'block' : 'none';
    head.current.style.transform = `translateX(${vx}px)`;
  });

  type Grab = { r: Region; part: 'fadeIn' | 'fadeOut' | 'start' | 'end' };

  /** O que está sob o mouse: alça de fade (no alto da região) ou borda da região. */
  const grabAt = (clientX: number, clientY: number): Grab | null => {
    const sc = scroll.current!;
    const rect = sc.getBoundingClientRect();
    const mx = clientX - rect.left;
    const my = clientY - rect.top;
    const px = (sec: number) => sec * pps - sc.scrollLeft;
    const inHandleRow = my >= RULER_H && my <= RULER_H + HANDLE + 4;
    // a região selecionada tem prioridade quando duas bordas se encostam
    const sel = useStore.getState().audioEditId;
    const list = [...trackRegions].sort((a, b) => (a.id === sel ? -1 : b.id === sel ? 1 : 0));
    for (const r of list) {
      const rs = r.start * spb;
      const d = r.duration ?? 0;
      if (inHandleRow) {
        const a = px(rs + (r.fadeIn ?? 0));
        if (mx >= a - 2 && mx <= a + HANDLE + 2) return { r, part: 'fadeIn' };
        const b = px(rs + d - (r.fadeOut ?? 0));
        if (mx >= b - HANDLE - 2 && mx <= b + 2) return { r, part: 'fadeOut' };
      }
    }
    if (my < RULER_H) return null;
    for (const r of list) {
      const rs = r.start * spb;
      if (Math.abs(mx - px(rs)) <= EDGE) return { r, part: 'start' };
      if (Math.abs(mx - px(rs + (r.duration ?? 0))) <= EDGE) return { r, part: 'end' };
    }
    return null;
  };

  /** Arrasta alça de fade ou borda (corte), sem grade: precisão de amostra conforme o zoom. */
  const dragGrab = (e: React.PointerEvent, { r, part }: Grab) => {
    st.set({ audioEditId: r.id, selectedRegionId: r.id, selectedTrackId: r.trackId });
    fitted.current = r.id;
    const x0 = e.clientX;
    const rs = r.start * spb;
    const off = r.offset ?? 0;
    const d = r.duration ?? 0;
    const bufDur = engine.buffers.get(r.bufferId!)?.duration ?? d + off;
    const MIN = 0.01;
    let snapped = false;
    const move = (ev: PointerEvent) => {
      const dx = (ev.clientX - x0) / pps;
      let patch: Partial<Region>;
      if (part === 'fadeIn') patch = { fadeIn: Math.max(0, (r.fadeIn ?? 0) + dx) };
      else if (part === 'fadeOut') patch = { fadeOut: Math.max(0, (r.fadeOut ?? 0) - dx) };
      else if (part === 'end') patch = { duration: Math.min(bufDur - off, Math.max(MIN, d + dx)) };
      else {
        // o início não pode passar do começo do áudio gravado nem do zero da música
        const shift = Math.min(d - MIN, Math.max(-off, -rs, dx));
        patch = { start: (rs + shift) / spb, offset: off + shift, duration: d - shift };
      }
      if (!snapped) {
        st.snapshot();
        snapped = true;
      }
      st.updateRegion(r.id, patch, false);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', () => window.removeEventListener('pointermove', move), { once: true });
  };

  /**
   * Clique posiciona o cursor exatamente (sem grade) e seleciona a região clicada.
   * Na forma de onda, clicar e arrastar seleciona um trecho (apagado com Delete); na régua, arrastar move o cursor.
   */
  const press = (e: React.PointerEvent) => {
    if (e.button !== 0 || !track) return;
    const grab = grabAt(e.clientX, e.clientY);
    if (grab) return dragGrab(e, grab);
    const sc = scroll.current!;
    const secAt = (cx: number) => Math.max(0, (cx - sc.getBoundingClientRect().left + sc.scrollLeft) / pps);
    const sec = secAt(e.clientX);
    const inRuler = e.clientY - sc.getBoundingClientRect().top < RULER_H;
    const hit = trackRegions.find((r) => sec >= r.start * spb && sec <= r.start * spb + (r.duration ?? 0));
    if (hit) st.set({ audioEditId: hit.id, selectedRegionId: hit.id, selectedTrackId: hit.trackId });
    fitted.current = hit?.id ?? fitted.current; // não reenquadra ao clicar em outra região
    st.set({ audioSel: null });
    engine.seek(sec / spb);
    const x0 = e.clientX;
    let selecting = false;
    const move = (ev: PointerEvent) => {
      if (inRuler) return engine.seek(secAt(ev.clientX) / spb);
      if (!selecting && Math.abs(ev.clientX - x0) < 4) return; // tremida do clique não vira seleção
      selecting = true;
      const s2 = secAt(ev.clientX);
      st.set({ audioSel: { trackId: track.id, start: Math.min(sec, s2) / spb, end: Math.max(sec, s2) / spb } });
    };
    window.addEventListener('pointermove', move);
    window.addEventListener(
      'pointerup',
      () => {
        window.removeEventListener('pointermove', move);
        // o cursor vai para o início do trecho selecionado (Espaço toca a partir dali)
        const sel = useStore.getState().audioSel;
        if (selecting && sel) engine.seek(sel.start);
      },
      { once: true },
    );
  };

  // cursor do mouse indica o que dá para arrastar
  const hover = (e: React.PointerEvent) => {
    if (e.buttons) return;
    const g = grabAt(e.clientX, e.clientY);
    e.currentTarget.setAttribute('style', g ? 'cursor: ew-resize' : '');
  };

  if (!region || !track) {
    return <div className="empty">Clique numa região de áudio na timeline para editá-la aqui com zoom.</div>;
  }

  /** Região da trilha sob o cursor (de preferência a selecionada). */
  const underCursor = (): { r: Region; cut: number } | null => {
    const beat = engine.getBeat();
    const p = useStore.getState().project;
    const sel = useStore.getState().audioEditId;
    const cands = p.regions
      .filter((r) => r.trackId === track.id && r.bufferId && beat > r.start && beat < r.start + ((r.duration ?? 0) * p.bpm) / 60)
      .sort((a, b) => (a.id === sel ? -1 : b.id === sel ? 1 : 0));
    return cands[0] ? { r: cands[0], cut: ((beat - cands[0].start) * 60) / p.bpm } : null;
  };

  const split = () => {
    const u = underCursor();
    if (u) st.splitRegion(u.r.id, engine.getBeat());
  };
  const trimBefore = () => {
    const u = underCursor();
    if (!u) return;
    st.updateRegion(u.r.id, {
      start: engine.getBeat(),
      offset: (u.r.offset ?? 0) + u.cut,
      duration: (u.r.duration ?? 0) - u.cut,
    });
  };
  const trimAfter = () => {
    const u = underCursor();
    if (u) st.updateRegion(u.r.id, { duration: u.cut });
  };

  const hasSel = !!sel && sel.trackId === track.id;
  const deleteSel = () => sel && st.deleteAudioRange(sel.trackId, sel.start, sel.end);

  const visible = size.w / pps;
  return (
    <div className="aed">
      <div className="roll-bar">
        <strong className="roll-name" title={track.name}>{region.name}</strong>
        <div className="aed-group">
          <button title="Cortar a região no cursor (Ctrl+T)" onClick={split}>✂ Cortar</button>
          <button title="Apagar o trecho entre o início da região e o cursor" onClick={trimBefore}>⇤ Apagar antes</button>
          <button title="Apagar o trecho entre o cursor e o fim da região" onClick={trimAfter}>Apagar depois ⇥</button>
          {hasSel ? (
            <button className="toggle on" title="Apagar o trecho selecionado (Delete). Esc cancela a seleção." onClick={deleteSel}>
              🗑 Apagar seleção · {fmtLen((sel.end - sel.start) * spb)}
            </button>
          ) : (
            <button title="Excluir a região selecionada (Delete). Para apagar só um trecho, clique e arraste na forma de onda." onClick={() => st.removeRegion(region.id)}>
              🗑
            </button>
          )}
        </div>
        <div className="aed-group">
          <button title="Menos zoom" onClick={() => zoomTo(pps / 2)}>−</button>
          <button title="Mais zoom (ou use a roda do mouse)" onClick={() => zoomTo(pps * 2)}>＋</button>
          <button title="Enquadrar a região inteira" onClick={fit}>Ajustar</button>
          <small className="aed-info">{visible >= 1 ? `${visible.toFixed(1)} s` : `${(visible * 1000).toFixed(visible < 0.01 ? 2 : 0)} ms`} na tela</small>
        </div>
        <label title="Volume desta região (duplo clique volta a 0 dB)">
          Volume
          <Slider
            className="aed-gain"
            min={-24}
            max={12}
            step={0.5}
            value={Math.round(20 * Math.log10(Math.max(region.gain ?? 1, 1e-4)) * 2) / 2}
            reset={0}
            onChange={(db) => st.updateRegion(region.id, { gain: Math.pow(10, db / 20) }, false)}
          />
          <small className="aed-db">{gainDb(region.gain ?? 1)}</small>
        </label>
        <label>
          Altura
          <select value={vzoom} onChange={(e) => { setVzoom(+e.target.value); e.currentTarget.blur(); }}>
            {[1, 2, 4, 8, 16].map((v) => <option key={v} value={v}>{v}×</option>)}
          </select>
        </label>
        <span className="hint">
          Clique = cursor · Clique e arraste = selecionar (Delete apaga) · Bordas = aparar · Quadrados = fades · Roda = zoom
        </span>
      </div>
      <div className="aed-view">
        <div className="aed-scroll" ref={scroll} onPointerDown={press} onPointerMove={hover}>
          <div style={{ width: totalSec * pps, height: '100%' }}>
            <canvas ref={canvas} className="aed-canvas" />
          </div>
        </div>
        <div className="aed-head" ref={head} />
      </div>
    </div>
  );
}
