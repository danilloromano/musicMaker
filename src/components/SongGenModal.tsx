import { useEffect, useState } from 'react';
import { engine } from '../audio/engine';
import { STYLES, STYLE_GROUPS } from '../audio/loops';
import { SONG_FORMS, generateSong, styleBpm, styleKey } from '../audio/songGen';
import { pref, savePref, useStore } from '../store';
import { KEY_LETTERS, KEY_NAMES_PT, keyLabel } from '../types';

/**
 * Gerar música: escolhe estilo, estrutura, tom e andamento, e monta o esboço inteiro (seções com
 * marcadores, trilha de acordes, bateria, baixo, acordes e melodia). "Outra versão" sorteia outras
 * progressões. O projeto atual é substituído (Ctrl+Z desfaz).
 */
export function SongGenModal({ onClose }: { onClose: () => void }) {
  const [styleId, setStyleId] = useState(() => pref('mm.genStyle') ?? 'pop');
  const [formId, setFormId] = useState(() => pref('mm.genForm') ?? 'pop');
  const style = STYLES.find((s) => s.id === styleId) ?? STYLES[0];
  const [keyId, setKeyId] = useState('orig'); // 'orig' ou "raiz:menor"
  const [bpm, setBpm] = useState(() => styleBpm(styleId));
  const [seed, setSeed] = useState(() => Math.floor(Math.random() * 1e9));
  const [made, setMade] = useState(false);

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

  const orig = styleKey(style);
  const key = keyId === 'orig' ? orig : { root: +keyId.split(':')[0], minor: keyId.endsWith(':1') };
  const form = SONG_FORMS.find((f) => f.id === formId) ?? SONG_FORMS[1];
  const bars = form.sections.reduce((n, [, b]) => n + b, 0);
  const secs = (bars * 4 * 60) / bpm;

  const make = (s: number) => {
    const st = useStore.getState();
    const has = st.project.tracks.length > 0;
    if (has && !made && !confirm('Gerar uma música nova substitui o que está no projeto agora. (Dá para voltar com Ctrl+Z.) Continuar?')) return;
    engine.stop();
    st.update((p) => generateSong(p, { styleId: style.id, formId, key, bpm, seed: s }));
    st.set({ selectedTrackId: useStore.getState().project.tracks[0]?.id ?? null, selectedRegionId: null, editingRegionId: null });
    engine.seek(0);
    savePref('mm.genStyle', style.id);
    savePref('mm.genForm', formId);
    setMade(true);
  };

  return (
    <div className="modal-back" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal gen-modal" role="dialog" aria-label="Gerar música">
        <div className="modal-head">
          <h3>Gerar música</h3>
          <button className="modal-x" title="Fechar (Esc)" onClick={onClose}>✕</button>
        </div>
        <p className="hint gen-hint">
          Monta o esboço de uma música inteira: seções com marcadores, acordes e a banda do estilo (bateria, baixo,
          acordes e melodia). Depois é só editar, trocar loops, gravar por cima.
        </p>
        <label>
          Estilo
          <select
            value={style.id}
            onChange={(e) => {
              setStyleId(e.target.value);
              setBpm(styleBpm(e.target.value));
              setKeyId('orig');
            }}
          >
            {STYLE_GROUPS.map((g) => (
              <optgroup key={g} label={g}>
                {STYLES.filter((s) => s.group === g).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </optgroup>
            ))}
          </select>
        </label>
        <label>
          Estrutura
          <select value={formId} onChange={(e) => setFormId(e.target.value)}>
            {SONG_FORMS.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
          </select>
        </label>
        <div className="gen-form">{form.sections.map(([n, b], i) => <span key={i}>{n} <small>{b}</small></span>)}</div>
        <div className="gen-row">
          <label>
            Tom
            <select value={keyId} onChange={(e) => setKeyId(e.target.value)}>
              <option value="orig">Do estilo ({keyLabel(orig)})</option>
              {[false, true].map((minor) => (
                <optgroup key={String(minor)} label={minor ? 'Menores' : 'Maiores'}>
                  {KEY_LETTERS.map((l, r) => (
                    <option key={r} value={`${r}:${minor ? 1 : 0}`}>
                      {l}{minor ? 'm' : ''} · {KEY_NAMES_PT[r]} {minor ? 'menor' : 'maior'}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
          </label>
          <label>
            BPM
            <input type="number" min={40} max={240} value={bpm} onChange={(e) => setBpm(Math.max(40, Math.min(240, Math.round(+e.target.value) || bpm)))} />
          </label>
        </div>
        <small className="hint">
          {bars} compassos · cerca de {Math.floor(secs / 60)}:{String(Math.round(secs % 60)).padStart(2, '0')}
        </small>
        <div className="gen-actions">
          <button className="primary" onClick={() => make(seed)}>✨ Gerar</button>
          <button
            disabled={!made}
            title="Mesmo estilo e estrutura, outras progressões de acordes"
            onClick={() => {
              const s = seed + 1;
              setSeed(s);
              make(s);
            }}
          >
            🎲 Outra versão
          </button>
          {made && (
            <button
              onClick={() => {
                engine.seek(0);
                engine.play();
                onClose();
              }}
            >
              ▶ Ouvir
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
