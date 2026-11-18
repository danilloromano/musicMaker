// Arquivos MIDI (.mid, Standard MIDI File): ler e escrever, sem bibliotecas.
//
// Exportar: uma trilha MIDI por trilha de instrumento/bateria, com as notas como tocam (seguindo a trilha
// de acordes e o arpejador), o instrumento (número General MIDI), volume e pan; na primeira trilha, o
// andamento, o compasso, os marcadores de seção e as cifras da trilha de acordes (como texto).
// Importar: formatos 0 e 1; cada canal de cada trilha vira uma trilha do projeto (o canal 10 é bateria —
// as notas de bateria do General MIDI são as mesmas do kit daqui).
import type { Meter, Note, Project } from '../types';
import { chordName } from './chords';

// ---------- instrumentos ↔ General MIDI ----------

/** Instrumento daqui → programa General MIDI (0–127). */
const GM_OF: Record<string, number> = {
  grand: 0, upright: 1, felt: 0, honky: 3, epiano: 4, tine: 4, reed: 5, harpsi: 6, clav: 7, toy: 8, bell: 14, marimba: 12,
  organ: 16, organfast: 17, pipe: 19, guitar: 27, dbass: 32, ebass: 33, bass: 38, strings: 48, pluck: 45,
  trumpet: 56, trombone: 57, sax: 65, flute: 73, lead: 81, pad: 89,
};
export const gmProgramOf = (instrument: string) => GM_OF[instrument] ?? 0;

/** Programa General MIDI → o instrumento daqui mais parecido. */
export function instrumentOfGm(p: number): string {
  if (p <= 2) return p === 1 ? 'upright' : 'grand';
  if (p === 3) return 'honky';
  if (p === 4) return 'epiano';
  if (p === 5) return 'tine';
  if (p === 6) return 'harpsi';
  if (p === 7) return 'clav';
  if (p <= 11) return 'bell';
  if (p <= 13) return 'marimba';
  if (p <= 15) return 'bell';
  if (p <= 18) return p === 17 ? 'organfast' : 'organ';
  if (p <= 20) return 'pipe';
  if (p <= 23) return 'organ';
  if (p <= 31) return 'guitar';
  if (p === 32) return 'dbass';
  if (p <= 37) return 'ebass';
  if (p <= 39) return 'bass';
  if (p <= 44) return 'strings';
  if (p <= 46) return 'pluck';
  if (p <= 51) return 'strings';
  if (p <= 55) return 'pad';
  if (p === 57 || p === 58) return 'trombone';
  if (p <= 63) return 'trumpet';
  if (p <= 67) return 'sax';
  if (p <= 79) return 'flute';
  if (p <= 87) return 'lead';
  if (p <= 103) return 'pad';
  if (p <= 111) return 'pluck';
  if (p <= 119) return 'marimba';
  return 'pad';
}

// ---------- leitura ----------

export interface MidiPart {
  name: string;
  channel: number;
  program: number;
  drums: boolean;
  /** notas em tempos (semínimas) desde o começo do arquivo */
  notes: Omit<Note, 'id'>[];
}

export interface MidiSong {
  bpm?: number;
  meter?: Meter;
  markers: { beat: number; name: string }[];
  parts: MidiPart[];
}

class Reader {
  pos = 0;
  constructor(private d: DataView) {}
  get left() {
    return this.d.byteLength - this.pos;
  }
  u8() {
    return this.d.getUint8(this.pos++);
  }
  u16() {
    const v = this.d.getUint16(this.pos);
    this.pos += 2;
    return v;
  }
  u32() {
    const v = this.d.getUint32(this.pos);
    this.pos += 4;
    return v;
  }
  str(n: number) {
    let s = '';
    for (let i = 0; i < n; i++) s += String.fromCharCode(this.u8());
    return s;
  }
  vlq() {
    let v = 0;
    for (let i = 0; i < 4; i++) {
      const b = this.u8();
      v = (v << 7) | (b & 0x7f);
      if (!(b & 0x80)) break;
    }
    return v;
  }
  bytes(n: number) {
    const out = new Uint8Array(this.d.buffer, this.d.byteOffset + this.pos, n);
    this.pos += n;
    return out;
  }
}

const text = (b: Uint8Array) => {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(b).trim();
  } catch {
    return new TextDecoder('latin1').decode(b).trim();
  }
};

