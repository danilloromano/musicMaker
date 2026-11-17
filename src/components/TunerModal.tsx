import { useEffect, useRef, useState } from 'react';
import { engine } from '../audio/engine';
import { NOTE_LETTERS, NOTE_NAMES, detectPitch, readNote } from '../audio/tuner';
import { pref, savePref, useStore } from '../store';
import { Meter, useRaf } from './ui';

/** Dentro disso (em cents) a nota conta como afinada: luz verde. */
const IN_TUNE = 3;
/** Por quanto tempo a última nota fica na tela depois que o som acaba (ms). */
const HOLD = 1200;

/**
 * Afinador em janela: lê a entrada de áudio (antes de qualquer efeito) ~20× por segundo e mostra a nota,
 * os cents e as luzes ♭ ● ♯. Pode silenciar a monitoração enquanto está aberto.
 */
export function TunerModal({ onClose }: { onClose: () => void }) {
  const inputOpen = useStore((s) => s.inputOpen);
  const [ref, setRef] = useState(() => Math.min(450, Math.max(430, +(pref('mm.tunerRef') ?? 440) || 440)));
  const [mute, setMute] = useState(() => pref('mm.tunerMute') !== '0');
  const box = useRef<HTMLDivElement>(null);
  const note = useRef<HTMLElement>(null);
  const name = useRef<HTMLElement>(null);
  const cents = useRef<HTMLElement>(null);
  const needle = useRef<HTMLElement>(null);
  const hz = useRef<HTMLElement>(null);
  const st = useRef({ last: 0, buf: null as Float32Array<ArrayBuffer> | null, note: -1, octave: 0, cents: 0, hz: 0, pending: -1, seen: 0 });

  // Esc fecha; a monitoração volta ao normal ao fechar
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
  useEffect(() => {
    engine.muteMonitor(mute);
    return () => engine.muteMonitor(false);
  }, [mute]);

  useRaf(() => {
    const now = performance.now();
    const s = st.current;
    if (now - s.last < 50 || !box.current) return;
    s.last = now;
    const an = engine.tunerInput();
    let f = 0;
    if (an) {
      if (!s.buf || s.buf.length !== an.fftSize) s.buf = new Float32Array(an.fftSize);
      an.getFloatTimeDomainData(s.buf);
      f = detectPitch(s.buf, an.context.sampleRate);
    }
    if (f > 0) {
      const r = readNote(f, ref);
      const id = r.note + r.octave * 12;
      if (id === s.note + s.octave * 12) {
        s.cents = s.cents * 0.55 + r.cents * 0.45; // mesma nota: suaviza o ponteiro
        s.hz = s.hz * 0.55 + f * 0.45;
        s.seen = now;
      } else if (id === s.pending || s.note < 0 || now - s.seen > 300) {
        // troca de nota só com duas leituras seguidas iguais (evita piscar entre vizinhas)
        Object.assign(s, { note: r.note, octave: r.octave, cents: r.cents, hz: f, seen: now, pending: -1 });
      } else s.pending = id;
    }
    const active = s.note >= 0 && now - s.seen < HOLD;
    if (!active) s.note = -1;
    const c = active ? Math.max(-50, Math.min(50, s.cents)) : 0;
    const ok = active && Math.abs(c) <= IN_TUNE;
    box.current.className = `tuner-screen big ${active ? (ok ? 'ok' : c < 0 ? 'flat' : 'sharp') : 'idle'}`;
    note.current!.textContent = active ? NOTE_LETTERS[s.note] : '—';
    name.current!.textContent = active ? `${NOTE_NAMES[s.note]} · oitava ${s.octave}` : an ? 'Toque uma corda solta' : '';
    cents.current!.textContent = active ? `${c > 0 ? '+' : ''}${Math.round(c)} cents` : '';
    hz.current!.textContent = active ? `${s.hz.toFixed(1).replace('.', ',')} Hz` : '';
    needle.current!.style.left = `${50 + c}%`;
  });

  return (
    <div className="modal-back" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal tuner-modal" role="dialog" aria-label="Afinador">
        <div className="modal-head">
          <h3>Afinador</h3>
          <button className="modal-x" title="Fechar (Esc)" onClick={onClose}>✕</button>
        </div>

        <div ref={box} className="tuner-screen big idle">
          <div className="tuner-note"><b ref={note}>—</b></div>
          <small className="tuner-name" ref={name} />
          <div className="tuner-scale">
            {[-50, -25, 0, 25, 50].map((v) => <span key={v} className="tick" style={{ left: `${50 + v}%` }}>{v > 0 ? `+${v}` : v}</span>)}
            <i ref={needle} className="tuner-needle" />
          </div>
          <div className="tuner-lights"><i>♭</i><i>●</i><i>♯</i></div>
          <div className="tuner-read"><span ref={cents} /><span ref={hz} /></div>
        </div>

        {!inputOpen ? (
          <div className="tuner-off">
            <p>A entrada de áudio está desligada. Ligue para afinar o instrumento plugado na placa.</p>
            <button className="primary" onClick={() => void engine.openInput()}>Ligar entrada</button>
          </div>
        ) : (
          <div className="tuner-level">
            <small>Nível de entrada</small>
            <Meter input />
          </div>
        )}

        <div className="tuner-opts">
          <label title="Frequência do Lá central: 440 Hz é o padrão; algumas orquestras e gravações antigas usam outra">
            Lá =
            <button onClick={() => { const v = Math.max(430, ref - 1); setRef(v); savePref('mm.tunerRef', String(v)); }}>−</button>
            <b>{ref} Hz</b>
            <button onClick={() => { const v = Math.min(450, ref + 1); setRef(v); savePref('mm.tunerRef', String(v)); }}>+</button>
          </label>
          <label title="Corta o som da monitoração enquanto o afinador está aberto">
            <input type="checkbox" checked={mute} onChange={(e) => { setMute(e.target.checked); savePref('mm.tunerMute', e.target.checked ? '1' : '0'); }} />
            Silenciar enquanto afina
          </label>
        </div>
      </div>
    </div>
  );
}
