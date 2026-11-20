import { AMPS, CABS } from '../audio/amp';
import { AmpRig } from '../types';
import { AMP_ART, ArtSvg, CAB_ART } from './AmpArt';
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

/** Cabeçote do amplificador: ilustração própria de cada modelo, com o painel de controles por cima. */
export function AmpHead({ rig, power, set }: { rig: AmpRig; power: boolean; set: (p: Partial<AmpRig>, history?: boolean) => void }) {
  const model = AMPS.find((a) => a.id === rig.amp);
  const art = AMP_ART[rig.amp] ?? AMP_ART.none;
  const choose = (dir: 1 | -1) => set({ amp: cycle(AMP_IDS, rig.amp, dir) }, true);
  const lit = power && !!model;
  return (
    <div className="amp-wrap">
      <div className={`amphead m-${model ? rig.amp : 'none'}`} title={model?.desc}>
        <ArtSvg w={art.w} h={art.h} draw={art.draw} lit={lit} />
        {/* o desenho tem 6 px de margem à esquerda e 2 px em cima (viewBox) */}
        <div className="amphead-panel" style={{ left: art.panel.x + 6, top: art.panel.y + 2, width: art.panel.w, height: art.panel.h }}>
          <span className="amphead-model">{model?.name ?? 'Sem amp'}</span>
          {model ? (
            <div className="amphead-knobs">
              {KNOBS.map(([k, label, def]) => (
                <RotaryKnob key={k} label={label} size={32} value={rig.knobs[k]} reset={def} onChange={(v) => set({ knobs: { ...rig.knobs, [k]: v } })} />
              ))}
            </div>
          ) : (
            <div className="amphead-bypass">Sinal direto: só pedais e caixa</div>
          )}
          <div className="amphead-power">
            <i className={`jewel ${lit ? 'on' : ''}`} title={power ? 'Ligado' : 'Rack desligado'} />
            <small>Power</small>
          </div>
        </div>
      </div>
      <Picker label="Amplificador" name={model?.desc ?? 'O sinal passa só pelos pedais e pela caixa'} onPrev={() => choose(-1)} onNext={() => choose(1)} />
    </div>
  );
}

// cortes depois da caixa: botão 0..1 ↔ Hz (nas pontas, desligado)
const LOW_A = 30, LOW_B = 400, HIGH_A = 2000, HIGH_B = 16000;
const lowHz = (v: number) => (v <= 0.01 ? 0 : Math.round(LOW_A * (LOW_B / LOW_A) ** v));
const lowV = (hz?: number) => (hz ? Math.log(hz / LOW_A) / Math.log(LOW_B / LOW_A) : 0);
const highHz = (v: number) => (v >= 0.99 ? 0 : Math.round(HIGH_A * (HIGH_B / HIGH_A) ** v));
const highV = (hz?: number) => (hz ? Math.log(hz / HIGH_A) / Math.log(HIGH_B / HIGH_A) : 1);
const fmtHz = (hz: number) => (hz >= 1000 ? `${(hz / 1000).toFixed(1)}k` : `${hz}`);

/** Gabinete com grade de tecido e falantes; abaixo, as caixas A e B, a biblioteca de IRs, o mix e os cortes. */
export function CabView({
  rig, set, onLibrary, irMissing,
}: { rig: AmpRig; set: (p: Partial<AmpRig>, history?: boolean) => void; onLibrary: () => void; irMissing: boolean }) {
  const ids = [...CABS.map((c) => c.id), ...(rig.irId ? ['user'] : []), 'none'];
  const choose = (dir: 1 | -1) => set({ cab: cycle(ids, rig.cab, dir) }, true);
  const idsB = ['none', ...CABS.map((c) => c.id), ...(rig.irB ? ['user'] : [])];
  const chooseB = (dir: 1 | -1) => {
    const cabB = cycle(idsB, rig.cabB ?? 'none', dir);
    set({ cabB: cabB === 'none' ? undefined : cabB, cabBlend: rig.cabBlend ?? 0.5 }, true);
  };
  const nameB = rig.cabB === 'user' ? `IR: ${rig.irBName}` : CABS.find((c) => c.id === rig.cabB)?.name ?? 'Sem caixa B';
  const spec = CABS.find((c) => c.id === rig.cab);
  const name = rig.cab === 'user' ? `IR: ${rig.irName}` : rig.cab === 'none' ? 'Sem caixa (linha)' : spec?.name ?? rig.cab;
  const art = CAB_ART[rig.cab] ?? CAB_ART.none;
  return (
    <div className="cab-wrap">
      <div className="cabinet" title={name}>
        <ArtSvg w={art.w} h={art.h} draw={art.draw} />
        {rig.cab === 'user' && <span className="cabinet-tag">IR</span>}
      </div>
      <div className="cab-tools">
        <Picker label="Caixa" name={name} onPrev={() => choose(-1)} onNext={() => choose(1)} />
        <button onClick={onLibrary} title="Biblioteca de IRs: carregar arquivos .wav de caixa e microfone e escolher para a caixa A ou B">IRs…</button>
        <div className="cab-mix"><RotaryKnob label="Mix" size={26} value={rig.cabMix} reset={1} onChange={(v) => set({ cabMix: v })} /></div>
      </div>
      <div className="cab-tools">
        <Picker label="Caixa B" name={nameB} onPrev={() => chooseB(-1)} onNext={() => chooseB(1)} />
        {rig.cabB && (
          <div className="cab-mix" title="Mistura entre a caixa A e a B (como dois microfones na mesma caixa)">
            <RotaryKnob label="A / B" size={26} value={rig.cabBlend ?? 0.5} reset={0.5} fmt={(v) => `${Math.round((1 - v) * 100)}/${Math.round(v * 100)}`} onChange={(v) => set({ cabBlend: v })} />
          </div>
        )}
        <div className="cab-mix" title="Corte de graves depois da caixa (tira o embolado)">
          <RotaryKnob label="Graves" size={26} value={lowV(rig.cabLow)} reset={0} fmt={(v) => (lowHz(v) ? `${fmtHz(lowHz(v))} Hz` : 'off')} onChange={(v) => set({ cabLow: lowHz(v) || undefined })} />
        </div>
        <div className="cab-mix" title="Corte de agudos depois da caixa (tira o chiado)">
          <RotaryKnob label="Agudos" size={26} value={highV(rig.cabHigh)} reset={1} fmt={(v) => (highHz(v) ? `${fmtHz(highHz(v))} Hz` : 'off')} onChange={(v) => set({ cabHigh: highHz(v) || undefined })} />
        </div>
      </div>
      {irMissing && <small className="warn">Arquivo do IR não encontrado.</small>}
    </div>
  );
}
