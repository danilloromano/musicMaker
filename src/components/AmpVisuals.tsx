import { AMPS, CABS } from '../audio/amp';
import { AmpRig } from '../types';
import { RotaryKnob } from './RotaryKnob';

/** Ordem de escolha nos seletores (‹ ›), incluindo as opções "sem amp" e "sem caixa". */
const AMP_IDS = [...AMPS.map((a) => a.id), 'none'];

const KNOBS = [
  ['gain', 'Ganho', 0.3],
  ['bass', 'Graves', 0.5],
  ['mid', 'Médios', 0.5],
  ['treble', 'Agudos', 0.5],
  ['presence', 'Presença', 0.5],
  ['master', 'Master', 0.5],
] as const;

function cycle<T>(list: T[], cur: T, dir: 1 | -1): T {
  const i = list.indexOf(cur);
  return list[(i + dir + list.length) % list.length];
}

function Picker({ label, name, onPrev, onNext }: { label: string; name: string; onPrev: () => void; onNext: () => void }) {
  return (
    <div className="picker" aria-label={label}>
      <button title={`${label} anterior`} onClick={onPrev}>‹</button>
      <span>{name}</span>
      <button title={`Próximo ${label.toLowerCase()}`} onClick={onNext}>›</button>
    </div>
  );
}

/** Cabeçote do amplificador: tolex, alça, painel com os botões giratórios e lâmpada piloto. */
export function AmpHead({ rig, power, set }: { rig: AmpRig; power: boolean; set: (p: Partial<AmpRig>, history?: boolean) => void }) {
  const model = AMPS.find((a) => a.id === rig.amp);
  const choose = (dir: 1 | -1) => set({ amp: cycle(AMP_IDS, rig.amp, dir) }, true);
  return (
    <div className="amp-wrap">
      <div className={`amphead m-${rig.amp}`} title={model?.desc}>
        <i className="amphead-handle" />
        <div className="amphead-panel">
          <div className="amphead-brand">
            <span className="amphead-logo">MusicMaker</span>
            <span className="amphead-model">{model?.name ?? 'Sem amp'}</span>
          </div>
          {model ? (
            <div className="amphead-knobs">
              {KNOBS.map(([k, label, def]) => (
                <RotaryKnob key={k} label={label} size={34} value={rig.knobs[k]} reset={def} onChange={(v) => set({ knobs: { ...rig.knobs, [k]: v } })} />
              ))}
            </div>
          ) : (
            <div className="amphead-bypass">Sinal direto: só pedais e caixa</div>
          )}
          <div className="amphead-power">
            <i className={`jewel ${power && model ? 'on' : ''}`} title={power ? 'Ligado' : 'Rack desligado'} />
            <small>Power</small>
          </div>
        </div>
      </div>
      <Picker label="Amplificador" name={model?.desc ?? 'O sinal passa só pelos pedais e pela caixa'} onPrev={() => choose(-1)} onNext={() => choose(1)} />
    </div>
  );
}

/** Falantes de cada caixa: colunas × linhas e diâmetro em px. */
const SPEAKERS: Record<string, { cols: number; rows: number; size: number }> = {
  '1x12': { cols: 1, rows: 1, size: 92 },
  '2x12': { cols: 2, rows: 1, size: 70 },
  '4x12': { cols: 2, rows: 2, size: 50 },
  '1x8': { cols: 1, rows: 1, size: 60 },
  '4x10b': { cols: 2, rows: 2, size: 48 },
  '8x10b': { cols: 2, rows: 4, size: 22 },
  user: { cols: 2, rows: 1, size: 66 },
};

/** Gabinete com grade de tecido e falantes; abaixo, o seletor, o IR do usuário e o mix. */
export function CabView({
  rig, set, onLoadIr, irMissing,
}: { rig: AmpRig; set: (p: Partial<AmpRig>, history?: boolean) => void; onLoadIr: () => void; irMissing: boolean }) {
  const ids = [...CABS.map((c) => c.id), ...(rig.irId ? ['user'] : []), 'none'];
  const choose = (dir: 1 | -1) => set({ cab: cycle(ids, rig.cab, dir) }, true);
  const spec = CABS.find((c) => c.id === rig.cab);
  const name = rig.cab === 'user' ? `IR: ${rig.irName}` : rig.cab === 'none' ? 'Sem caixa (linha)' : spec?.name ?? rig.cab;
  const layout = SPEAKERS[rig.cab];
  return (
    <div className="cab-wrap">
      {layout ? (
        <div className={`cabinet ${rig.cab.endsWith('b') ? 'bass' : ''}`} style={{ ['--cols' as string]: layout.cols, ['--spk' as string]: `${layout.size}px` }}>
          <div className="cabinet-grille">
            {Array.from({ length: layout.cols * layout.rows }, (_, i) => <i key={i} className="speaker" />)}
          </div>
          {rig.cab === 'user' && <span className="cabinet-tag">IR</span>}
        </div>
      ) : (
        <div className="cabinet di"><span>DI</span><small>sem caixa</small></div>
      )}
      <Picker label="Caixa" name={name} onPrev={() => choose(-1)} onNext={() => choose(1)} />
      <div className="cab-tools">
        <button onClick={onLoadIr} title="Carregar um arquivo de impulse response (.wav) de caixa e microfone">Carregar IR…</button>
        <div className="cab-mix"><RotaryKnob label="Mix" size={26} value={rig.cabMix} reset={1} onChange={(v) => set({ cabMix: v })} /></div>
      </div>
      {irMissing && <small className="warn">Arquivo do IR não encontrado.</small>}
    </div>
  );
}
