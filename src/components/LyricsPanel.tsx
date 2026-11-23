import { useRef } from 'react';
import { useStore } from '../store';

/** Seções mais comuns (além dos marcadores da música), inseridas como [Nome] numa linha. */
const SECTIONS = ['Intro', 'Verso', 'Pré-refrão', 'Refrão', 'Ponte', 'Solo', 'Final'];

/** Linha de seção: [Refrão], [Verso 2]… */
const isSection = (line: string) => /^\s*\[[^\]]+\]\s*$/.test(line);

/** Aba Letra: a letra da música, salva no projeto. */
export function LyricsPanel() {
  const lyrics = useStore((s) => s.project.lyrics ?? '');
  const name = useStore((s) => s.project.name);
  const markers = useStore((s) => s.project.markers);
  const area = useRef<HTMLTextAreaElement>(null);
  const lastEdit = useRef(0);

  const st = useStore.getState;
  const save = (text: string) => {
    // cada trecho de digitação (separado por uma pausa) vira um passo de desfazer, não cada letra
    const now = performance.now();
    if (now - lastEdit.current > 1500) st().snapshot();
    lastEdit.current = now;
    st().update((p) => ({ ...p, lyrics: text }), false);
  };

  const insertSection = (label: string) => {
    const el = area.current;
    const text = lyrics;
    const at = el ? el.selectionStart : text.length;
    const before = text.slice(0, at);
    const after = text.slice(at);
    // a seção fica sozinha na linha, com uma linha em branco antes (se já houver texto)
    const pre = !before ? '' : before.endsWith('\n\n') ? '' : before.endsWith('\n') ? '\n' : '\n\n';
    const tag = `${pre}[${label}]\n`;
    const post = after && !after.startsWith('\n') ? '\n' : '';
    lastEdit.current = 0;
    save(before + tag + post + after);
    const caret = before.length + tag.length;
    requestAnimationFrame(() => {
      if (!area.current) return;
      area.current.focus();
      area.current.setSelectionRange(caret, caret);
    });
  };

  const sections = [...new Set([...(markers ?? []).map((m) => m.name), ...SECTIONS])];
  const lines = lyrics.split('\n');
  const words = lyrics.split(/\s+/).filter((w) => w && !/^\[.*\]$/.test(w)).length;

  return (
    <div className="lyrics">
      <div className="roll-bar">
        <label>
          Inserir seção
          <select
            value=""
            onChange={(e) => {
              if (e.target.value) insertSection(e.target.value);
            }}
            title="Coloca o nome da seção entre colchetes na posição do cursor (as seções da música aparecem primeiro)"
          >
            <option value="">Escolha…</option>
            {sections.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </label>
        <span className="hint">
          {lines.filter((l) => l.trim() && !isSection(l)).length} linhas · {words} palavras
        </span>
        <span className="tab-spacer" />
        <button title="Copiar a letra como texto" disabled={!lyrics.trim()} onClick={() => void navigator.clipboard.writeText(lyrics)}>Copiar texto</button>
        <button title="Imprimir (ou salvar em PDF pela janela de impressão)" disabled={!lyrics.trim()} onClick={() => window.print()}>Imprimir</button>
      </div>
      <div className="lyrics-body">
        <textarea
          ref={area}
          className="lyrics-text"
          value={lyrics}
          spellCheck
          placeholder={'Escreva a letra da música aqui.\n\nUse [Verso], [Refrão]… para marcar as seções (ou escolha em "Inserir seção").\nA letra é salva junto com o projeto.'}
          onChange={(e) => save(e.target.value)}
        />
      </div>
      {/* versão para imprimir: seções em destaque */}
      <div className="lyrics-print print-area">
        <h2>{name || 'Música'}</h2>
        {lines.map((l, i) =>
          isSection(l) ? <h3 key={i}>{l.trim().slice(1, -1)}</h3> : <p key={i}>{l || ' '}</p>,
        )}
      </div>
    </div>
  );
}
