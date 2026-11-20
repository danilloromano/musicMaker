import { useEffect, useRef } from 'react';
import { STEM_NAMES, practice, usePractice } from '../audio/practice';
import { withLoading } from '../loading';
import { useRaf } from './ui';

/** Controle deslizante simples (o Slider do app guarda um passo de desfazer; aqui nada é do projeto). */
function Range({ min, max, step, value, reset, onChange }: { min: number; max: number; step: number; value: number; reset: number; onChange: (v: number) => void }) {
  return <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(+e.target.value)} onDoubleClick={() => onChange(reset)} />;
}

/**
 * Separar instrumentos (sem IA): voz, bateria, baixo e resto, cada um com volume, silenciar e solo — para
 * tirar o baixo e tocar por cima, ouvir só a bateria… — e levar as partes para o projeto como trilhas.
 */
function Separation() {
  const st = usePractice();
  if (st.separated === null) {
    return (
      <div className="sep">
        <button
          onClick={() => void practice.separate().catch(() => alert('Não foi possível separar esta música.'))}
          title="Separa voz, bateria, baixo e o resto com técnicas clássicas de áudio (sem IA): rápido, mas aproximado"
        >
          🎚 Separar instrumentos
        </button>
        <span className="hint">
          Sem IA: separa a bateria pelo jeito percussivo do som, o baixo pelos graves e a voz pelo centro do estéreo. É
          aproximado (sobra um pouco de cada coisa em cada parte), e a voz só se separa em gravações estéreo.
        </span>
      </div>
    );
  }
  if (st.separated !== true) {
    return (
      <div className="sep">
        <span className="hint">Separando… {Math.round(st.separated * 100)}%</span>
        <div className="sep-bar"><i style={{ width: `${st.separated * 100}%` }} /></div>
      </div>
    );
  }
  const solo = (k: keyof typeof st.mix) =>
    practice.setMix({ voz: 0, bateria: 0, baixo: 0, resto: 0, [k]: 1 });
  return (
    <div className="sep">
      <div className="sep-rows">
        {STEM_NAMES.map(([k, name]) => (
          <div key={k} className={`sep-row ${st.mix[k] === 0 ? 'off' : ''}`}>
            <span className="sep-name">{name}</span>
            <Range min={0} max={1} step={0.01} value={st.mix[k]} reset={1} onChange={(v) => practice.setMix({ [k]: v })} />
            <span className="sep-val">{Math.round(st.mix[k] * 100)}%</span>
            <button className={st.mix[k] === 0 ? 'toggle on' : ''} title="Tirar esta parte" onClick={() => practice.setMix({ [k]: st.mix[k] === 0 ? 1 : 0 })}>Sem</button>
            <button title="Ouvir só esta parte" onClick={() => solo(k)}>Só</button>
          </div>
        ))}
      </div>
      <div className="sep-actions">
        <button onClick={() => practice.setMix({ voz: 1, bateria: 1, baixo: 1, resto: 1 })}>Tudo de volta</button>
        <button
          title="Cria uma trilha de áudio no projeto para cada parte (voz, bateria, baixo e resto), a partir do compasso 1"
          onClick={() => {
            const n = practice.sendToProject();
            if (n) alert(`${n} trilhas de áudio criadas no projeto.`);
          }}
        >
          Levar para o projeto
        </button>
      </div>
    </div>
  );
}

const fmt = (s: number) => `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, '0')}`;
const SPEEDS = [0.5, 0.6, 0.75, 0.85, 1];

/**
 * Tirar música: abre uma gravação para estudar — mais devagar sem mudar o tom, em outro tom sem mudar a
 * velocidade, repetindo um trecho (arraste na forma de onda ou use A e B), com um palpite do acorde que
 * está soando. Não mexe no projeto.
 */
