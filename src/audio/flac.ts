// Codificador FLAC (sem perda) em TypeScript puro: blocos de 4096 amostras, preditor fixo (ordem 0 a 4,
// a melhor por bloco), estéreo independente / esquerda-lado / meio-lado (o que comprimir mais), resíduo
// em código de Rice com partições. Segue a especificação do formato (RFC 9639).

const BLOCK = 4096;

/** Escreve bits em sequência (mais significativo primeiro). */
class BitWriter {
  buf = new Uint8Array(1 << 16);
  len = 0; // bytes completos
  private acc = 0; // bits pendentes (até 31)
  private n = 0;

  private grow(extra: number) {
    if (this.len + extra <= this.buf.length) return;
    let size = this.buf.length * 2;
    while (size < this.len + extra) size *= 2;
    const b = new Uint8Array(size);
    b.set(this.buf.subarray(0, this.len));
    this.buf = b;
  }

  /** Escreve os `bits` bits menos significativos de `v` (sem sinal; até 32 bits). */
  write(v: number, bits: number) {
    if (bits > 24) {
      this.write(Math.floor(v / 2 ** 24) & ((1 << (bits - 24)) - 1), bits - 24);
      this.write(v & 0xffffff, 24);
      return;
    }
    this.grow(8);
    this.acc = (this.acc << bits) | (v & ((1 << bits) - 1));
    this.n += bits;
    while (this.n >= 8) {
      this.n -= 8;
      this.buf[this.len++] = (this.acc >>> this.n) & 0xff;
    }
    this.acc &= (1 << this.n) - 1;
  }

  writeSigned(v: number, bits: number) {
    this.write(v < 0 ? v + 2 ** bits : v, bits);
  }

  /** q zeros seguidos de um 1 */
  unary(q: number) {
    while (q >= 24) {
      this.write(0, 24);
      q -= 24;
    }
    this.write(1, q + 1);
  }

  align() {
    if (this.n > 0) this.write(0, 8 - this.n);
  }

  bytes() {
    return this.buf.subarray(0, this.len);
  }
}

const CRC8 = (() => {
  const t = new Uint8Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 0x80 ? ((c << 1) ^ 0x07) & 0xff : (c << 1) & 0xff;
    t[i] = c;
  }
  return t;
})();
const CRC16 = (() => {
  const t = new Uint16Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i << 8;
    for (let k = 0; k < 8; k++) c = c & 0x8000 ? ((c << 1) ^ 0x8005) & 0xffff : (c << 1) & 0xffff;
    t[i] = c;
  }
  return t;
})();
const crc8 = (b: Uint8Array, from: number, to: number) => {
  let c = 0;
  for (let i = from; i < to; i++) c = CRC8[c ^ b[i]];
  return c;
};
const crc16 = (b: Uint8Array, from: number, to: number) => {
  let c = 0;
  for (let i = from; i < to; i++) c = ((c << 8) ^ CRC16[(c >> 8) ^ b[i]]) & 0xffff;
  return c;
};

/** Resíduos do preditor fixo de ordem `order` (as primeiras `order` amostras ficam de fora). */
function residuals(x: Int32Array, order: number): Int32Array {
  const n = x.length;
  const r = new Int32Array(Math.max(0, n - order));
  for (let i = order; i < n; i++) {
    let v: number;
    switch (order) {
      case 0: v = x[i]; break;
      case 1: v = x[i] - x[i - 1]; break;
      case 2: v = x[i] - 2 * x[i - 1] + x[i - 2]; break;
      case 3: v = x[i] - 3 * x[i - 1] + 3 * x[i - 2] - x[i - 3]; break;
      default: v = x[i] - 4 * x[i - 1] + 6 * x[i - 2] - 4 * x[i - 3] + x[i - 4];
    }
    r[i - order] = v;
  }
  return r;
}

/** Soma dos resíduos (em módulo) do preditor de ordem `order`: estimativa rápida do custo. */
function residualSum(x: Int32Array, order: number): number {
  let s = 0;
  const n = x.length;
  switch (order) {
    case 0: for (let i = 0; i < n; i++) s += Math.abs(x[i]); break;
    case 1: for (let i = 1; i < n; i++) s += Math.abs(x[i] - x[i - 1]); break;
    case 2: for (let i = 2; i < n; i++) s += Math.abs(x[i] - 2 * x[i - 1] + x[i - 2]); break;
    case 3: for (let i = 3; i < n; i++) s += Math.abs(x[i] - 3 * x[i - 1] + 3 * x[i - 2] - x[i - 3]); break;
    default: for (let i = 4; i < n; i++) s += Math.abs(x[i] - 4 * x[i - 1] + 6 * x[i - 2] - 4 * x[i - 3] + x[i - 4]);
  }
  return s;
}

