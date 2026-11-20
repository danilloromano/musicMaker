// Gera build/icon.ico (ícone do app, do instalador e do atalho: a cara de um ET verde) sem dependências: desenha em RGBA,
// codifica cada tamanho como PNG (zlib do Node) e empacota tudo num .ico.
// Uso: node scripts/make-icon.cjs
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const BG = [0x17, 0x18, 0x1a];
const RIM = [0x2e, 0x30, 0x34];
const SKIN_TOP = [0x8c, 0xff, 0x7a]; // verde do ET, mais claro no alto da cabeça
const SKIN_BOT = [0x1f, 0xb8, 0x3c]; // e mais escuro no queixo
const EYE = [0x0b, 0x0d, 0x10];
const SHINE = [0xe8, 0xff, 0xf0];

/**
 * Cor de um ponto (coordenadas de 0 a 1): fundo arredondado com borda e a cara de um ET verde
 * (cabeça em forma de ovo de ponta para baixo, olhos grandes amendoados e inclinados, boca pequena).
 * Retorna null fora do ícone.
 */
function colorAt(x, y) {
  const radius = 0.22;
  const insideRounded = (x0, y0, x1, y1, r) => {
    if (x < x0 || x > x1 || y < y0 || y > y1) return false;
    const cx = Math.min(Math.max(x, x0 + r), x1 - r), cy = Math.min(Math.max(y, y0 + r), y1 - r);
    return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
  };
  if (!insideRounded(0.02, 0.02, 0.98, 0.98, radius)) return null;
  if (!insideRounded(0.05, 0.05, 0.95, 0.95, radius - 0.03)) return RIM;

  // cabeça: elipse que afina para o queixo
  const cy = 0.46, ry = 0.37, t = (y - cy) / ry;
  if (Math.abs(t) > 1) return BG;
  const halfW = 0.32 * Math.sqrt(1 - t * t) * (t > 0 ? 1 - 0.5 * t : 1);
  if (Math.abs(x - 0.5) > halfW) return BG;

  // olhos: elipses inclinadas, o canto de fora mais alto
  for (const side of [-1, 1]) {
    const ex = 0.5 + side * 0.135, ey = 0.5;
    const ang = side * -0.5; // ~29°
    const dx = x - ex, dy = y - ey;
    const u = dx * Math.cos(ang) + dy * Math.sin(ang), v = -dx * Math.sin(ang) + dy * Math.cos(ang);
    if ((u / 0.12) ** 2 + (v / 0.062) ** 2 <= 1) {
      // brilho no alto do olho
      const sx = ex + side * 0.035, sy = ey - 0.025;
      if ((x - sx) ** 2 + (y - sy) ** 2 <= 0.022 ** 2) return SHINE;
      return EYE;
    }
  }
  // boca
  if (Math.abs(x - 0.5) <= 0.035 && Math.abs(y - 0.7) <= 0.009) return EYE;

  const k = Math.min(1, Math.max(0, (y - 0.09) / 0.74));
  return SKIN_TOP.map((c, i) => c + (SKIN_BOT[i] - c) * k);
}

/**
 * RGBA de cada pixel, com 4x4 subamostras para suavizar as bordas.
 * `pad` = margem em volta (fração do tamanho): os ícones de Mac têm ~10% de respiro em volta do desenho.
 */
function draw(size, pad = 0) {
  const px = new Uint8Array(size * size * 4);
  const ss = 4;
  for (let py = 0; py < size; py++) {
    for (let pxl = 0; pxl < size; pxl++) {
      let r = 0, g = 0, b = 0, hits = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const x = ((pxl + (sx + 0.5) / ss) / size - pad) / (1 - 2 * pad), y = ((py + (sy + 0.5) / ss) / size - pad) / (1 - 2 * pad);
          const c = colorAt(x, y);
          if (!c) continue;
          r += c[0]; g += c[1]; b += c[2]; hits++;
        }
      }
      if (!hits) continue;
      const i = (py * size + pxl) * 4;
      px[i] = Math.round(r / hits); px[i + 1] = Math.round(g / hits); px[i + 2] = Math.round(b / hits);
      px[i + 3] = Math.round((hits / (ss * ss)) * 255);
    }
  }
  return px;
}

function png(size, rgba) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8 bits, RGBA
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // sem filtro
    Buffer.from(rgba.buffer, y * size * 4, size * 4).copy(raw, y * (size * 4 + 1) + 1);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0)),
  ]);
}

const sizes = [16, 24, 32, 48, 64, 128, 256];
const images = sizes.map((s) => png(s, draw(s)));
const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(sizes.length, 4);
let offset = 6 + 16 * sizes.length;
const dir = sizes.map((s, i) => {
  const e = Buffer.alloc(16);
  e[0] = s === 256 ? 0 : s; e[1] = s === 256 ? 0 : s; // 0 = 256
  e.writeUInt16LE(1, 4); e.writeUInt16LE(32, 6);
  e.writeUInt32LE(images[i].length, 8); e.writeUInt32LE(offset, 12);
  offset += images[i].length;
  return e;
});
const out = path.join(__dirname, '..', 'build');
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, 'icon.ico'), Buffer.concat([header, ...dir, ...images]));
fs.writeFileSync(path.join(out, 'icon.png'), images[sizes.length - 1]);
// Mac: 1024 px com a margem do padrão da Apple (o electron-builder converte para .icns)
fs.writeFileSync(path.join(out, 'icon-mac.png'), png(1024, draw(1024, 0.1)));
console.log('build/icon.ico, build/icon.png e build/icon-mac.png gerados');