export function PracticePanel() {
  const st = usePractice();
  const file = useRef<HTMLInputElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const head = useRef<HTMLDivElement>(null);
  const clock = useRef<HTMLSpanElement>(null);
  const chord = useRef<HTMLSpanElement>(null);
  const lastChord = useRef(0);

  // forma de onda (redesenha quando muda a música, o trecho ou o tamanho)
  useEffect(() => {
    const cv = canvas.current;
    if (!cv) return;
    const draw = () => {
      const dpr = window.devicePixelRatio || 1;
      const w = (cv.width = Math.round(cv.clientWidth * dpr));
      const h = (cv.height = Math.round(cv.clientHeight * dpr));
      const g = cv.getContext('2d')!;
      g.clearRect(0, 0, w, h);
      if (!st.peaks || !st.duration) return;
      const l = st.loop;
      if (l) {
        g.fillStyle = l.on ? 'rgba(245, 192, 78, 0.22)' : 'rgba(245, 192, 78, 0.1)';
        g.fillRect((l.a / st.duration) * w, 0, ((l.b - l.a) / st.duration) * w, h);
      }
      g.fillStyle = '#7fd4a0';
      const n = st.peaks.length;
      for (let x = 0; x < w; x++) {
        const v = st.peaks[Math.min(n - 1, Math.floor((x / w) * n))];
        const y = v * (h / 2 - 2);
        g.fillRect(x, h / 2 - y, 1, Math.max(1, y * 2));
      }
    };
    draw();
    const ro = new ResizeObserver(draw);
    ro.observe(cv);
    return () => ro.disconnect();
  }, [st.peaks, st.duration, st.loop]);

  useRaf(() => {
    const p = practice.position();
    if (head.current && st.duration) head.current.style.left = `${(p / st.duration) * 100}%`;
    if (clock.current) clock.current.textContent = `${fmt(p)} / ${fmt(st.duration)}`;
    const now = performance.now();
    if (chord.current && now - lastChord.current > 180) {
      lastChord.current = now;
      const c = practice.chordNow();
      if (c) chord.current.textContent = c;
      else if (!st.playing) chord.current.textContent = '—';
    }
  });

  // clicar = ir para o ponto; arrastar = marcar o trecho (e ligar o loop)
  const press = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!st.duration || e.button !== 0) return;
    const r = e.currentTarget.getBoundingClientRect();
    const at = (x: number) => Math.max(0, Math.min(st.duration, ((x - r.left) / r.width) * st.duration));
    const t0 = at(e.clientX);
    const x0 = e.clientX;
    let dragging = false;
    const move = (ev: PointerEvent) => {
      if (!dragging && Math.abs(ev.clientX - x0) < 4) return;
      dragging = true;
      const t1 = at(ev.clientX);
      practice.setLoop({ a: Math.min(t0, t1), b: Math.max(t0, t1), on: true });
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      if (!dragging) practice.seek(t0);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up, { once: true });
  };

  const setA = () => {
    const p = practice.position();
    const b = st.loop && st.loop.b > p + 0.1 ? st.loop.b : Math.min(st.duration, p + 4);
    practice.setLoop({ a: p, b, on: true });
  };
  const setB = () => {
    const p = practice.position();
    const a = st.loop && st.loop.a < p - 0.1 ? st.loop.a : Math.max(0, p - 4);
    practice.setLoop({ a, b: p, on: true });
  };

  const total = st.semis + st.cents / 100;
  return (
    <div className="practice">
      <div className="roll-bar">
        <button className="primary" onClick={() => file.current?.click()}>Abrir música…</button>
        <strong className="practice-name">{st.name ?? 'Nenhuma música aberta'}</strong>
        <span className="hint">Para estudar: não entra no projeto. A Barra de espaço toca/pausa aqui enquanto esta aba está aberta.</span>
        <input
          ref={file}
          type="file"
          accept="audio/*"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = '';
            if (f) void withLoading(`Abrindo "${f.name}"…`, () => practice.load(f)).catch(() => alert(`Não foi possível abrir "${f.name}".`));
          }}
        />
      </div>

      {!st.name ? (
        <div className="empty">Abra uma música (MP3, WAV, OGG…) para tocar mais devagar, mudar o tom e repetir um trecho até tirar.</div>
      ) : (
        <>
          <div className="practice-wave" onPointerDown={press} title="Clique: ir para o ponto · arraste: marcar o trecho para repetir">
            <canvas ref={canvas} />
            <div className="practice-head" ref={head} />
          </div>

          <div className="practice-controls">
            <div className="practice-transport">
              <button title="Voltar 5 segundos" onClick={() => practice.seek(practice.position() - 5)}>⏪ 5 s</button>
              <button className={`primary play ${st.playing ? 'on' : ''}`} onClick={() => practice.toggle()}>{st.playing ? '⏸ Pausar' : '▶ Tocar'}</button>
              <span className="practice-clock" ref={clock} />
              <button title="Início do trecho na posição atual" onClick={setA}>A</button>
              <button title="Fim do trecho na posição atual" onClick={setB}>B</button>
              <button
                className={st.loop?.on ? 'toggle on' : 'toggle'}
                disabled={!st.loop}
                title="Repetir o trecho marcado"
                onClick={() => st.loop && practice.setLoop({ ...st.loop, on: !st.loop.on })}
              >
                🔁 {st.loop ? `${fmt(st.loop.a)}–${fmt(st.loop.b)}` : 'Trecho'}
              </button>
              {st.loop && <button title="Apagar o trecho" onClick={() => practice.setLoop(null)}>✕</button>}
            </div>

            <div className="practice-knobs">
              <label title="Velocidade sem mudar o tom">
                Velocidade <b>{Math.round(st.speed * 100)}%</b>
                <Range min={0.25} max={1.5} step={0.05} value={st.speed} reset={1} onChange={(v) => void practice.setParams({ speed: Math.round(v * 100) / 100 })} />
                <span className="practice-quick">
                  {SPEEDS.map((v) => (
                    <button key={v} className={Math.abs(st.speed - v) < 0.001 ? 'on' : ''} onClick={() => void practice.setParams({ speed: v })}>{v * 100}%</button>
                  ))}
                </span>
              </label>
              <label title="Muda o tom sem mudar a velocidade (ex.: −1 para tocar junto com a guitarra em afinação normal uma música gravada meio tom abaixo)">
                Tom <b>{total > 0 ? '+' : ''}{st.semis} {Math.abs(st.semis) === 1 ? 'semitom' : 'semitons'}</b>
                <span className="practice-quick">
                  <button onClick={() => void practice.setParams({ semis: Math.max(-12, st.semis - 1) })}>−</button>
                  <button onClick={() => void practice.setParams({ semis: 0, cents: 0 })}>Original</button>
                  <button onClick={() => void practice.setParams({ semis: Math.min(12, st.semis + 1) })}>+</button>
                </span>
              </label>
              <label title="Afinação fina: para gravações um pouco fora do Lá 440">
                Ajuste fino <b>{st.cents > 0 ? '+' : ''}{st.cents} cents</b>
                <Range min={-50} max={50} step={1} value={st.cents} reset={0} onChange={(v) => void practice.setParams({ cents: v })} />
              </label>
              <label>
                Volume
                <Range min={0} max={1} step={0.01} value={st.volume} reset={0.9} onChange={(v) => practice.setVolume(v)} />
              </label>
              <div className="practice-chord" title="Palpite do acorde que está soando (no tom que você está ouvindo)">
                <small>Acorde provável</small>
                <span ref={chord}>—</span>
              </div>
            </div>
            {st.busy && <small className="hint practice-busy">Processando a nova velocidade/tom…</small>}
            <Separation />
          </div>
        </>
      )}
    </div>
  );
}
