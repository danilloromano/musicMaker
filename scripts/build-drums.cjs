// Monta o kit de bateria acústica do app a partir do Virtuosity Drums (Versilian Studios, licença CC0):
// https://github.com/sfzinstruments/virtuosity_drums
//
// Para cada peça baixa só as gravações usadas, mistura os microfones como numa produção (microfone de
// perto + overhead + sala), corta o silêncio do fim, normaliza e grava tudo num pacote de FLACs
// (src/audio/drums/kitData.js, em base64), carregado sob demanda pelo app.
//
// Uso: node scripts/build-drums.cjs      (os downloads ficam em cache na pasta temporária do sistema)

const fs = require('fs');
const os = require('os');
const path = require('path');
const Flac = require('libflacjs/dist/libflac.js');
const { Decoder } = require('libflacjs/lib/decoder');
const { Encoder } = require('libflacjs/lib/encoder');
const { exportFlacData } = require('libflacjs/lib/utils');

const BASE = 'https://raw.githubusercontent.com/sfzinstruments/virtuosity_drums/master/Samples';
const CACHE = path.join(os.tmpdir(), 'virtuosity-drums-cache');
const OUT = path.join(__dirname, '..', 'src', 'audio', 'drums', 'kitData.js');

const range = (a, b, step = 1) => Array.from({ length: Math.floor((b - a) / step) + 1 }, (_, i) => a + i * step);
/** `n` camadas espalhadas entre 1 e `total`, da mais fraca à mais forte. */
const spread = (total, n) => Array.from({ length: n }, (_, i) => Math.round(1 + (i * (total - 1)) / (n - 1)));

/**
 * Peças do kit: `files(vl, rr)` monta o nome da gravação, `mics` diz quanto de cada microfone entra na
 * mistura. Camadas (vl) da mais fraca para a mais forte; rr são as repetições do mesmo golpe.
 */
const PIECES = {
  kick: {
    dir: 'kick', name: (vl, rr) => `kick_snon_vl${vl}_rr${rr}`,
    vl: range(1, 4), rr: range(1, 3),
    mics: { kickmic: 1.0, oh: 0.45, room: 0.3 },
  },
  snare: {
    dir: 'snare', name: (vl) => `snare_center_vl${vl}`,
    vl: spread(36, 9), rr: [0],
    mics: { snaremic: 1.0, oh: 0.6, room: 0.35, kickmic: 0.15 },
  },
  hhClosed: {
    dir: 'hh', name: (vl, rr) => `hh_closed_vl${vl}_rr${rr}`,
    vl: range(1, 4), rr: range(1, 3),
    mics: { oh: 1.0, room: 0.25, snaremic: 0.2 },
  },
  hhOpen: {
    dir: 'hh', name: (vl, rr) => `hh_34_vl${vl}_rr${rr}`,
    vl: range(1, 4), rr: range(1, 2),
    mics: { oh: 1.0, room: 0.25, snaremic: 0.2 },
    tail: 1.6,
  },
  crash: {
    dir: 'crash', name: (vl, rr) => `crash_crash_vl${vl}_rr${rr}`,
    vl: range(1, 3), rr: range(1, 2),
    mics: { oh: 1.0, room: 0.35 },
    tail: 3.2,
  },
  lowTom: {
    dir: 'ltom', name: (vl) => `ltom_center_vl${vl}`,
    vl: spread(16, 5), rr: [0],
    mics: { oh: 1.0, room: 0.4, snaremic: 0.3, kickmic: 0.2 },
  },
  highTom: {
    dir: 'htom', name: (vl) => `htom_center_vl${vl}`,
    vl: spread(16, 5), rr: [0],
    mics: { oh: 1.0, room: 0.4, snaremic: 0.35 },
  },
  cowbell: {
    perc: true, dir: 'cowbell', name: (vl, rr) => `Cowbell1_Normal_v${vl}_rr${rr}`,
    vl: range(1, 3), rr: range(1, 2),
    mics: { close: 1.0, room: 0.3 },
  },
};

const PERC_SUFFIX = { close: 'Close', mid: 'Mid', oh: 'Overhead', room: 'Far' };

function url(piece, mic, file) {
  if (piece.perc) return `${BASE}/perc/${mic}/${piece.dir}/${file}_${PERC_SUFFIX[mic]}.wav`;
  return `${BASE}/${mic}/${piece.dir}/${mic}_${file}.flac`;
}

async function download(u) {
  const f = path.join(CACHE, u.slice(BASE.length + 1).replace(/[\\/]/g, '__'));
  if (fs.existsSync(f)) return new Uint8Array(fs.readFileSync(f));
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(u);
    if (res.ok) {
      const b = new Uint8Array(await res.arrayBuffer());
      fs.writeFileSync(f, b);
      return b;
    }
    if (attempt >= 3) throw new Error(`${res.status} ${u}`);
  }
}

/** Decodifica FLAC ou WAV em canais float (-1..1). */
function decode(bytes, isWav) {
  if (isWav) return decodeWav(bytes);
  const d = new Decoder(Flac, {});
  d.decode(bytes);
  const { sampleRate, bitsPerSample } = d.metadata;
  const scale = 2 ** (bitsPerSample - 1);
  const chans = d.getSamples(false).map((u8) => {
    const i32 = new Int32Array(u8.buffer, u8.byteOffset, u8.byteLength / 4);
    return Float32Array.from(i32, (x) => x / scale);
  });
  d.destroy();
  return { sampleRate, chans };
}

