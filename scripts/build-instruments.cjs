// Monta os pacotes de amostras dos instrumentos melódicos gravados:
//  - piano: Splendid Grand Piano (Steinway gravado pela AKAI, domínio público)
//    https://github.com/sfzinstruments/SplendidGrandPiano
//  - baixo: Fashionbass (baixo elétrico de dedo, gravado em linha, Karoryfer Lecords, CC0)
//    https://github.com/sfzinstruments/karoryfer.fashionbass
//
// Para cada instrumento escolhe uma nota gravada a cada ~3 semitons (o app transpõe para as do meio),
// algumas intensidades, corta o fim, normaliza o conjunto inteiro (mantém o equilíbrio natural entre
// notas e intensidades) e grava em Ogg Vorbis num módulo JS carregado sob demanda pelo app.
//
// Uso: npm run instruments      (os downloads ficam em cache na pasta temporária do sistema)

const path = require('path');
const { download, decodeAudio, trim, encodeOgg, writePack } = require('./sample-utils.cjs');

const OUT_DIR = path.join(__dirname, '..', 'src', 'audio', 'samples');
const raw = (repo, file) => `https://raw.githubusercontent.com/sfzinstruments/${repo}/master/${file.split('/').map(encodeURIComponent).join('/')}`;
const text = async (url, cache) => Buffer.from(await download(url, cache)).toString('utf8').replace(/\r/g, '');

/** Lê as regiões de um mapa SFZ simples (cabeçalhos <group>/<region> com opcodes chave=valor). */
function parseSfz(src) {
  const regions = [];
  let group = {};
  let cur = null;
  for (const tok of src.replace(/\/\/.*$/gm, '').split(/\s+(?=<|\w+=)/)) {
    const t = tok.trim();
    if (!t) continue;
    if (t.startsWith('<group>')) {
      group = {};
      cur = group;
    } else if (t.startsWith('<region>')) {
      cur = { ...group };
      regions.push(cur);
    } else if (cur) {
      const m = t.match(/^(\w+)=(.*)$/);
      if (m) cur[m[1]] = m[2].trim();
    }
  }
  return regions;
}

/** Notas-alvo: uma a cada `step` semitons entre `lo` e `hi`. */
const targets = (lo, hi, step) => Array.from({ length: Math.floor((hi - lo) / step) + 1 }, (_, i) => lo + i * step);

const INSTRUMENTS = {
  piano: {
    cache: 'splendid-grand-piano',
    comment: 'Amostras: Splendid Grand Piano, AKAI (domínio público) — https://github.com/sfzinstruments/SplendidGrandPiano',
    quality: 4,
    mono: false,
    keys: targets(21, 108, 3),
    // duração máxima: graves soam mais tempo que agudos
    maxSec: (key) => Math.min(9, Math.max(2.5, 9 - (key - 21) * 0.085)),
    async layers() {
      const out = [];
      for (const layer of ['PP', 'MF', 'FF']) {
        const regions = parseSfz(await text(raw('SplendidGrandPiano', `Data/${layer}.txt`), this.cache));
        out.push(
          regions.map((r) => ({
            lo: +r.lokey, hi: +r.hikey, key: +r.pitch_keycenter,
            takes: [raw('SplendidGrandPiano', `Samples/${r.sample.replace('$EXT', 'flac')}`)],
          })),
        );
      }
      return out;
    },
  },
  bass: {
    cache: 'karoryfer-fashionbass',
    comment: 'Amostras: Fashionbass, Karoryfer Lecords (CC0 1.0) — https://github.com/sfzinstruments/karoryfer.fashionbass',
    quality: 4,
    mono: true,
    keys: targets(23, 65, 3),
    maxSec: () => 3.5,
    async layers() {
      const regions = parseSfz(await text(raw('karoryfer.fashionbass', 'fashionbass_clean.sfz'), this.cache));
      const zones = new Map();
      for (const r of regions) {
        const m = r.sample?.replace(/\\/g, '/').match(/^notes\/(\w+?)_(pp|p|mf|f|ff)_rr(\d)\.wav$/);
        if (m) zones.set(m[1], { lo: +r.lokey, hi: +r.hikey, key: +r.pitch_keycenter, note: m[1] });
      }
      return ['p', 'mf', 'ff'].map((layer) =>
        [...zones.values()].map((z) => ({
          ...z,
          takes: [1, 2].map((rr) => raw('karoryfer.fashionbass', `notes/${z.note}_${layer}_rr${rr}.wav`)),
        })),
      );
    },
  },
};

async function build(name, inst) {
  const layers = await inst.layers();
  // para cada nota-alvo, em cada intensidade, a região gravada que a cobre (ou a mais próxima)
  const pick = (regions, key) =>
    regions.find((r) => key >= r.lo && key <= r.hi) ??
    regions.reduce((a, b) => (Math.abs(b.key - key) < Math.abs(a.key - key) ? b : a));

  const decoded = new Map(); // url → { chans, sr, key, peak }
  const zones = [];
  for (const key of inst.keys) {
    const zone = { key, layers: [] };
    for (const regions of layers) {
      const r = pick(regions, key);
      const takes = [];
      for (const url of r.takes) {
        if (!decoded.has(url)) {
          const { sampleRate, chans } = await decodeAudio(await download(url, inst.cache));
          const src = inst.mono ? [chans.length > 1 ? chans[0].map((x, i) => (x + chans[1][i]) / 2) : chans[0]] : chans.length > 1 ? chans : [chans[0], chans[0]];
          decoded.set(url, { sr: sampleRate, key: r.key, ...trim(src, sampleRate, { maxSec: inst.maxSec(r.key), fadeSec: 0.15 }) });
        }
        takes.push(url);
      }
      zone.layers.push(takes);
    }
    zones.push(zone);
  }

  // normaliza o conjunto inteiro pela nota mais forte
  const top = Math.max(...[...decoded.values()].map((d) => d.peak));
  const blobs = [];
  const index = new Map(); // url → [início, tamanho, nota gravada]
  let offset = 0;
  for (const [url, d] of decoded) {
    for (const c of d.chans) for (let i = 0; i < c.length; i++) c[i] *= 0.95 / top;
    const ogg = await encodeOgg(d.chans, d.sr, inst.quality);
    index.set(url, [offset, ogg.length, d.key]);
    blobs.push(ogg);
    offset += ogg.length;
  }
  const manifest = zones.map((z) => ({ key: z.key, layers: z.layers.map((takes) => takes.map((u) => index.get(u))) }));
  console.log(`${name}: ${zones.length} notas, ${layers.length} intensidades, ${decoded.size} gravações`);
  writePack(path.join(OUT_DIR, `${name}.js`), ['Gerado por scripts/build-instruments.cjs — não edite à mão.', inst.comment], manifest, blobs);
}

(async () => {
  for (const [name, inst] of Object.entries(INSTRUMENTS)) {
    if (process.argv[2] && process.argv[2] !== name) continue;
    await build(name, inst);
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
