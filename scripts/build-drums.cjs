// Monta o kit de bateria acústica do app a partir do Virtuosity Drums (Versilian Studios, licença CC0):
// https://github.com/sfzinstruments/virtuosity_drums
//
// Para cada peça baixa só as gravações usadas, mistura os microfones como numa produção (microfone de
// perto + overhead + sala), corta o silêncio do fim, normaliza e grava tudo num pacote de FLACs
// (src/audio/drums/kitData.js, em base64), carregado sob demanda pelo app.
//
// Uso: npm run drums      (os downloads ficam em cache na pasta temporária do sistema)

const path = require('path');
const { download, decodeAudio, trim, encodeFlac, writePack } = require('./sample-utils.cjs');

const BASE = 'https://raw.githubusercontent.com/sfzinstruments/virtuosity_drums/master/Samples';
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

async function main() {

  const manifest = {};
  const blobs = [];
  let offset = 0;
  for (const [key, piece] of Object.entries(PIECES)) {
    const mics = Object.keys(piece.mics);
    const takes = [];
    for (const vl of piece.vl) {
      for (const rr of piece.rr) {
        const file = piece.name(vl, rr);
        const decoded = await Promise.all(mics.map(async (m) => decodeAudio(await download(url(piece, m, file), 'virtuosity-drums'))));
        const sr = decoded[0].sampleRate;
        takes.push({ vl, rr, sr, ...trim(mix(decoded, mics.map((m) => piece.mics[m])), sr, { maxSec: piece.tail }) });
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

  writePack(OUT, [
    'Gerado por scripts/build-drums.cjs — não edite à mão.',
    'Amostras: Virtuosity Drums, Versilian Studios (CC0 1.0) — https://github.com/sfzinstruments/virtuosity_drums',
  ], manifest, blobs);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
