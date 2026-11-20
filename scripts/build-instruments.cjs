// Monta os pacotes de amostras dos instrumentos melódicos gravados:
//  - piano: Splendid Grand Piano (Steinway gravado pela AKAI, domínio público)
//    https://github.com/sfzinstruments/SplendidGrandPiano
//  - baixo: Fashionbass (baixo elétrico de dedo, gravado em linha, Karoryfer Lecords, CC0)
//    https://github.com/sfzinstruments/karoryfer.fashionbass
//  - cordas (seções de violoncelo, viola e violino), órgão de tubos, trompete, trombone, flauta e marimba:
//    VS Chamber Orchestra Community Edition (Versilian Studios, CC0; órgão gravado por Simon Dalzell/Ivy Audio)
//    https://github.com/sgossner/VSCO-2-CE
//  - sax alto: Weresax (Karoryfer Samples, CC0) — https://github.com/sfzinstruments/karoryfer.weresax
//  - guitarra elétrica limpa: Emilyguitar (Epiphone, D. Smolken/Karoryfer, CC0)
//    https://github.com/sfzinstruments/karoryfer.emilyguitar
//  - contrabaixo acústico de dedo (pizzicato): Otto Rubner 1958 (D. Smolken, CC0)
//    https://github.com/sfzinstruments/dsmolken.double-bass
//
// Instrumentos que sustentam (cordas, órgão) ganham um trecho de repetição (loop) com transição suave,
// para a nota durar o quanto a tecla ficar apertada.
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

/**
 * Regiões de um instrumento do VSCO 2 CE (mapa SFZ no branch "SFZ"), agrupadas por intensidade (da
 * mais fraca à mais forte). `volume` do SFZ (dB) vira `gainDb`.
 */
async function vsco(sfz, cache) {
  const src = await text(`https://raw.githubusercontent.com/sgossner/VSCO-2-CE/SFZ/${sfz}.sfz`, cache);
  const dir = src.match(/default_path=(.+)/)[1].trim().replace(/\\/g, '/');
  const byVel = new Map();
  for (const r of parseSfz(src)) {
    if (!r.sample) continue;
    // duas faixas de intensidade, como no VSCO: suave (até 62) e forte (63 em diante)
    const lv = +(r.lovel ?? 0) < 63 ? 0 : 1;
    if (!byVel.has(lv)) byVel.set(lv, []);
    byVel.get(lv).push({
      lo: +r.lokey, hi: +r.hikey, key: +r.pitch_keycenter, gainDb: +(r.volume ?? 0),
      takes: [raw2('sgossner/VSCO-2-CE', dir + r.sample.replace(/\\/g, '/'))],
    });
  }
  return [...byVel.keys()].sort((a, b) => a - b).map((k) => byVel.get(k));
}
const raw2 = (repo, file) => `https://raw.githubusercontent.com/${repo}/master/${file.split('/').map(encodeURIComponent).join('/')}`;

/**
 * Regiões de um mapa SFZ qualquer de um repositório do sfzinstruments, separadas em intensidades pelo nome
 * do arquivo: `match` acha a intensidade (1º grupo) nas gravações que interessam; `layers` diz a ordem (da
 * mais fraca à mais forte). As repetições do mesmo golpe (round robins) viram takes da mesma região.
 */