/** Lê um arquivo MIDI. Lança erro se não for um MIDI válido. */
export function parseMidi(buf: ArrayBuffer): MidiSong {
  const r = new Reader(new DataView(buf));
  if (r.left < 14 || r.str(4) !== 'MThd') throw new Error('não é um arquivo MIDI');
  const hlen = r.u32();
  const format = r.u16();
  const ntrks = r.u16();
  const division = r.u16();
  r.pos += hlen - 6;
  const ppq = division & 0x8000 ? 480 : division || 480; // SMPTE: raro; trata como 480 por semínima
  const song: MidiSong = { markers: [], parts: [] };

  for (let t = 0; t < ntrks && r.left >= 8; t++) {
    const id = r.str(4);
    const len = r.u32();
    const end = Math.min(r.pos + len, r.pos + r.left);
    if (id !== 'MTrk') {
      r.pos = end;
      continue;
    }
    let tick = 0;
    let status = 0;
    let trackName = '';
    const program = new Array(16).fill(0);
    const open = new Map<number, { start: number; vel: number }[]>(); // canal*128 + nota → notas abertas
    const notes: Map<number, Omit<Note, 'id'>[]> = new Map(); // por canal
    const close = (ch: number, pitch: number, at: number) => {
      const list = open.get(ch * 128 + pitch);
      const n = list?.shift();
      if (!n) return;
      const arr = notes.get(ch) ?? [];
      arr.push({ pitch, start: n.start / ppq, duration: Math.max(1 / 64, (at - n.start) / ppq), velocity: Math.max(1, Math.min(127, n.vel)) });
      notes.set(ch, arr);
    };
    while (r.pos < end) {
      tick += r.vlq();
      let b = r.u8();
      if (b === 0xff) {
        const type = r.u8();
        const l = r.vlq();
        const data = r.bytes(l);
        if (type === 0x03 && !trackName) trackName = text(data);
        else if (type === 0x51 && l === 3 && song.bpm === undefined) song.bpm = Math.round((60e6 / ((data[0] << 16) | (data[1] << 8) | data[2])) * 100) / 100;
        else if (type === 0x58 && l >= 2 && !song.meter) {
          const den = 2 ** data[1];
          if ((den === 4 || den === 8) && data[0] > 0) song.meter = { num: data[0], den };
        } else if (type === 0x06) song.markers.push({ beat: tick / ppq, name: text(data) || 'Seção' });
        else if (type === 0x2f) break;
        continue;
      }
      if (b === 0xf0 || b === 0xf7) {
        r.pos += r.vlq();
        continue;
      }
      if (b < 0x80) {
        // running status: o byte já é o primeiro dado
        r.pos--;
        b = status;
      } else status = b;
      const kind = b & 0xf0;
      const ch = b & 0x0f;
      if (kind === 0x90 || kind === 0x80) {
        const pitch = r.u8();
        const vel = r.u8();
        if (kind === 0x90 && vel > 0) {
          const k = ch * 128 + pitch;
          if (!open.has(k)) open.set(k, []);
          open.get(k)!.push({ start: tick, vel });
        } else close(ch, pitch, tick);
      } else if (kind === 0xc0) program[ch] = r.u8();
      else if (kind === 0xd0) r.u8();
      else if (kind === 0xa0 || kind === 0xb0 || kind === 0xe0) r.pos += 2;
      else break; // byte inesperado: para nesta trilha
    }
    // notas que nunca terminaram: acabam no fim da trilha
    for (const [k, list] of open) while (list.length) close(Math.floor(k / 128), k % 128, Math.max(tick, list[0].start + ppq / 4));
    r.pos = end;
    for (const [ch, ns] of [...notes].sort((a, b) => a[0] - b[0])) {
      if (!ns.length) continue;
      const drums = ch === 9;
      const many = notes.size > 1;
      song.parts.push({
        name: trackName ? (many ? `${trackName} (canal ${ch + 1})` : trackName) : drums ? 'Bateria' : `MIDI ${song.parts.length + 1}`,
        channel: ch,
        program: program[ch],
        drums,
        notes: ns.sort((a, b) => a.start - b.start),
      });
    }
  }
  if (format === 0 && song.parts.length > 1) for (const p of song.parts) p.name = p.drums ? 'Bateria' : `Canal ${p.channel + 1}`;
  song.markers.sort((a, b) => a.beat - b.beat);
  return song;
}

// ---------- escrita ----------

