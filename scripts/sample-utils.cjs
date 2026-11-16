// Funções comuns aos scripts que montam os pacotes de amostras (build-drums.cjs, build-instruments.cjs):
// download com cache, decodificação de FLAC/WAV, corte de silêncio, codificação e gravação do pacote.

const fs = require('fs');
const os = require('os');
const path = require('path');
const Flac = require('libflacjs/dist/libflac.js');
const { Decoder } = require('libflacjs/lib/decoder');
const { Encoder } = require('libflacjs/lib/encoder');
const { exportFlacData } = require('libflacjs/lib/utils');

const flacReady = new Promise((ok) => (Flac.isReady() ? ok() : (Flac.onready = ok)));

/** Baixa `url` (com até 3 tentativas), guardando em cache na pasta temporária do sistema. */
async function download(url, cacheName) {
  const dir = path.join(os.tmpdir(), cacheName);
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, decodeURIComponent(new URL(url).pathname).replace(/[\\/:*?"<>|]/g, '__'));
  if (fs.existsSync(f)) return new Uint8Array(fs.readFileSync(f));
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(url);
    if (res.ok) {
      const b = new Uint8Array(await res.arrayBuffer());
      fs.writeFileSync(f, b);
      return b;
    }
    if (attempt >= 3) throw new Error(`${res.status} ${url}`);
  }
}

/** Decodifica FLAC ou WAV (detectado pelo cabeçalho) em canais float (-1..1). */
async function decodeAudio(bytes) {
  const tag = String.fromCharCode(...bytes.subarray(0, 4));
  if (tag === 'RIFF') return decodeWav(bytes);
  if (tag !== 'fLaC') throw new Error(`formato desconhecido: ${tag}`);
  await flacReady;
  const d = new Decoder(Flac, {});
  d.decode(bytes);
  const { sampleRate, bitsPerSample, total_samples } = d.metadata;
  const scale = 2 ** (bitsPerSample - 1);
  const chans = d.getSamples(false).map((u8) => {
    // a biblioteca entrega 2 bytes por amostra em 16 bits e 4 bytes acima disso
    const raw = u8.slice().buffer;
    const ints = u8.byteLength / total_samples === 2 ? new Int16Array(raw) : new Int32Array(raw);
    return Float32Array.from(ints, (x) => x / scale);
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
    if (id === 'data') data = { off: p + 8, size: Math.min(size, b.length - p - 8) };
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

/**
 * Corta o fim abaixo de `floorDb` do pico (ou em `maxSec`), com fade de `fadeSec`, e o silêncio antes
 * do ataque (abaixo de -40 dB do pico, deixando 2 ms).
 */
function trim(chans, sr, { maxSec, floorDb = -60, fadeSec = 0.06 } = {}) {
  const n = chans[0].length;
  const at = (i) => Math.max(...chans.map((c) => Math.abs(c[i])));
  let peak = 0;
  for (let i = 0; i < n; i++) peak = Math.max(peak, at(i));
  const thr = peak * 10 ** (floorDb / 20);
  let end = n - 1;
  while (end > 0 && at(end) < thr) end--;
  end = Math.min(n, end + Math.round(fadeSec * sr), maxSec ? Math.round(maxSec * sr) : Infinity);
  let start = 0;
  const on = peak * 10 ** (-40 / 20);
  while (start < end && at(start) < on) start++;
  start = Math.max(0, start - Math.round(0.002 * sr));
  const fade = Math.round(fadeSec * sr);
  const out = chans.map((c) => c.slice(start, end));
  for (const c of out) for (let i = 0; i < fade && i < c.length; i++) c[c.length - 1 - i] *= i / fade;
  return { chans: out, peak };
}

async function encodeFlac(chans, sr) {
  await flacReady;
  const enc = new Encoder(Flac, { sampleRate: sr, channels: chans.length, bitsPerSample: 16, compression: 8 });
  const ints = chans.map((c) => Int32Array.from(c, (x) => Math.max(-32768, Math.min(32767, Math.round(x * 32767)))));
  enc.encode(ints);
  enc.encode();
  const data = await exportFlacData([enc.getSamples()], enc.metadata, false);
  enc.destroy();
  return data;
}

let oggEncoder;
/** Ogg Vorbis (com perda, ~4-5× menor que FLAC); `quality` de 0 a 10. */
async function encodeOgg(chans, sr, quality = 4) {
  oggEncoder ??= await require('wasm-media-encoders').createOggEncoder();
  oggEncoder.configure({ sampleRate: sr, channels: chans.length, vbrQuality: quality });
  const parts = [];
  const step = 65536;
  for (let i = 0; i < chans[0].length; i += step) parts.push(oggEncoder.encode(chans.map((c) => c.subarray(i, i + step))).slice());
  parts.push(oggEncoder.finalize().slice());
  return Buffer.concat(parts);
}

/** Grava o pacote: um módulo JS com o índice (`manifest`) e os arquivos concatenados em base64 (`data`). */
function writePack(out, comments, manifest, blobs) {
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const all = Buffer.concat(blobs.map((b) => Buffer.from(b)));
  const js =
    comments.map((c) => `// ${c}\n`).join('') +
    `export const manifest = ${JSON.stringify(manifest)};\n` +
    `export const data = '${all.toString('base64')}';\n`;
  fs.writeFileSync(out, js);
  console.log(`total ${(all.length / 1e6).toFixed(2)} MB → ${path.relative(process.cwd(), out)} (${(js.length / 1e6).toFixed(2)} MB)`);
}

module.exports = { download, decodeAudio, trim, encodeFlac, encodeOgg, writePack };
