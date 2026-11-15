// Gera build/icon.ico (ícone do app, do instalador e do atalho) sem dependências: desenha em RGBA,
// codifica cada tamanho como PNG (zlib do Node) e empacota tudo num .ico.
// Uso: node scripts/make-icon.cjs
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const BG = [0x17, 0x18, 0x1a];
const LIME = [0x00, 0xd4, 0x55]; // verde neon do app
const RIM = [0x2e, 0x30, 0x34];

/**
 * Cobertura (0..1) de cada pixel, com 4x4 subamostras para suavizar as bordas.
 * `pad` = margem em volta (fração do tamanho): os ícones de Mac têm ~10% de respiro em volta do desenho.
 */
function draw(size, pad = 0) {
  const px = new Uint8Array(size * size * 4);
  const ss = 4;
  // tudo em coordenadas de 0 a 1
  const radius = 0.22;
  const insideRounded = (x, y, x0, y0, x1, y1, r) => {
    if (x < x0 || x > x1 || y < y0 || y > y1) return false;
    const cx = Math.min(Math.max(x, x0 + r), x1 - r), cy = Math.min(Math.max(y, y0 + r), y1 - r);
    return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
  };
  // barras de "equalizador": alturas formam uma onda
  const heights = [0.3, 0.55, 0.78, 0.48, 0.66];
  const barW = 0.1, gap = 0.045, total = heights.length * barW + (heights.length - 1) * gap;
  const baseY = 0.78;
  for (let py = 0; py < size; py++) {
    for (let pxl = 0; pxl < size; pxl++) {
      let cBg = 0, cRim = 0, cBar = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const x = ((pxl + (sx + 0.5) / ss) / size - pad) / (1 - 2 * pad), y = ((py + (sy + 0.5) / ss) / size - pad) / (1 - 2 * pad);
          if (!insideRounded(x, y, 0.02, 0.02, 0.98, 0.98, radius)) continue;
          const inner = insideRounded(x, y, 0.05, 0.05, 0.95, 0.95, radius - 0.03);
          if (!inner) { cRim++; continue; }
          let bar = false;
          heights.forEach((h, i) => {
            const x0 = 0.5 - total / 2 + i * (barW + gap);
            if (insideRounded(x, y, x0, baseY - h * 0.62, x0 + barW, baseY, barW / 2)) bar = true;
          });
          if (bar) cBar++;
          else cBg++;
        }
      }
      const n = ss * ss, a = (cBg + cRim + cBar) / n;
      const i = (py * size + pxl) * 4;
      if (a === 0) continue;
      const mix = (k) => (BG[k] * cBg + RIM[k] * cRim + LIME[k] * cBar) / (cBg + cRim + cBar);
      px[i] = mix(0); px[i + 1] = mix(1); px[i + 2] = mix(2); px[i + 3] = Math.round(a * 255);
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