class Writer {
  private out: number[] = [];
  u8(...b: number[]) {
    this.out.push(...b);
  }
  u16(v: number) {
    this.out.push((v >> 8) & 0xff, v & 0xff);
  }
  u32(v: number) {
    this.out.push((v >>> 24) & 0xff, (v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff);
  }
  vlq(v: number) {
    const bytes = [v & 0x7f];
    while ((v >>= 7)) bytes.unshift((v & 0x7f) | 0x80);
    this.out.push(...bytes);
  }
  str(s: string) {
    for (const c of s) this.out.push(c.charCodeAt(0));
  }
  bytes(b: Uint8Array | number[]) {
    // um a um: push(...b) estoura a pilha com trilhas grandes
    for (let i = 0; i < b.length; i++) this.out.push(b[i]);
  }
  get data() {
    return this.out;
  }
}

/** Evento com tempo absoluto (ticks); \`order\` desempata no mesmo tick (desligar nota antes de ligar). */
type Ev = { tick: number; order: number; data: number[] };
const utf8 = (s: string) => [...new TextEncoder().encode(s)];
const meta = (type: number, data: number[]) => {
  const w = new Writer();
  w.u8(0xff, type);
  w.vlq(data.length);
  w.bytes(data);
  return w.data;
};

function trackChunk(events: Ev[]): number[] {
  events.sort((a, b) => a.tick - b.tick || a.order - b.order);
  const w = new Writer();
  let last = 0;
  for (const e of events) {
    w.vlq(Math.max(0, e.tick - last));
    w.bytes(e.data);
    last = Math.max(last, e.tick);
  }
  w.vlq(0);
  w.bytes(meta(0x2f, []));
  const c = new Writer();
  c.str('MTrk');
  c.u32(w.data.length);
  c.bytes(w.data);
  return c.data;
}

export interface MidiTrackOut {
  name: string;
  drums: boolean;
  instrument: string;
  volume: number; // 0..1
  pan: number; // -1..1
  /** notas em tempos desde o começo da música */
  notes: Omit<Note, 'id'>[];
}

/** Escreve um arquivo MIDI (formato 1, 480 ticks por semínima). */
export function writeMidi(p: Pick<Project, 'name' | 'bpm' | 'meter' | 'markers' | 'chords'>, tracks: MidiTrackOut[]): Uint8Array<ArrayBuffer> {
  const PPQ = 480;
  const tk = (beat: number) => Math.max(0, Math.round(beat * PPQ));
  const chunks: number[][] = [];

  // trilha de andamento: nome, andamento, compasso, marcadores e cifras
  const head: Ev[] = [];
  head.push({ tick: 0, order: 0, data: meta(0x03, utf8(p.name || 'musicMaker')) });
  const us = Math.round(60e6 / p.bpm);
  head.push({ tick: 0, order: 1, data: meta(0x51, [(us >> 16) & 0xff, (us >> 8) & 0xff, us & 0xff]) });
  const m = p.meter ?? { num: 4, den: 4 };
  head.push({ tick: 0, order: 2, data: meta(0x58, [m.num, Math.log2(m.den), m.den === 8 ? 12 : 24, 8]) });
  for (const mk of p.markers ?? []) head.push({ tick: tk(mk.beat), order: 3, data: meta(0x06, utf8(mk.name)) });
  for (const c of p.chords ?? []) head.push({ tick: tk(c.beat), order: 4, data: meta(0x01, utf8(chordName(c))) });
  chunks.push(trackChunk(head));

  // uma trilha por parte; canais 1–16 (o 10 é sempre a bateria)
  let next = 0;
  for (const t of tracks) {
    if (!t.notes.length) continue;
    let ch = 9;
    if (!t.drums) {
      if (next === 9) next++;
      ch = next % 16;
      next = (next + 1) % 16;
    }
    const ev: Ev[] = [{ tick: 0, order: 0, data: meta(0x03, utf8(t.name)) }];
    if (!t.drums) ev.push({ tick: 0, order: 1, data: [0xc0 | ch, gmProgramOf(t.instrument)] });
    ev.push({ tick: 0, order: 2, data: [0xb0 | ch, 7, Math.round(Math.max(0, Math.min(1, t.volume)) * 127)] });
    ev.push({ tick: 0, order: 3, data: [0xb0 | ch, 10, Math.round(((Math.max(-1, Math.min(1, t.pan)) + 1) / 2) * 127)] });
    for (const n of t.notes) {
      const a = tk(n.start);
      const b = Math.max(a + 1, tk(n.start + n.duration));
      const vel = Math.max(1, Math.min(127, Math.round(n.velocity)));
      ev.push({ tick: a, order: 6, data: [0x90 | ch, n.pitch & 0x7f, vel] });
      ev.push({ tick: b, order: 5, data: [0x80 | ch, n.pitch & 0x7f, 0] });
    }
    chunks.push(trackChunk(ev));
  }

  const w = new Writer();
  w.str('MThd');
  w.u32(6);
  w.u16(1);
  w.u16(chunks.length);
  w.u16(PPQ);
  for (const c of chunks) w.bytes(c);
  return new Uint8Array(w.data);
}