/** Bits estimados para `cnt` resíduos em zigue-zague que somam `sum`, com o melhor parâmetro de Rice. */
function riceEstimate(sum: number, cnt: number, maxK: number): [number, number] {
  if (cnt <= 0) return [0, 0];
  const est = Math.max(0, Math.min(maxK, Math.floor(Math.log2(Math.max(1, sum / cnt)))));
  let best: [number, number] = [0, Infinity];
  for (let k = Math.max(0, est - 1); k <= Math.min(maxK, est + 1); k++) {
    const bits = cnt * (k + 1) + Math.floor(sum / 2 ** k);
    if (bits < best[1]) best = [k, bits];
  }
  return best;
}

/** Melhor preditor de um canal (pela soma dos resíduos) e o custo estimado em bits. */
function bestOrder(x: Int32Array, bps: number, maxK: number): { order: number; bits: number } {
  let best = { order: 0, bits: Infinity };
  for (let order = 0; order <= Math.min(4, x.length - 1); order++) {
    const sum = residualSum(x, order) * 2; // zigue-zague ≈ dobro do módulo
    const bits = order * bps + riceEstimate(sum, x.length - order, maxK)[1];
    if (bits < best.bits) best = { order, bits };
  }
  return best;
}

interface SubframePlan {
  /** bloco todo com o mesmo valor (ex.: silêncio): subquadro CONSTANT */
  constant?: boolean;
  order: number;
  res: Uint32Array; // resíduos em zigue-zague
  porder: number;
  params: number[];
}

/** Monta o plano de um canal: preditor escolhido, resíduos e a melhor divisão em partições. */
function planSubframe(x: Int32Array, bps: number, rice2: boolean): SubframePlan {
  const n = x.length;
  let same = true;
  for (let i = 1; i < n && same; i++) same = x[i] === x[0];
  if (same) return { constant: true, order: 0, res: new Uint32Array(0), porder: 0, params: [] };
  const maxK = rice2 ? 30 : 14;
  const { order } = bestOrder(x, bps, maxK);
  const r = residuals(x, order);
  const u = new Uint32Array(r.length);
  for (let i = 0; i < r.length; i++) u[i] = r[i] >= 0 ? 2 * r[i] : -2 * r[i] - 1;
  // partições: a ordem máxima que divide o bloco e deixa amostras suficientes na 1ª partição
  let maxP = 0;
  while (maxP < 8 && n % (1 << (maxP + 1)) === 0 && n >> (maxP + 1) > order) maxP++;
  // somas na divisão mais fina; as divisões maiores somam pares
  let sums: number[] = [];
  let counts: number[] = [];
  const fine = 1 << maxP;
  const size = n >> maxP;
  let pos = 0;
  for (let k = 0; k < fine; k++) {
    const cnt = k === 0 ? size - order : size;
    let sum = 0;
    for (let i = pos; i < pos + cnt; i++) sum += u[i];
    sums.push(sum);
    counts.push(cnt);
    pos += cnt;
  }
  let best = { porder: 0, params: [0], bits: Infinity };
  for (let p = maxP; p >= 0; p--) {
    let bits = 0;
    const params: number[] = [];
    for (let k = 0; k < sums.length; k++) {
      const [kk, b] = riceEstimate(sums[k], counts[k], maxK);
      params.push(kk);
      bits += (rice2 ? 5 : 4) + b;
    }
    if (bits < best.bits) best = { porder: p, params, bits };
    if (p > 0) {
      sums = sums.flatMap((v, k) => (k % 2 ? [] : [v + sums[k + 1]]));
      counts = counts.flatMap((v, k) => (k % 2 ? [] : [v + counts[k + 1]]));
    }
  }
  return { order, res: u, porder: best.porder, params: best.params };
}

function writeSubframe(w: BitWriter, x: Int32Array, bps: number, plan: SubframePlan, rice2: boolean) {
  if (plan.constant) {
    w.write(0, 8); // preenchimento + CONSTANT + sem bits desperdiçados
    w.writeSigned(x[0], bps);
    return;
  }
  w.write(0, 1); // preenchimento
  w.write(0b001000 | plan.order, 6); // FIXED, ordem
  w.write(0, 1); // sem bits desperdiçados
  for (let i = 0; i < plan.order; i++) w.writeSigned(x[i], bps);
  w.write(rice2 ? 1 : 0, 2);
  w.write(plan.porder, 4);
  const n = x.length;
  const size = n >> plan.porder;
  let pos = 0;
  plan.params.forEach((k, part) => {
    w.write(k, rice2 ? 5 : 4);
    const cnt = part === 0 ? size - plan.order : size;
    const mask = k ? (2 ** k) - 1 : 0;
    for (let i = pos; i < pos + cnt; i++) {
      const u = plan.res[i];
      w.unary(k < 31 ? Math.floor(u / 2 ** k) : 0);
      if (k) w.write(u & mask, k);
    }
    pos += cnt;
  });
}

