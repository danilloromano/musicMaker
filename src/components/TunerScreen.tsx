import { useRef } from 'react';
import { engine } from '../audio/engine';
import { NOTE_LETTERS, NOTE_NAMES, detectPitch, readNote } from '../audio/tuner';
import { useRaf } from './ui';

/** Dentro disso (em cents) a nota conta como afinada: luz verde. */
const IN_TUNE = 3;
/** Por quanto tempo a última nota fica na tela depois que o som acaba (ms). */
const HOLD = 1200;

/**
 * Tela do pedal afinador: lê o analisador da entrada do rack da trilha ~20× por segundo e atualiza a
 * nota, o ponteiro e as luzes direto no DOM (sem re-renderizar o React a cada leitura).
 */
export function TunerScreen({ trackId, on, refHz }: { trackId: string; on: boolean; refHz: number }) {
  const box = useRef<HTMLDivElement>(null);
  const note = useRef<HTMLElement>(null);
  const name = useRef<HTMLElement>(null);
  const needle = useRef<HTMLElement>(null);
  const hint = useRef<HTMLDivElement>(null);
  const st = useRef({ last: 0, buf: null as Float32Array<ArrayBuffer> | null, note: -1, octave: 0, cents: 0, pending: -1, seen: 0 });

  useRaf(() => {
    const now = performance.now();
    const s = st.current;
    if (now - s.last < 50 || !box.current) return;
    s.last = now;
    const an = on ? engine.mixer?.strips.get(trackId)?.rig?.tuner : undefined;
    let hz = 0;
    if (an) {
      if (!s.buf || s.buf.length !== an.fftSize) s.buf = new Float32Array(an.fftSize);
      an.getFloatTimeDomainData(s.buf);
      hz = detectPitch(s.buf, an.context.sampleRate);
    }
    if (hz > 0) {
      const r = readNote(hz, refHz);
      const id = r.note + r.octave * 12;
      if (id === s.note + s.octave * 12) {
        s.cents = s.cents * 0.55 + r.cents * 0.45; // mesma nota: suaviza o ponteiro
        s.seen = now;
      } else if (id === s.pending || s.note < 0 || now - s.seen > 300) {
        // troca de nota só com duas leituras seguidas iguais (evita piscar entre vizinhas)
        s.note = r.note;
        s.octave = r.octave;
        s.cents = r.cents;
        s.seen = now;
        s.pending = -1;
      } else s.pending = id;
    }
    const active = s.note >= 0 && now - s.seen < HOLD;
    if (!active) s.note = -1;
    const cents = active ? Math.max(-50, Math.min(50, s.cents)) : 0;
    const ok = active && Math.abs(cents) <= IN_TUNE;
    box.current.className = `tuner-screen ${active ? (ok ? 'ok' : cents < 0 ? 'flat' : 'sharp') : 'idle'}`;
    note.current!.textContent = active ? `${NOTE_LETTERS[s.note]}${s.octave}` : on ? '—' : '';
    name.current!.textContent = active ? `${NOTE_NAMES[s.note]} ${cents > 0 ? '+' : ''}${Math.round(cents)}¢` : '';
    needle.current!.style.left = `${50 + cents}%`;
    hint.current!.textContent = !on
      ? 'Pise para afinar'
      : active
        ? ''
        : 'Toque uma corda solta (entrada e 🎧 Monitorar ligados)';
  });

  return (
    <div ref={box} className="tuner-screen idle">
      <div className="tuner-note"><b ref={note} /><small ref={name} /></div>
      <div className="tuner-scale"><i ref={needle} className="tuner-needle" /></div>
      <div className="tuner-lights"><i>♭</i><i>●</i><i>♯</i></div>
      <div ref={hint} className="tuner-hint" />
    </div>
  );
}
