// Esticar/encolher áudio sem mudar a altura, preservando os ataques.
//
// O áudio é cortado nos ataques (começo de cada nota/batida) e cada pedaço é esticado separadamente com
// WSOLA (sobreposição e soma de janelas, cada uma encaixada no ponto de maior semelhança com a continuação
// natural da anterior). Assim cada ataque soa uma vez só e cai exatamente no lugar novo — esticar o áudio
// inteiro de uma vez borrava as batidas (o ataque podia sair duplicado ou ~15 ms adiantado).
// Puro (sem DOM): roda no worker de stretch.worker.ts ou, se não houver worker, no próprio thread.

/**
 * Ataques (em amostras, a partir de `from`) num trecho de `n` amostras. `sens` 0..1: quanto mais alto, mais
 * ataques fracos entram (notas ligadas, ghost notes).
 */
export function onsetsOf(channels: Float32Array[], from: number, n: number, sr: number, sens = 0.5): number[] {
  if (n < 1024 || !channels.length) return [];
  // mono, com a diferença entre amostras (realça o ataque, tira o grave contínuo)
  const x = new Float32Array(n);
  for (const d of channels) for (let i = 1; i < n; i++) x[i] += (d[from + i] - d[from + i - 1]) / channels.length;
  const hop = Math.round(sr * 0.005); // 5 ms
  const win = hop * 2;
  const frames = Math.floor((n - win) / hop);
  if (frames < 4) return [];
  const L = new Float32Array(frames);
  let peak = -Infinity;
  for (let k = 0; k < frames; k++) {
    let e = 0;
    for (let i = k * hop, end = i + win; i < end; i++) e += x[i] * x[i];
    L[k] = 10 * Math.log10(e / win + 1e-12);
    peak = Math.max(peak, L[k]);
  }
  // força do ataque: quanto o nível sobe em relação aos últimos ~40 ms
  const rise = new Float32Array(frames);
  for (let k = 1; k < frames; k++) {
    let m = Infinity;
    for (let j = Math.max(0, k - 8); j < k; j++) m = Math.min(m, L[j]);
    rise[k] = Math.max(0, L[k] - m);
  }
  const thr = 16 - 10 * Math.min(1, Math.max(0, sens)); // dB de subida
  const gate = peak - 40; // ignora o que está muito abaixo do mais forte
  const minGap = 10; // quadros (50 ms): ataques mais próximos viram um só
  const out: number[] = [];
  let last = -Infinity;
  for (let k = 1; k < frames - 1; k++) {
    if (rise[k] < thr || L[k] < gate) continue;
    let isPeak = true; // pico local da subida
    for (let j = Math.max(0, k - 3); j <= Math.min(frames - 1, k + 3); j++) if (rise[j] > rise[k]) isPeak = false;
    if (!isPeak || k - last < minGap) continue;
    // o começo do ataque: volta enquanto a subida ainda é grande
    let s = k;
    while (s > 0 && k - s < 6 && rise[s - 1] > thr * 0.5) s--;
    // e, dentro do quadro, a primeira amostra que já é parte do ataque
    const a = s * hop;
    let level = 0;
    for (let i = a; i < Math.min(n, a + win * 2); i++) level = Math.max(level, Math.abs(x[i]));
    let at = a;
    while (at < Math.min(n - 1, a + win * 2) && Math.abs(x[at]) < level * 0.25) at++;
    out.push(at);
    last = k;
  }
  return out;
}

