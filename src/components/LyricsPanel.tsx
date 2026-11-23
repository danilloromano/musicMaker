import { useEffect, useRef, useState } from 'react';
import { engine } from '../audio/engine';
import { pref, savePref, useStore } from '../store';
import { useRaf } from './ui';

/** Seções mais comuns (além dos marcadores da música), inseridas como [Nome] numa linha. */
const SECTIONS = ['Intro', 'Verso', 'Pré-refrão', 'Refrão', 'Ponte', 'Solo', 'Final'];

/** Linha de seção: [Refrão], [Verso 2]… */
const isSection = (line: string) => /^\s*\[[^\]]+\]\s*$/.test(line);
const sectionName = (line: string) => line.trim().slice(1, -1).trim();
/** Para comparar a seção da letra com o marcador: sem maiúsculas, acentos e espaços nas pontas. */
const norm = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

const W_DEF = 380;
const W_MIN = 260;
const clampW = (w: number) => Math.round(Math.min(Math.max(W_MIN, window.innerWidth * 0.6), Math.max(W_MIN, w)));
const SIZES = [13, 15, 17, 20, 24, 28];

/** Largura do painel, arrastável pela borda esquerda e lembrada entre sessões. */
function usePanelWidth() {
  const [w, setW] = useState(() => clampW(Number(pref('mm.lyricsW')) || W_DEF));
  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    const x0 = e.clientX;
    const w0 = w;
    let last = w0;
    document.body.classList.add('resizing-h');
    const move = (ev: PointerEvent) => {
      last = clampW(w0 + x0 - ev.clientX);
      setW(last);
    };
    const up = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      document.body.classList.remove('resizing-h');
      savePref('mm.lyricsW', String(last));
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  };
  const reset = () => {
    setW(clampW(W_DEF));
    savePref('mm.lyricsW', String(W_DEF));
  };
  return { w, onPointerDown, reset };
}

/**
 * Painel lateral da letra, ao lado da timeline: para ler (letra grande, seção atual em destaque e
 * acompanhando a música pelos marcadores) e para escrever. A letra é salva no projeto.
 */
