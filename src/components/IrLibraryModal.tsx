import { useEffect, useRef, useState } from 'react';
import { engine } from '../audio/engine';
import { adoptIr, deleteIr, renameIr, useIrLibrary } from '../audio/irLibrary';
import { useStore } from '../store';

/**
 * Biblioteca de IRs: os arquivos de caixa/microfone guardados no aplicativo. Cada um pode ir para a caixa A
 * ou B do rack da trilha; dá para carregar vários de uma vez, renomear e apagar.
 */
export function IrLibraryModal({ trackId, onClose }: { trackId: string; onClose: () => void }) {
  const list = useIrLibrary();
  const amp = useStore((s) => s.project.tracks.find((t) => t.id === trackId)?.amp);
  const file = useRef<HTMLInputElement>(null);
  const [filter, setFilter] = useState('');

  // Esc fecha
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', key, true);
    return () => window.removeEventListener('keydown', key, true);
  }, [onClose]);

  // IRs que a trilha já usava (carregados antes da biblioteca existir) entram na biblioteca
  useEffect(() => {
    for (const [id, name] of [[amp?.irId, amp?.irName], [amp?.irB, amp?.irBName]] as const) {
      const buf = id && engine.buffers.get(id);
      if (id && buf) void adoptIr(id, name ?? 'IR', buf);
    }
  }, [amp?.irId, amp?.irB, amp?.irName, amp?.irBName]);

  const shown = list.filter((e) => e.name.toLowerCase().includes(filter.trim().toLowerCase()));
  const usedA = amp?.cab === 'user' ? amp.irId : undefined;
  const usedB = amp?.cabB === 'user' ? amp.irB : undefined;

  return (
    <div className="modal-back" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal ir-modal" role="dialog" aria-label="Biblioteca de IRs">
        <div className="modal-head">
          <h3>Biblioteca de IRs</h3>
          <button className="modal-x" title="Fechar (Esc)" onClick={onClose}>✕</button>
        </div>
        <p className="hint ir-hint">
          Arquivos de impulse response (.wav) de caixa e microfone. Ficam guardados no aplicativo e servem para
          qualquer trilha ou projeto. O volume é igualado automaticamente.
        </p>
        <div className="ir-bar">
          <button className="primary" onClick={() => file.current?.click()}>＋ Carregar arquivos…</button>
          <input className="ir-filter" placeholder="Procurar…" value={filter} onChange={(e) => setFilter(e.target.value)} />
          <input
            ref={file}
            type="file"
            accept="audio/wav,.wav,audio/*"
            multiple
            hidden
            onChange={(e) => {
              const fs = [...(e.target.files ?? [])];
              e.target.value = '';
              if (fs.length) void engine.loadIr(fs);
            }}
          />
        </div>
        <div className="ir-list">
          {!list.length && <div className="empty">Nenhum IR ainda. Carregue arquivos .wav de caixa (dá para escolher vários de uma vez).</div>}
          {shown.map((e) => (
            <div key={e.id} className={`ir-item ${e.id === usedA || e.id === usedB ? 'on' : ''}`}>
              <input
                className="ir-name"
                defaultValue={e.name}
                title="Clique para renomear"
                onBlur={(ev) => {
                  const v = ev.target.value.trim();
                  if (v && v !== e.name) void renameIr(e.id, v);
                  else ev.target.value = e.name;
                }}
                onKeyDown={(ev) => ev.key === 'Enter' && (ev.target as HTMLInputElement).blur()}
              />
              <button className={e.id === usedA ? 'toggle on' : ''} title="Usar na caixa A" onClick={() => void engine.useIr(trackId, e, 'a')}>A</button>
              <button className={e.id === usedB ? 'toggle on' : ''} title="Usar na caixa B (misturada com a A)" onClick={() => void engine.useIr(trackId, e, 'b')}>B</button>
              <button
                className="x"
                title="Tirar da biblioteca (trilhas que já usam continuam com ele)"
                onClick={() => confirm(`Tirar "${e.name}" da biblioteca?`) && void deleteIr(e.id)}
              >
                🗑
              </button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