/** Número do quadro no formato "UTF-8" do FLAC (1 a 6 bytes). */
function utf8(w: BitWriter, v: number) {
  if (v < 0x80) return w.write(v, 8);
  const n = v < 0x800 ? 2 : v < 0x10000 ? 3 : v < 0x200000 ? 4 : v < 0x4000000 ? 5 : 6;
  const lead = (0xff00 >> n) & 0xff; // n bits 1 seguidos de um 0
  w.write(lead | Math.floor(v / 2 ** (6 * (n - 1))), 8);
  for (let i = n - 2; i >= 0; i--) w.write(0x80 | (Math.floor(v / 2 ** (6 * i)) & 0x3f), 8);
}

/**
 * Codifica áudio inteiro (já quantizado em inteiros de `bps` bits) em FLAC. Assíncrono: cede a vez à
 * tela a cada lote de blocos.
 */
export async function encodeFlac(chans: Int32Array[], sr: number, bps: 16 | 24, onProgress?: (p: number) => void): Promise<Blob> {
  const ch = chans.length;
  const total = chans[0].length;
  const head = new BitWriter();
  for (const c of 'fLaC') head.write(c.charCodeAt(0), 8);
  head.write(1, 1); // último bloco de metadados
  head.write(0, 7); // STREAMINFO
  head.write(34, 24);
  head.write(BLOCK, 16);
  head.write(BLOCK, 16);
  head.write(0, 24); // tamanho mínimo de quadro: desconhecido
  head.write(0, 24);
  head.write(sr, 20);
  head.write(ch - 1, 3);
  head.write(bps - 1, 5);
  head.write(Math.floor(total / 2 ** 32), 4);
  head.write(total >>> 0, 32);
  for (let i = 0; i < 16; i++) head.write(0, 8); // MD5 desconhecido
  const parts: BlobPart[] = [head.bytes().slice()];

  const rice2 = bps > 16;
  let frame = 0;
  for (let start = 0; start < total; start += BLOCK, frame++) {
    const n = Math.min(BLOCK, total - start);
    const blk = chans.map((c) => c.subarray(start, start + n));
    // estéreo: escolhe entre esquerda/direita, esquerda/lado, lado/direita e meio/lado
    let assign = ch - 1; // independentes
    let subs: { x: Int32Array; bps: number; plan: SubframePlan }[];
    const plan = (x: Int32Array, b: number) => ({ x, bps: b, plan: planSubframe(x, b, rice2 || b > 16) });
    if (ch === 2) {
      const L = blk[0], R = blk[1];
      const S = new Int32Array(n), M = new Int32Array(n);
      for (let i = 0; i < n; i++) {
        S[i] = L[i] - R[i];
        M[i] = (L[i] + R[i]) >> 1;
      }
      const est = (x: Int32Array, b: number) => bestOrder(x, b, rice2 || b > 16 ? 30 : 14).bits;
      const cl = est(L, bps), cr = est(R, bps), cs = est(S, bps + 1), cm = est(M, bps);
      const options: [number, number, Int32Array, number, Int32Array, number][] = [
        [1, cl + cr, L, bps, R, bps],
        [8, cl + cs, L, bps, S, bps + 1],
        [9, cs + cr, S, bps + 1, R, bps],
        [10, cm + cs, M, bps, S, bps + 1],
      ];
      const best = options.reduce((a, b) => (b[1] < a[1] ? b : a));
      assign = best[0];
      subs = [plan(best[2], best[3]), plan(best[4], best[5])];
    } else subs = blk.map((x) => plan(x, bps));

    const w = new BitWriter();
    w.write(0xfff8, 16); // sincronia + estratégia de bloco fixo
    w.write(n === BLOCK ? 0b1100 : 0b0111, 4);
    w.write(0, 4); // taxa: a do STREAMINFO
    w.write(assign, 4);
    w.write(bps === 16 ? 0b100 : 0b110, 3);
    w.write(0, 1);
    utf8(w, frame);
    if (n !== BLOCK) w.write(n - 1, 16);
    w.write(crc8(w.bytes(), 0, w.len), 8);
    for (const s of subs) writeSubframe(w, s.x, s.bps, s.plan, rice2 || s.bps > 16);
    w.align();
    w.write(crc16(w.bytes(), 0, w.len), 16);
    parts.push(w.bytes().slice());
    if (frame % 64 === 63) {
      onProgress?.(start / total);
      await new Promise((ok) => setTimeout(ok, 0));
    }
  }
  return new Blob(parts, { type: 'audio/flac' });
}