export function LyricsSide() {
  const lyrics = useStore((s) => s.project.lyrics ?? '');
  const name = useStore((s) => s.project.name);
  const markers = useStore((s) => s.project.markers);
  const [mode, setMode] = useState<'read' | 'edit'>(() => (lyrics.trim() ? 'read' : 'edit'));
  const [size, setSize] = useState(() => +(pref('mm.lyricsSize') ?? 17) || 17);
  const [follow, setFollow] = useState(() => pref('mm.lyricsFollow') !== '0');
  const panel = usePanelWidth();
  const area = useRef<HTMLTextAreaElement>(null);
  const readRef = useRef<HTMLDivElement>(null);
  const lastEdit = useRef(0);
  const st = useStore.getState;

  // ---------- escrever ----------

  const save = (text: string) => {
    // cada trecho de digitação (separado por uma pausa) vira um passo de desfazer, não cada letra
    const now = performance.now();
    if (now - lastEdit.current > 1500) st().snapshot();
    lastEdit.current = now;
    st().update((p) => ({ ...p, lyrics: text }), false);
  };

  const insertSection = (label: string) => {
    const el = area.current;
    const at = el ? el.selectionStart : lyrics.length;
    const before = lyrics.slice(0, at);
    const after = lyrics.slice(at);
    // a seção fica sozinha na linha, com uma linha em branco antes (se já houver texto)
    const pre = !before ? '' : before.endsWith('\n\n') ? '' : before.endsWith('\n') ? '\n' : '\n\n';
    const tag = `${pre}[${label}]\n`;
    const post = after && !after.startsWith('\n') ? '\n' : '';
    lastEdit.current = 0;
    save(before + tag + post + after);
    const caret = before.length + tag.length;
    requestAnimationFrame(() => {
      area.current?.focus();
      area.current?.setSelectionRange(caret, caret);
    });
  };

  // ---------- ler: a seção que está tocando ----------

  // marcador onde está o cursor da música, e qual repetição dele é (o 2º "Refrão" → o 2º [Refrão] da letra)
  const [current, setCurrent] = useState<{ name: string; nth: number } | null>(null);
  useRaf(() => {
    const ms = markers ?? [];
    const b = engine.getBeat();
    let i = -1;
    for (let k = 0; k < ms.length; k++) if (ms[k].beat <= b + 1e-6) i = k;
    const next = i < 0 ? null : { name: norm(ms[i].name), nth: ms.slice(0, i).filter((m) => norm(m.name) === norm(ms[i].name)).length };
    if (next?.name !== current?.name || next?.nth !== current?.nth) setCurrent(next);
  });

  const lines = lyrics.split('\n');
  // blocos: cada seção com as linhas dela
  const blocks: { title: string | null; lines: string[] }[] = [];
  for (const l of lines) {
    if (isSection(l)) blocks.push({ title: sectionName(l), lines: [] });
    else if (!blocks.length) blocks.push({ title: null, lines: [l] });
    else blocks[blocks.length - 1].lines.push(l);
  }
  for (const b of blocks) while (b.lines.length && !b.lines[b.lines.length - 1].trim()) b.lines.pop();
  let activeBlock = -1;
  if (current) {
    const same = blocks.map((b, i) => (b.title && norm(b.title) === current.name ? i : -1)).filter((i) => i >= 0);
    if (same.length) activeBlock = same[Math.min(current.nth, same.length - 1)];
  }

  // acompanha a música: a seção atual sobe para o topo
  useEffect(() => {
    if (mode !== 'read' || !follow || activeBlock < 0) return;
    readRef.current?.querySelector('.ly-block.on')?.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }, [activeBlock, mode, follow]);

  const setFont = (d: number) => {
    const i = Math.max(0, Math.min(SIZES.length - 1, SIZES.findIndex((s) => s >= size) + d));
    setSize(SIZES[i]);
    savePref('mm.lyricsSize', String(SIZES[i]));
  };

  const sections = [...new Set([...(markers ?? []).map((m) => m.name), ...SECTIONS])];
  const words = lyrics.split(/\s+/).filter((w) => w && !/^\[.*\]$/.test(w)).length;
  const close = () => {
    savePref('mm.lyricsOpen', '0');
    st().set({ lyricsOpen: false });
  };

  return (
    <aside className="lyrics-side" style={{ width: panel.w }}>
      <div className="lyrics-resize" title="Arraste para mudar a largura (duplo clique: largura padrão)" onPointerDown={panel.onPointerDown} onDoubleClick={panel.reset} />
      <header className="ly-head">
        <b>Letra</b>
        <div className="seg">
          <button className={mode === 'read' ? 'on' : ''} title="Ler: letra grande, acompanhando a música" onClick={() => setMode('read')}>Ler</button>
          <button className={mode === 'edit' ? 'on' : ''} title="Escrever e editar a letra" onClick={() => setMode('edit')}>Editar</button>
        </div>
        <span className="tab-spacer" />
        <button title="Fechar a letra" onClick={close}>✕</button>
      </header>
      <div className="ly-tools">
        {mode === 'read' ? (
          <>
            <div className="seg">
              <button title="Letra menor" disabled={size <= SIZES[0]} onClick={() => setFont(-1)}>A−</button>
              <button title="Letra maior" disabled={size >= SIZES[SIZES.length - 1]} onClick={() => setFont(1)}>A+</button>
            </div>
            <button
              className={follow ? 'on' : ''}
              title="Acompanhar a música: a seção que está tocando (pelos marcadores da timeline com o mesmo nome) fica em destaque e sobe para o topo"
              onClick={() => {
                setFollow(!follow);
                savePref('mm.lyricsFollow', follow ? '0' : '1');
              }}
            >
              Acompanhar
            </button>
          </>
        ) : (
          <select
            value=""
            onChange={(e) => {
              if (e.target.value) insertSection(e.target.value);
            }}
            title="Coloca o nome da seção entre colchetes na posição do cursor (as seções da música aparecem primeiro)"
          >
            <option value="">Inserir seção…</option>
            {sections.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        )}
        <span className="tab-spacer" />
        <button title="Copiar a letra como texto" disabled={!lyrics.trim()} onClick={() => void navigator.clipboard.writeText(lyrics)}>Copiar</button>
        <button title="Imprimir (ou salvar em PDF pela janela de impressão)" disabled={!lyrics.trim()} onClick={() => window.print()}>Imprimir</button>
      </div>

      {mode === 'edit' ? (
        <div className="ly-body">
          <textarea
            ref={area}
            className="lyrics-text"
            value={lyrics}
            spellCheck
            autoFocus
            placeholder={'Escreva a letra da música aqui.\n\nUse [Verso], [Refrão]… para marcar as seções (ou "Inserir seção"). Com marcadores de mesmo nome na timeline, a seção que está tocando fica em destaque no modo Ler.\n\nA letra é salva junto com o projeto.'}
            onChange={(e) => save(e.target.value)}
          />
          <div className="ly-foot">{lines.filter((l) => l.trim() && !isSection(l)).length} linhas · {words} palavras</div>
        </div>
      ) : (
        <div className="ly-read" ref={readRef} style={{ fontSize: size }} onDoubleClick={() => setMode('edit')} title="Duplo clique para editar">
          {!lyrics.trim() ? (
            <div className="ly-empty">
              Ainda não há letra.
              <button onClick={() => setMode('edit')}>Escrever a letra</button>
            </div>
          ) : (
            blocks.map((b, i) => (
              <section key={i} className={`ly-block ${i === activeBlock ? 'on' : ''}`}>
                {b.title && <h4>{b.title}</h4>}
                {b.lines.map((l, k) => <p key={k}>{l || ' '}</p>)}
              </section>
            ))
          )}
        </div>
      )}

      {/* versão para imprimir: seções em destaque */}
      <div className="lyrics-print print-area">
        <h2>{name || 'Música'}</h2>
        {lines.map((l, i) => (isSection(l) ? <h3 key={i}>{sectionName(l)}</h3> : <p key={i}>{l || ' '}</p>))}
      </div>
    </aside>
  );
}