function decodeWav(b) {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let p = 12, fmt, data;
  while (p < b.length - 8) {
    const id = String.fromCharCode(...b.subarray(p, p + 4));
    const size = v.getUint32(p + 4, true);
    if (id === 'fmt ') fmt = { ch: v.getUint16(p + 10, true), sr: v.getUint32(p + 12, true), bits: v.getUint16(p + 22, true), tag: v.getUint16(p + 8, true) };
    if (id === 'data') data = { off: p + 8, size };
    p += 8 + size + (size & 1);
  }
  const bytes = fmt.bits / 8;
  const n = Math.floor(data.size / bytes / fmt.ch);
  const chans = Array.from({ length: fmt.ch }, () => new Float32Array(n));
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < fmt.ch; c++) {
      const o = data.off + (i * fmt.ch + c) * bytes;
      let x;
      if (fmt.tag === 3) x = v.getFloat32(o, true);
      else if (fmt.bits === 16) x = v.getInt16(o, true) / 32768;
      else if (fmt.bits === 24) x = ((b[o] | (b[o + 1] << 8) | (b[o + 2] << 16)) << 8 >> 8) / 8388608;
      else x = v.getInt32(o, true) / 2147483648;
      chans[c][i] = x;
    }
  }
  return { sampleRate: fmt.sr, chans };
}

/** Mistura os microfones (mono vai igual para os dois lados) num par estéreo. */
function mix(decoded, weights) {
  const n = Math.max(...decoded.map((d) => d.chans[0].length));
  const L = new Float32Array(n), R = new Float32Array(n);
  decoded.forEach((d, k) => {
    const w = weights[k];
    const l = d.chans[0], r = d.chans[1] ?? d.chans[0];
    for (let i = 0; i < l.length; i++) {
      L[i] += l[i] * w;
      R[i] += r[i] * w;
    }
  });
  return [L, R];
}

/** Corta o fim abaixo de -60 dB do pico (com 60 ms de fade) e o silêncio antes do golpe. */
function trim([L, R], sr, maxSec) {
  let peak = 0;
  for (let i = 0; i < L.length; i++) peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i]));
  const thr = peak * 10 ** (-60 / 20);
  let end = L.length - 1;
  while (end > 0 && Math.abs(L[end]) < thr && Math.abs(R[end]) < thr) end--;
  end = Math.min(L.length, end + Math.round(0.06 * sr), maxSec ? Math.round(maxSec * sr) : Infinity);
  let start = 0;
  const on = peak * 10 ** (-40 / 20);
  while (start < end && Math.abs(L[start]) < on && Math.abs(R[start]) < on) start++;
  start = Math.max(0, start - Math.round(0.002 * sr));
  const fade = Math.round(0.06 * sr);
  const out = [L.slice(start, end), R.slice(start, end)];
  for (const c of out) for (let i = 0; i < fade && i < c.length; i++) c[c.length - 1 - i] *= i / fade;
  return { chans: out, peak };
}

async function encodeFlac(chans, sr) {
  const enc = new Encoder(Flac, { sampleRate: sr, channels: 2, bitsPerSample: 16, compression: 8 });
  const ints = chans.map((c) => Int32Array.from(c, (x) => Math.max(-32768, Math.min(32767, Math.round(x * 32767)))));
  enc.encode(ints);
  enc.encode();
  const data = await exportFlacData([enc.getSamples()], enc.metadata, false);
  enc.destroy();
  return data;
}

async function main() {
  await new Promise((ok) => (Flac.isReady() ? ok() : (Flac.onready = ok)));
  fs.mkdirSync(CACHE, { recursive: true });
  fs.mkdirSync(path.dirname(OUT), { recursive: true });

  const manifest = {};
  const blobs = [];
  let offset = 0;
  for (const [key, piece] of Object.entries(PIECES)) {
    const mics = Object.keys(piece.mics);
    const takes = [];
    for (const vl of piece.vl) {
      for (const rr of piece.rr) {
        const file = piece.name(vl, rr);
        const decoded = await Promise.all(mics.map(async (m) => decode(await download(url(piece, m, file)), piece.perc)));
        const sr = decoded[0].sampleRate;
        takes.push({ vl, rr, sr, ...trim(mix(decoded, mics.map((m) => piece.mics[m])), sr, piece.tail) });
      }
    }
    // normaliza a peça inteira pelo golpe mais forte (mantém a diferença natural entre as camadas)
    const top = Math.max(...takes.map((t) => t.peak));
    const layers = [];
    for (const t of takes) {
      for (const c of t.chans) for (let i = 0; i < c.length; i++) c[i] *= 0.95 / top;
      const flac = await encodeFlac(t.chans, t.sr);
      let layer = layers.find((l) => l.vl === t.vl);
      if (!layer) layers.push((layer = { vl: t.vl, takes: [] }));
      layer.takes.push([offset, flac.length]);
      blobs.push(flac);
      offset += flac.length;
    }
    manifest[key] = layers.map((l) => l.takes);
    console.log(key.padEnd(9), `${takes.length} gravações`, `${(blobs.slice(-takes.length).reduce((a, b) => a + b.length, 0) / 1e6).toFixed(2)} MB`);
  }

  const all = Buffer.concat(blobs.map((b) => Buffer.from(b)));
  const js =
    '// Gerado por scripts/build-drums.cjs — não edite à mão.\n' +
    '// Amostras: Virtuosity Drums, Versilian Studios (CC0 1.0) — https://github.com/sfzinstruments/virtuosity_drums\n' +
    `export const manifest = ${JSON.stringify(manifest)};\n` +
    `export const data = '${all.toString('base64')}';\n`;
  fs.writeFileSync(OUT, js);
  console.log(`total ${(all.length / 1e6).toFixed(2)} MB → ${path.relative(process.cwd(), OUT)} (${(js.length / 1e6).toFixed(2)} MB)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