async function sfzRegions(repo, branch, sfzPath, match, layers, cache) {
  const src = await text(`https://raw.githubusercontent.com/sfzinstruments/${repo}/${branch}/${sfzPath}`, cache);
  const dir = sfzPath.includes('/') ? sfzPath.slice(0, sfzPath.lastIndexOf('/') + 1) : '';
  const out = layers.map(() => new Map());
  for (const r of parseSfz(src)) {
    if (!r.sample) continue;
    const file = r.sample.replace(/\\/g, '/');
    const m = file.match(match);
    if (!m) continue;
    const li = layers.indexOf(m[1]);
    if (li < 0) continue;
    // resolve "../" do caminho relativo ao .sfz
    const parts = (dir + file).split('/');
    const norm = [];
    for (const x of parts) x === '..' ? norm.pop() : norm.push(x);
    const url = `https://raw.githubusercontent.com/sfzinstruments/${repo}/${branch}/${norm.map(encodeURIComponent).join('/')}`;
    const key = +r.pitch_keycenter;
    const zone = out[li].get(key) ?? { lo: +(r.lokey ?? key), hi: +(r.hikey ?? key), key, takes: [] };
    zone.lo = Math.min(zone.lo, +(r.lokey ?? key));
    zone.hi = Math.max(zone.hi, +(r.hikey ?? key));
    if (!zone.takes.includes(url) && zone.takes.length < 2) zone.takes.push(url);
    out[li].set(key, zone);
  }
  return out.map((m) => [...m.values()]).filter((l) => l.length);
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
  strings: {
    cache: 'vsco-2-ce',
    comment: 'Amostras: VS Chamber Orchestra Community Edition, Versilian Studios (CC0 1.0) — https://github.com/sgossner/VSCO-2-CE',
    quality: 4,
    mono: false,
    loop: true,
    keys: targets(36, 96, 3),
    // naipe de cordas: violoncelos nos graves, violas no meio, violinos nos agudos
    async layers() {
      const sections = [['CelloEnsSusVib', 0, 47], ['ViolaEnsSusVib', 48, 59], ['ViolinEnsSusVib', 60, 127]];
      const loaded = await Promise.all(sections.map(([f]) => vsco(f, this.cache)));
      return loaded[0].map((_, li) =>
        loaded.flatMap((layers, si) => {
          const [, lo, hi] = sections[si];
          return layers[li]
            .filter((r) => r.key >= lo - 2 && r.key <= hi + 2)
            .map((r) => ({ ...r, lo: Math.max(r.lo, lo), hi: Math.min(r.hi, hi) }));
        }),
      );
    },
  },
  pipe: {
    cache: 'vsco-2-ce',
    comment: 'Amostras: órgão de tubos do VS Chamber Orchestra Community Edition (Simon Dalzell/Ivy Audio, Versilian Studios, CC0 1.0) — https://github.com/sgossner/VSCO-2-CE',
    quality: 4,
    mono: false,
    loop: true,
    keys: targets(36, 96, 3),
    async layers() {
      return vsco('OrganQuiet', this.cache);
    },
  },
  trumpet: {
    cache: 'vsco-2-ce',
    comment: 'Amostras: trompete do VS Chamber Orchestra Community Edition, Versilian Studios (CC0 1.0) — https://github.com/sgossner/VSCO-2-CE',
    quality: 4,
    mono: false,
    loop: true,
    keys: targets(55, 85, 3),
    async layers() {
      return vsco('TrumpetSus', this.cache);
    },
  },
  trombone: {
    cache: 'vsco-2-ce',
    comment: 'Amostras: trombone do VS Chamber Orchestra Community Edition, Versilian Studios (CC0 1.0) — https://github.com/sgossner/VSCO-2-CE',
    quality: 4,
    mono: false,
    loop: true,
    keys: targets(40, 73, 3),
    async layers() {
      return vsco('TromboneSus', this.cache);
    },
  },
  flute: {
    cache: 'vsco-2-ce',
    comment: 'Amostras: flauta do VS Chamber Orchestra Community Edition, Versilian Studios (CC0 1.0) — https://github.com/sgossner/VSCO-2-CE',
    quality: 4,
    mono: false,
    loop: true,
    keys: targets(60, 96, 3),
    async layers() {
      return vsco('FluteSusVib', this.cache);
    },
  },
  marimba: {
    cache: 'vsco-2-ce',
    comment: 'Amostras: marimba do VS Chamber Orchestra Community Edition, Versilian Studios (CC0 1.0) — https://github.com/sgossner/VSCO-2-CE',
    quality: 4,
    mono: false,
    keys: targets(45, 96, 3),
    maxSec: () => 2.5,
    async layers() {
      return vsco('Marimba', this.cache);
    },
  },
  sax: {
    cache: 'karoryfer-weresax',
    comment: 'Amostras: Weresax (sax alto), Karoryfer Samples (CC0 1.0) — https://github.com/sfzinstruments/karoryfer.weresax',
    quality: 4,
    mono: true,
    loop: true,
    keys: targets(49, 82, 3),
    async layers() {
      const piano = await sfzRegions('karoryfer.weresax', 'master', 'Programs/alto_map_piano_condenser.sfz', /_(p)_rr\d_cnd\.wav$/, ['p'], this.cache);
      const forte = await sfzRegions('karoryfer.weresax', 'master', 'Programs/alto_map_forte_condenser.sfz', /_(f)_rr\d_cnd\.wav$/, ['f'], this.cache);
      return [piano[0], forte[0]];
    },
  },
  guitar: {
    cache: 'karoryfer-emilyguitar',
    comment: 'Amostras: Emilyguitar (guitarra Epiphone, D. Smolken/Karoryfer, CC0 1.0) — https://github.com/sfzinstruments/karoryfer.emilyguitar',
    quality: 4,
    mono: true,
    keys: targets(40, 88, 3),
    maxSec: () => 4,
    async layers() {
      return sfzRegions('karoryfer.emilyguitar', 'master', 'emily_clean.sfz', /^notes\/\w+?_(p|mf|f)_rr\d\.wav$/, ['p', 'mf', 'f'], this.cache);
    },
  },
  dbass: {
    cache: 'dsmolken-double-bass',
    comment: 'Amostras: contrabaixo Otto Rubner 1958 em pizzicato (D. Smolken, CC0 1.0) — https://github.com/sfzinstruments/dsmolken.double-bass',
    quality: 4,
    mono: true,
    keys: targets(28, 58, 3),
    maxSec: () => 3,
    async layers() {
      return sfzRegions('dsmolken.double-bass', 'master', 'd_smolken_rubner_bass_pizz.sfz', /^pizz\/pizz_\w+?_([pmf])[a-d]\.wav$/, ['p', 'm', 'f'], this.cache);
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

/**
 * Prepara uma gravação sustentada para tocar em loop: acha o fim do trecho estável (antes de o arco
 * sair da corda / o som cair), põe o loop logo depois do ataque e funde o fim do trecho com o que vem antes
 * do início (transição de igual potência), para a repetição não ter emenda audível.
 */
function makeLoop(chans, sr) {
  const n = chans[0].length;
  const win = Math.round(0.05 * sr);
  const env = [];
  for (let w = 0; w + win <= n; w += win) {
    let e = 0;
    for (const c of chans) for (let i = w; i < w + win; i++) e += c[i] * c[i];
    env.push(Math.sqrt(e / (win * chans.length)));
  }
  const mid = env.slice(Math.floor(env.length * 0.2), Math.ceil(env.length * 0.7)).sort((a, b) => a - b);
  const ref = mid[Math.floor(mid.length / 2)];
  let endW = env.length - 1;
  while (endW > 0 && env[endW] < 0.6 * ref) endW--;
  // início do trecho estável (fim do ataque); o loop começa logo depois e dura até 2,5 s
  let startW = 0;
  while (startW < endW && env[startW] < 0.6 * ref) startW++;
  const sustainEnd = Math.min(n, endW * win) - Math.round(0.1 * sr);
  let ls = Math.max(Math.round(0.6 * sr), startW * win + Math.round(0.3 * sr));
  const le = Math.min(sustainEnd, ls + Math.round(2.5 * sr));
  if (le - ls < 0.5 * sr) ls = Math.max(Math.round(0.3 * sr), Math.round(le * 0.4));
  const xf = Math.min(Math.round(0.25 * sr), Math.floor((le - ls) / 3));
  for (const c of chans) {
    for (let i = 0; i < xf; i++) {
      const w = (i / xf) * (Math.PI / 2);
      c[le - xf + i] = c[le - xf + i] * Math.cos(w) + c[ls - xf + i] * Math.sin(w);
    }
  }
  let peak = 0;
  const out = chans.map((c) => c.slice(0, le));
  for (const c of out) for (const x of c) peak = Math.max(peak, Math.abs(x));
  return { chans: out, peak, loop: [+(ls / sr).toFixed(5), +(le / sr).toFixed(5)] };
}

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
          const g = 10 ** ((r.gainDb ?? 0) / 20);
          for (const c of src) for (let i = 0; i < c.length; i++) c[i] *= g;
          const cut = inst.loop
            ? makeLoop(trim(src, sampleRate, { floorDb: -90, fadeSec: 0.001 }).chans, sampleRate)
            : trim(src, sampleRate, { maxSec: inst.maxSec(r.key), fadeSec: 0.15 });
          decoded.set(url, { sr: sampleRate, key: r.key, ...cut });
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
  const index = new Map(); // url → [início, tamanho, nota gravada, (início e fim do loop, em s)]
  let offset = 0;
  for (const [url, d] of decoded) {
    for (const c of d.chans) for (let i = 0; i < c.length; i++) c[i] *= 0.95 / top;
    const ogg = await encodeOgg(d.chans, d.sr, inst.quality);
    index.set(url, [offset, ogg.length, d.key, ...(d.loop ?? [])]);
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
