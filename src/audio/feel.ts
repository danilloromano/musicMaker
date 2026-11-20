// Toque humano: ao tocar (e exportar), as notas ganham as pequenas variações de um músico de verdade —
// tempo um pouco solto, força que muda conforme o lugar no compasso, dedos que não caem exatamente juntos
// num acorde, chimbal com dinâmica de baterista. As notas guardadas não mudam (o Piano Roll continua
// mostrando a grade); a variação de cada nota é sempre a mesma (sorteio com a semente da própria nota),
// então a música soa igual em toda reprodução e na exportação.
import { Note, Track } from '../types';

export const FEEL_LEVELS = [
  { id: 0, name: 'Robótico', desc: 'Exatamente como está escrito: tempo de máquina e força fixa' },
  { id: 1, name: 'Natural', desc: 'Como um músico cuidadoso: variações pequenas de tempo e força, acentos do compasso' },
  { id: 2, name: 'Solto', desc: 'Mais à vontade: tempo mais livre e dinâmica mais marcada' },
] as const;

/** Nível de toque humano da trilha (as trilhas antigas e novas vêm com o natural). */
export const feelOf = (t: Pick<Track, 'feel'>) => t.feel ?? 1;

/** Sorteio determinístico a partir de um texto (a mesma nota sempre varia igual). */
function seeded(text: string) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
  return () => {
    h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
    h = Math.imul(h ^ (h >>> 12), 0x297a2d39);
    h ^= h >>> 15;
    return (h >>> 0) / 4294967296;
  };
}

/** Normal (média 0, desvio 1) cortada em ±2,5. */
function gauss(rand: () => number) {
  const u = 1 - rand(), v = rand();
  return Math.max(-2.5, Math.min(2.5, Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v)));
}

const near = (x: number, step: number) => Math.abs(x / step - Math.round(x / step)) * step < 0.02;

// peças da bateria (General MIDI)
const KICK = 36, SNARE = 38, CLAP = 39, CRASH = 49;
const TOMS = new Set([45, 48, 50]);
/** peças tocadas "em fila" por uma mão (chimbal, condução, shaker, pandeirola, cabasa, guiro, triângulo) */
const HAND = new Set([42, 44, 46, 51, 53, 54, 69, 70, 73, 74, 80, 81]);

/**
 * As notas com o toque humano do nível `level` (0 = devolve as mesmas). `bpm` converte milissegundos em
 * tempos; `length` é o tamanho da região (nenhuma nota sai dela); `salt` diferencia regiões.
 */
export function applyFeel(notes: Note[], o: { level: number; drums: boolean; bpm: number; length: number; salt: string }): Note[] {
  if (!o.level || !notes.length) return notes;
  const k = o.level === 2 ? 1.8 : 1;
  const msToBeats = o.bpm / 60000;
  // notas que começam juntas (acorde, bumbo + prato) se deslocam juntas: o "atraso da mão" é por grupo
  const groups = new Map<number, number>();
  const groupOf = (start: number) => Math.round(start * 48);

  return notes.map((n) => {
    const rand = seeded(o.salt + n.id);
    const g = groupOf(n.start);
    if (!groups.has(g)) {
      const gr = seeded(o.salt + 'g' + g);
      groups.set(g, gauss(gr));
    }
    const pos = ((n.start % 4) + 4) % 4;
    const onBar = near(pos, 4), onBeat = near(pos, 1), on8 = near(pos, 0.5), on16 = near(pos, 0.25);
    let ms: number, vel = n.velocity, dur = n.duration;

    if (o.drums) {
      // bateria: o bumbo e a caixa seguram o tempo; pratos e chimbal variam um pouco mais
      const loose = HAND.has(n.pitch) || n.pitch === CRASH ? 1.4 : TOMS.has(n.pitch) || n.pitch >= 60 ? 1.2 : 0.7;
      ms = (groups.get(g)! * 2.5 + gauss(rand) * 2) * loose * k;
      let accent = 0;
      if (HAND.has(n.pitch)) {
        // a mão no chimbal: forte na cabeça do tempo, média no contratempo, fraca nas semicolcheias
        accent = onBar ? 10 : onBeat ? 7 : on8 ? -2 : on16 ? -12 : -6;
      } else if (n.pitch === SNARE || n.pitch === CLAP || n.pitch === 37) {
        accent = n.velocity >= 90 ? (onBeat ? 3 : 0) : -4; // ghost notes mais escondidas
      } else if (n.pitch === KICK) {
        accent = onBar ? 5 : onBeat ? 2 : -3;
      } else if (n.pitch === CRASH) {
        accent = onBar ? 4 : 0;
      }
      vel += accent * (o.level === 2 ? 1.4 : 1) + gauss(rand) * 4 * k;
    } else {
      // instrumentos: o grupo inteiro (acorde) desloca junto e cada dedo cai um pouco depois do outro
      ms = groups.get(g)! * 5 * k + rand() * 3 * k;
      const accent = onBar ? 5 : onBeat ? 2 : on8 ? 0 : on16 ? -4 : -2;
      vel += accent * (o.level === 2 ? 1.4 : 1) + gauss(rand) * 4 * k;
      dur *= 1 + gauss(rand) * 0.04 * k;
    }

    const start = Math.max(0, Math.min(o.length - 0.01, n.start + ms * msToBeats));
    return {
      ...n,
      start,
      duration: Math.max(0.02, Math.min(dur, o.length - start)),
      velocity: Math.round(Math.max(1, Math.min(127, vel))),
    };
  });
}
