// Monta o pacote de peças extras da bateria e de percussão (src/audio/drums/percData.js), todas gravadas:
//  - Virtuosity Drums (Versilian Studios e Karoryfer Samples, CC0): condução (ride), cúpula do ride,
//    aro (cross-stick), chimbal no pedal e a percussão (congas, tumba, bongôs, timbales, agogô, claves,
//    shaker, pandeirola, cabasa, guiro, triângulo, cuíca, woodblock)
//    https://github.com/sfzinstruments/virtuosity_drums
//  - Body Percussion (CC0): palmas de verdade
//    https://github.com/sfzinstruments/body_percussion
//
// Cada peça mistura o microfone de perto com o de sala (como numa produção), corta o silêncio do fim e é
// gravada em Ogg Vorbis (bem menor que o FLAC do kit principal). Camadas da mais fraca para a mais forte;
// dentro de cada camada, as repetições do mesmo golpe (o app sorteia uma a cada batida).
//
// Uso: npm run perc      (os downloads ficam em cache na pasta temporária do sistema)

const path = require('path');
const { download, decodeAudio, trim, encodeOgg, writePack } = require('./sample-utils.cjs');

const VD = 'https://raw.githubusercontent.com/sfzinstruments/virtuosity_drums/master/Samples';
const BODY = 'https://raw.githubusercontent.com/sfzinstruments/body_percussion/main/Samples/body';
const OUT = path.join(__dirname, '..', 'src', 'audio', 'drums', 'percData.js');

const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
/** `n` números espalhados entre 1 e `total`. */
const spread = (total, n) => Array.from({ length: n }, (_, i) => Math.round(1 + (i * (total - 1)) / (n - 1)));

// Endereços: peças do kit (um arquivo por microfone), percussão (sufixo do microfone no nome) e as que só
// têm o microfone de cima (sem sufixo).
const kit = (dir) => (mic, file) => `${VD}/${mic}/${dir}/${mic}_${file}.flac`;
const SUFFIX = { close: 'Close', room: 'Far' };
const perc = (dir) => (mic, file) => `${VD}/perc/${mic}/${dir}/${file}_${SUFFIX[mic]}.wav`;
const ohOnly = (dir) => (_mic, file) => `${VD}/perc/oh/${dir}/${file}.wav`;
const body = () => (_mic, file) => `${BODY}/${file}.wav`;

/** Camadas × repetições a partir de um molde de nome. */
const grid = (vls, rrs, name) => vls.map((vl) => rrs.map((rr) => name(vl, rr)));