/** WSOLA puro num trecho: devolve `outLen` amostras por canal. */
function wsolaCore(channels: Float32Array[], outLen: number, sampleRate: number): Float32Array[] {
  const inLen = channels[0].length;
  const ratio = outLen / inLen;
  if (Math.abs(ratio - 1) < 1e-4 || inLen < 64) {
    return channels.map((c) => {
      const r = new Float32Array(outLen);
      r.set(c.subarray(0, Math.min(inLen, outLen)));
      return r;
    });
  }
  // janela de ~40 ms (potência de 2): pega um ou mais períodos até das notas graves do baixo
  const N = 2 ** Math.round(Math.log2(sampleRate * 0.04));
  const Hs = N / 2; // passo na saída
  const Ha = Hs / ratio; // passo na entrada
  const tol = N / 8; // quanto o encaixe pode procurar para cada lado
  const L = N / 2; // trecho comparado (a parte que se sobrepõe)

  const win = new Float32Array(N);
  for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N);
  const mono = new Float32Array(inLen);
  for (const c of channels) for (let i = 0; i < inLen; i++) mono[i] += c[i] / channels.length;
  const out = channels.map(() => new Float32Array(outLen + N));
  const norm = new Float32Array(outLen + N);
  const at = (i: number) => (i >= 0 && i < inLen ? mono[i] : 0);

  /** Semelhança (correlação normalizada) entre o trecho em `pos` e o alvo em `ref`, amostrando a cada `step`. */
  const score = (pos: number, ref: number, step: number) => {
    let xy = 0, yy = 0;
    for (let i = 0; i < L; i += step) {
      const y = at(pos + i);
      xy += at(ref + i) * y;
      yy += y * y;
    }
    return yy > 1e-12 ? xy / Math.sqrt(yy) : 0;
  };

  let prev = 0;
  for (let k = 0; k * Hs < outLen; k++) {
    const nominal = Math.round(k * Ha);
    let pos = nominal;
    if (k > 0) {
      const ref = prev + Hs; // o que viria naturalmente depois da janela anterior
      const lo = Math.max(0, nominal - tol);
      const hi = Math.max(lo, Math.min(inLen - 1, nominal + tol));
      // busca grossa (a cada 4 amostras, comparando 1 de cada 4) e depois fina em volta da melhor
      let best = nominal, bestS = -Infinity;
      for (let p = lo; p <= hi; p += 4) {
        const s = score(p, ref, 4);
        if (s > bestS) {
          bestS = s;
          best = p;
        }
      }
      const c = best;
      bestS = -Infinity;
      for (let p = Math.max(lo, c - 4); p <= Math.min(hi, c + 4); p++) {
        const s = score(p, ref, 1);
        if (s > bestS) {
          bestS = s;
          best = p;
        }
      }
      pos = best;
    }
    const o = k * Hs;
    for (let ch = 0; ch < channels.length; ch++) {
      const src = channels[ch], dst = out[ch];
      for (let i = 0; i < N; i++) {
        const j = pos + i;
        if (j < inLen) dst[o + i] += src[j] * win[i];
      }
    }
    for (let i = 0; i < N; i++) norm[o + i] += win[i];
    prev = pos;
  }
  return out.map((c) => {
    const r = new Float32Array(outLen);
    for (let i = 0; i < outLen; i++) r[i] = norm[i] > 1e-3 ? c[i] / norm[i] : c[i];
    return r;
  });
}

/**
 * `channels`: os canais do áudio original. `ratio`: duração nova ÷ duração original (2 = o dobro, mais lento).
 * Todos os canais usam as mesmas decisões (tomadas na soma mono), para o estéreo não se desfazer.
 */
export function wsola(channels: Float32Array[], ratio: number, sampleRate: number): Float32Array[] {
  const inLen = channels[0]?.length ?? 0;
  const outLen = Math.max(1, Math.round(inLen * ratio));
  if (!inLen || Math.abs(ratio - 1) < 1e-4) return channels.map((c) => c.slice());

  const pre = Math.round(sampleRate * 0.003); // o corte fica um pouco antes do ataque
  const minSeg = Math.round(sampleRate * 0.06); // pedaços muito curtos se juntam ao anterior
  const xf = Math.round(sampleRate * 0.0025); // emenda entre pedaços (termina antes do ataque)
  const cuts = [0];
  for (const o of onsetsOf(channels, 0, inLen, sampleRate, 0.5)) {
    const c = o - pre;
    if (c - cuts[cuts.length - 1] >= minSeg && inLen - c >= minSeg) cuts.push(c);
  }
  cuts.push(inLen);

  const out = channels.map(() => new Float32Array(outLen));
  for (let s = 0; s < cuts.length - 1; s++) {
    const a = cuts[s];
    const b = cuts[s + 1];
    const oa = Math.round(a * ratio);
    const ob = s === cuts.length - 2 ? outLen : Math.round(b * ratio);
    const last = s === cuts.length - 2;
    // cada pedaço leva um pouco do áudio seguinte, para a emenda com o próximo
    const tail = last ? 0 : xf;
    const segLen = ob - oa + tail;
    const srcEnd = Math.min(inLen, b + Math.ceil(tail / ratio) + 1);
    const piece = wsolaCore(channels.map((c) => c.subarray(a, srcEnd)), segLen, sampleRate);
    for (let ch = 0; ch < channels.length; ch++) {
      const dst = out[ch], src = piece[ch];
      for (let i = 0; i < segLen && oa + i < outLen; i++) {
        let g = 1;
        if (s > 0 && i < xf) g = i / xf; // entra suave (o fim do pedaço anterior sai ao mesmo tempo)
        if (!last && i >= ob - oa) g = 1 - (i - (ob - oa)) / xf;
        dst[oa + i] += src[i] * g;
      }
    }
  }
  return out;
}