const PIECES = {
  // ---- bateria ----
  ride: { url: kit('ride'), mics: { oh: 1.0, room: 0.35 }, tail: 3.0, layers: grid(range(1, 3), range(1, 4), (v, r) => `ride_ride_vl${v}_rr${r}`) },
  rideBell: { url: kit('ride'), mics: { oh: 1.0, room: 0.35 }, tail: 2.5, layers: grid(range(1, 3), range(1, 3), (v, r) => `ride_bell_vl${v}_rr${r}`) },
  sidestick: { url: kit('snare'), mics: { snaremic: 1.0, oh: 0.6, room: 0.3 }, tail: 0.6, layers: spread(16, 6).map((v) => [`snare_crossstick_vl${v}`]) },
  hhPedal: { url: kit('hh'), mics: { oh: 1.0, room: 0.25, snaremic: 0.2 }, tail: 0.5, layers: grid(range(1, 3), range(1, 4), (v, r) => `hh_pedal_vl${v}_rr${r}`) },
  clap: { url: body(), mics: { x: 1 }, tail: 0.7, layers: [range(1, 4).map((r) => `handclap_vl1_rr${r}`), range(1, 4).map((r) => `handclap_vl2_rr${r}`)] },
  // ---- percussão ----
  bongoHi: { url: perc('bongoh'), mics: { close: 1.0, room: 0.3 }, tail: 0.8, layers: grid(range(1, 3), range(1, 4), (v, r) => `BongoH_Hit1_v${v}_rr${r}`) },
  bongoLo: { url: perc('bongol'), mics: { close: 1.0, room: 0.3 }, tail: 0.8, layers: grid(range(1, 3), range(1, 4), (v, r) => `BongoL_Hit1_v${v}_rr${r}`) },
  congaMute: { url: perc('conga'), mics: { close: 1.0, room: 0.3 }, tail: 0.6, layers: ['1_70', '71_127'].map((v) => range(1, 4).map((r) => `Conga_17_HitHM1_${v}_rr${r}`)) },
  congaOpen: { url: perc('conga'), mics: { close: 1.0, room: 0.3 }, tail: 1.2, layers: ['1_50', '51_100', '101_127'].map((v) => range(1, 4).map((r) => `Conga_22_HitN_${v}_rr${r}`)) },
  tumba: { url: perc('tumba'), mics: { close: 1.0, room: 0.3 }, tail: 1.4, layers: ['1_40', '41_70', '71_100', '101_127'].map((v) => range(1, 3).map((r) => `Tumba_24_HitN_${v}_rr${r}`)) },
  timbaleHi: { url: ohOnly('timbales'), mics: { oh: 1 }, tail: 1.2, layers: grid(spread(5, 3), range(1, 3), (v, r) => `timb13_vl${v}_rr${r}`) },
  timbaleLo: { url: ohOnly('timbales'), mics: { oh: 1 }, tail: 1.2, layers: grid(spread(4, 3), range(1, 3), (v, r) => `timb14_vl${v}_rr${r}`) },
  agogoHi: { url: perc('agogo'), mics: { close: 1.0, room: 0.3 }, tail: 1.0, layers: grid(range(1, 3), range(1, 4), (v, r) => `Agogo_High_v${v}_rr${r}`) },
  agogoLo: { url: perc('agogo'), mics: { close: 1.0, room: 0.3 }, tail: 1.0, layers: grid(range(1, 2), range(1, 4), (v, r) => `Agogo_Low_v${v}_rr${r}`) },
  cabasa: { url: perc('cabasa'), mics: { close: 1.0, room: 0.3 }, tail: 0.6, layers: grid(range(1, 2), range(1, 4), (v, r) => `Cabasa1_Rub_v${v}_rr${r}`) },
  shaker: { url: perc('shaker'), mics: { close: 1.0, room: 0.3 }, tail: 0.5, layers: [[...range(1, 4).map((r) => `LShaker_Shake1D_rr${r}`), ...range(1, 4).map((r) => `LShaker_Shake1U_rr${r}`)]] },
  tambourine: { url: perc('tambourine'), mics: { close: 1.0, room: 0.3 }, tail: 0.8, layers: [range(1, 6).map((r) => `Tamb1_Shake_rr${r}`)] },
  guiroShort: { url: perc('guiro'), mics: { close: 1.0, room: 0.3 }, tail: 0.6, layers: [range(1, 4).map((r) => `Guiro_Fast_rr${r}`)] },
  guiroLong: { url: perc('guiro'), mics: { close: 1.0, room: 0.3 }, tail: 1.0, layers: [range(1, 4).map((r) => `Guiro_Med_rr${r}`)] },
  claves: { url: perc('claves'), mics: { close: 1.0, room: 0.3 }, tail: 0.6, layers: grid(range(1, 3), range(1, 4), (v, r) => `Claves1_Hit_v${v}_rr${r}`) },
  woodblockHi: { url: ohOnly('woodblock'), mics: { oh: 1 }, tail: 0.5, layers: grid(spread(6, 3), range(1, 2), (v, r) => `woodblock_hi_vl${v}_rr${r}`) },
  woodblockLo: { url: ohOnly('woodblock'), mics: { oh: 1 }, tail: 0.5, layers: grid(spread(6, 3), range(1, 2), (v, r) => `woodblock_lo_vl${v}_rr${r}`) },
  cuicaHi: { url: ohOnly('cuica'), mics: { oh: 1 }, tail: 0.9, layers: [range(1, 4).map((r) => `Long_p7_Main_vl1_rr${r}`)] },
  cuicaLo: { url: ohOnly('cuica'), mics: { oh: 1 }, tail: 0.9, layers: [range(1, 4).map((r) => `Long_p2_Main_vl1_rr${r}`)] },
  triangleMute: { url: perc('triangle'), mics: { close: 1.0, room: 0.3 }, tail: 0.5, layers: [range(1, 4).map((r) => `Triangle1_HitM_v1_rr${r}`)] },
  triangleOpen: { url: perc('triangle'), mics: { close: 1.0, room: 0.3 }, tail: 2.5, layers: grid(range(1, 2), range(1, 4), (v, r) => `Triangle1_Hit_v${v}_rr${r}`) },
};

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
  const only = process.argv[2];
  const manifest = {};
  const blobs = [];
  let offset = 0;
  for (const [key, piece] of Object.entries(PIECES)) {
    if (only && key !== only) continue;
    const mics = Object.keys(piece.mics);
    const takes = [];
    for (const [li, layer] of piece.layers.entries()) {
      for (const file of layer) {
        const decoded = await Promise.all(mics.map(async (m) => decodeAudio(await download(piece.url(m, file), 'virtuosity-drums'))));
        const sr = decoded[0].sampleRate;
        takes.push({ li, sr, ...trim(mix(decoded, mics.map((m) => piece.mics[m])), sr, { maxSec: piece.tail, fadeSec: 0.03 }) });
      }
    }
    // normaliza a peça inteira pelo golpe mais forte (mantém a diferença natural entre as camadas)
    const top = Math.max(...takes.map((t) => t.peak));
    const layers = piece.layers.map(() => []);
    let bytes = 0;
    for (const t of takes) {
      for (const c of t.chans) for (let i = 0; i < c.length; i++) c[i] *= 0.95 / top;
      const ogg = await encodeOgg(t.chans, t.sr, 5);
      layers[t.li].push([offset, ogg.length]);
      blobs.push(ogg);
      offset += ogg.length;
      bytes += ogg.length;
    }
    manifest[key] = layers;
    console.log(key.padEnd(13), `${takes.length} gravações`, `${(bytes / 1e3).toFixed(0)} kB`);
  }

  writePack(OUT, [
    'Gerado por scripts/build-perc.cjs — não edite à mão.',
    'Amostras: Virtuosity Drums, Versilian Studios e Karoryfer Samples (CC0 1.0) — https://github.com/sfzinstruments/virtuosity_drums',
    'Palmas: Body Percussion (CC0 1.0) — https://github.com/sfzinstruments/body_percussion',
  ], manifest, blobs);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
