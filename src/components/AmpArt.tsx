// Ilustrações (SVG) dos cabeçotes e das caixas. Cada modelo tem forma, material e detalhes próprios;
// os visuais são originais (sem logotipos nem trade dress de marcas).
// O painel de controles (botões giratórios) é posicionado por cima, na área `panel` de cada desenho.
import { ReactNode, useId } from 'react';

export interface Art {
  w: number;
  h: number;
  /** área do painel de controles, em px dentro do desenho */
  panel: { x: number; y: number; w: number; h: number };
  draw: (id: string, lit: boolean) => ReactNode;
}

/** Cantoneiras de metal nos quatro cantos. */
const corners = (w: number, h: number, s = 16, fill = 'url(#chrome)') => (
  <g fill={fill} stroke="#111" strokeWidth="0.8">
    <path d={`M0 ${s} V4 Q0 0 4 0 H${s} L${s} 4 Q4 4 4 ${s} Z`} />
    <path d={`M${w} ${s} V4 Q${w} 0 ${w - 4} 0 H${w - s} L${w - s} 4 Q${w - 4} 4 ${w - 4} ${s} Z`} />
    <path d={`M0 ${h - s} V${h - 4} Q0 ${h} 4 ${h} H${s} L${s} ${h - 4} Q4 ${h - 4} 4 ${h - s} Z`} />
    <path d={`M${w} ${h - s} V${h - 4} Q${w} ${h} ${w - 4} ${h} H${w - s} L${w - s} ${h - 4} Q${w - 4} ${h - 4} ${w - 4} ${h - s} Z`} />
  </g>
);

/** Definições compartilhadas (texturas e gradientes). Os ids levam um prefixo único por desenho. */
const defs = (p: string) => (
  <defs>
    <pattern id={`${p}tolex`} width="4" height="4" patternUnits="userSpaceOnUse">
      <rect width="4" height="4" fill="#161616" /><circle cx="1" cy="1" r="0.7" fill="#232323" /><circle cx="3" cy="3" r="0.6" fill="#0d0d0d" />
    </pattern>
    <pattern id={`${p}tolexRed`} width="4" height="4" patternUnits="userSpaceOnUse">
      <rect width="4" height="4" fill="#4a1418" /><circle cx="1" cy="1" r="0.7" fill="#5c1c21" /><circle cx="3" cy="3" r="0.6" fill="#350c10" />
    </pattern>
    <pattern id={`${p}sparkle`} width="6" height="6" patternUnits="userSpaceOnUse">
      <rect width="6" height="6" fill="#9ea3a8" /><path d="M0 0 L6 6 M6 0 L0 6" stroke="#c9ced3" strokeWidth="0.6" /><circle cx="3" cy="3" r="0.6" fill="#f4f6f8" />
    </pattern>
    <pattern id={`${p}weave`} width="6" height="6" patternUnits="userSpaceOnUse">
      <rect width="6" height="6" fill="#26231f" /><rect width="3" height="3" fill="#3a352d" /><rect x="3" y="3" width="3" height="3" fill="#3a352d" />
    </pattern>
    <pattern id={`${p}cloth`} width="4" height="4" patternUnits="userSpaceOnUse">
      <rect width="4" height="4" fill="#3b3833" /><path d="M0 4 L4 0" stroke="#4d4942" strokeWidth="0.7" /><path d="M0 0 L4 4" stroke="#2a2824" strokeWidth="0.5" />
    </pattern>
    <pattern id={`${p}wheat`} width="4" height="4" patternUnits="userSpaceOnUse">
      <rect width="4" height="4" fill="#b9ab8b" /><path d="M0 4 L4 0" stroke="#d3c7a9" strokeWidth="0.7" /><path d="M0 0 L4 4" stroke="#9c8f71" strokeWidth="0.5" />
    </pattern>
    <pattern id={`${p}perf`} width="5" height="5" patternUnits="userSpaceOnUse">
      <rect width="5" height="5" fill="#4a4e55" /><circle cx="2.5" cy="2.5" r="1.4" fill="#0b0b0c" />
    </pattern>
    <pattern id={`${p}diamond`} width="14" height="14" patternUnits="userSpaceOnUse">
      <rect width="14" height="14" fill="#2b2d30" />
      <path d="M2 5 L5 2 L6 3 L3 6 Z M9 12 L12 9 L13 10 L10 13 Z" fill="#4b4f55" />
      <path d="M9 2 L12 5 L11 6 L8 3 Z M2 9 L5 12 L4 13 L1 10 Z" fill="#4b4f55" />
    </pattern>
    <linearGradient id={`${p}wood`} x1="0" x2="1" y1="0" y2="0.2">
      <stop offset="0" stopColor="#6b4426" /><stop offset="0.3" stopColor="#8a5a33" /><stop offset="0.55" stopColor="#704628" />
      <stop offset="0.8" stopColor="#93623a" /><stop offset="1" stopColor="#5e3b20" />
    </linearGradient>
    <linearGradient id={`${p}copper`} x1="0" x2="1">
      <stop offset="0" stopColor="#8f5a35" /><stop offset="0.5" stopColor="#c98a5a" /><stop offset="1" stopColor="#8a5531" />
    </linearGradient>
    <linearGradient id={`${p}alu`} x1="0" x2="0" y1="0" y2="1">
      <stop offset="0" stopColor="#e3e6ea" /><stop offset="0.5" stopColor="#b9bec5" /><stop offset="1" stopColor="#9aa0a8" />
    </linearGradient>
    <linearGradient id={`${p}cream`} x1="0" x2="0" y1="0" y2="1">
      <stop offset="0" stopColor="#f3ead4" /><stop offset="1" stopColor="#dccfae" />
    </linearGradient>
    <linearGradient id="chrome" x1="0" x2="1" y1="0" y2="1">
      <stop offset="0" stopColor="#f5f5f5" /><stop offset="0.45" stopColor="#9a9a9a" /><stop offset="0.55" stopColor="#d6d6d6" /><stop offset="1" stopColor="#6d6d6d" />
    </linearGradient>
    <radialGradient id={`${p}glow`}>
      <stop offset="0" stopColor="#ff5a3a" stopOpacity="0.9" /><stop offset="1" stopColor="#ff2a10" stopOpacity="0" />
    </radialGradient>
  </defs>
);

const handle = (cx: number, y: number, w: number, color = '#1d1d1d') => (
  <path d={`M${cx - w / 2} ${y} q0 -12 10 -12 h${w - 20} q10 0 10 12`} fill="none" stroke={color} strokeWidth="6" strokeLinecap="round" />
);

const vents = (x: number, y: number, n: number, w: number, color: string) =>
  Array.from({ length: n }, (_, i) => <rect key={i} x={x + i * (w + 5)} y={y} width={w} height="4" rx="2" fill={color} />);

// ---------- Cabeçotes ----------

export const AMP_ART: Record<string, Art> = {
  // Limpo Americano: cabeçote largo e baixo, tolex preto, faixa de tela prateada, cantoneiras cromadas
  clean: {
    w: 470, h: 150, panel: { x: 16, y: 20, w: 438, h: 66 },
    draw: (p) => (
      <>
        {defs(p)}
        {handle(235, 14, 110)}
        <rect x="0" y="12" width="470" height="138" rx="8" fill={`url(#${p}tolex)`} />
        <rect x="10" y="18" width="450" height="72" rx="3" fill="#0f0f10" stroke="#8d9196" strokeWidth="1.5" />
        <rect x="10" y="96" width="450" height="46" rx="3" fill={`url(#${p}sparkle)`} />
        <rect x="10" y="96" width="450" height="46" rx="3" fill="none" stroke="#5f6368" strokeWidth="1.5" />
        <rect x="370" y="110" width="78" height="18" rx="3" fill="url(#chrome)" stroke="#555" />
        <text x="409" y="123" textAnchor="middle" fontFamily="Georgia, serif" fontStyle="italic" fontWeight="700" fontSize="11" fill="#222">Alien Studio</text>
        <g transform="translate(0 12)">{corners(470, 138)}</g>
      </>
    ),
  },
  // Jazz Limpo: caixa de madeira de cantos arredondados, alça de couro e painel creme embaixo
  jazz: {
    w: 400, h: 150, panel: { x: 16, y: 76, w: 368, h: 62 },
    draw: (p) => (
      <>
        {defs(p)}
        <path d="M150 14 q0 -12 14 -12 h72 q14 0 14 12" fill="none" stroke="#5a3418" strokeWidth="8" strokeLinecap="round" />
        <rect x="0" y="12" width="400" height="138" rx="22" fill={`url(#${p}wood)`} />
        <g stroke="#4a2c15" strokeOpacity="0.35" fill="none" strokeWidth="1.2">
          <path d="M8 34 C110 26 190 44 392 30" /><path d="M8 52 C140 60 260 40 392 50" /><path d="M10 64 C120 70 300 58 390 66" />
        </g>
        <rect x="10" y="22" width="380" height="44" rx="14" fill="#2a1a0e" opacity="0.85" />
        <rect x="16" y="28" width="368" height="32" rx="10" fill={`url(#${p}wheat)`} />
        <text x="200" y="49" textAnchor="middle" fontFamily="Georgia, serif" fontStyle="italic" fontWeight="700" fontSize="14" fill="#3b2a18">Alien Studio</text>
        <rect x="10" y="72" width="380" height="70" rx="10" fill={`url(#${p}cream)`} stroke="#8b6a43" strokeWidth="1.5" />
        {[[20, 80], [380, 80], [20, 134], [380, 134]].map(([x, y]) => <circle key={`${x}${y}`} cx={x} cy={y} r="2.5" fill="#b8925a" stroke="#6b4c2a" strokeWidth="0.6" />)}
      </>
    ),
  },
  // Crunch Britânico: cabeçote alto em tolex vinho, grade em trama no alto e painel de cobre escovado
  crunch: {
    w: 470, h: 165, panel: { x: 18, y: 92, w: 434, h: 62 },
    draw: (p) => (
      <>
        {defs(p)}
        {handle(235, 14, 120, '#111')}
        <rect x="0" y="12" width="470" height="153" rx="6" fill={`url(#${p}tolexRed)`} />
        <rect x="4" y="16" width="462" height="145" rx="4" fill="none" stroke="#d8c8a8" strokeWidth="2" />
        <rect x="12" y="24" width="446" height="58" rx="2" fill={`url(#${p}weave)`} stroke="#1a1714" strokeWidth="1.5" />
        <rect x="186" y="42" width="98" height="22" rx="4" fill="#1a1512" stroke="#c98a5a" strokeWidth="1.2" />
        <text x="235" y="58" textAnchor="middle" fontFamily="Georgia, serif" fontStyle="italic" fontWeight="700" fontSize="13" fill="#e2b48a">Alien Studio</text>
        <rect x="12" y="88" width="446" height="70" rx="3" fill={`url(#${p}copper)`} stroke="#4a2a14" strokeWidth="1.2" />
        <g stroke="#ffffff" strokeOpacity="0.08">{Array.from({ length: 14 }, (_, i) => <line key={i} x1="12" x2="458" y1={91 + i * 5} y2={91 + i * 5} />)}</g>
        {[[20, 94], [450, 94], [20, 152], [450, 152]].map(([x, y]) => <circle key={`${x}${y}`} cx={x} cy={y} r="2.2" fill="url(#chrome)" stroke="#333" strokeWidth="0.5" />)}
      </>
    ),
  },
  // Alto Ganho: chassi de aço chanfrado, frente em chapa xadrez e aberturas de ventilação que brilham em vermelho
  high: {
    w: 490, h: 160, panel: { x: 26, y: 58, w: 438, h: 64 },
    draw: (p, lit) => (
      <>
        {defs(p)}
        <polygon points="22,0 468,0 490,22 490,138 468,160 22,160 0,138 0,22" fill="#141516" stroke="#3b3e42" strokeWidth="2" />
        <polygon points="26,6 464,6 484,26 484,134 464,154 26,154 6,134 6,26" fill={`url(#${p}diamond)`} />
        <rect x="28" y="16" width="434" height="30" rx="3" fill="#0b0b0c" stroke="#3b3e42" />
        {lit && <ellipse cx="245" cy="31" rx="220" ry="16" fill={`url(#${p}glow)`} />}
        {vents(40, 22, 24, 12, lit ? '#ff3b22' : '#3a1210').map((v) => v)}
        {vents(40, 32, 24, 12, lit ? '#d42a14' : '#2c0e0c').map((v) => v)}
        <rect x="20" y="54" width="450" height="72" rx="3" fill="#0e0e0f" stroke="#5a5d62" strokeWidth="1.2" />
        <rect x="28" y="132" width="434" height="14" rx="2" fill="#0b0b0c" />
        <text x="245" y="143" textAnchor="middle" fontFamily="Consolas, monospace" fontWeight="800" fontSize="10" letterSpacing="5" fill="#ff4a3d">ALIEN STUDIO · ALTO GANHO</text>
        {[[14, 14], [476, 14], [14, 146], [476, 146]].map(([x, y]) => <circle key={`${x}${y}`} cx={x} cy={y} r="3" fill="#6a6e74" stroke="#111" />)}
      </>
    ),
  },
  // Baixo Valvulado: frente de alumínio com orelhas de rack e alças laterais, faixa azul e grade de ventilação
  bass: {
    w: 480, h: 160, panel: { x: 46, y: 72, w: 388, h: 64 },
    draw: (p) => (
      <>
        {defs(p)}
        <rect x="24" y="0" width="432" height="160" rx="4" fill="#121417" />
        <rect x="0" y="6" width="480" height="148" rx="4" fill={`url(#${p}alu)`} stroke="#6f757d" />
        {[8, 448].map((x) => (
          <g key={x}>
            <rect x={x} y="22" width="24" height="116" rx="12" fill="none" stroke="#2b2f35" strokeWidth="6" />
            <circle cx={x + 12} cy="14" r="3" fill="#555" /><circle cx={x + 12} cy="146" r="3" fill="#555" />
          </g>
        ))}
        <rect x="44" y="14" width="392" height="44" rx="3" fill="#1c2026" />
        <g>{Array.from({ length: 6 }, (_, i) => <rect key={i} x="54" y={19 + i * 6.5} width="372" height="3" rx="1.5" fill="#3a4049" />)}</g>
        <rect x="44" y="62" width="392" height="6" fill="#2f6fd6" />
        <rect x="44" y="70" width="392" height="68" rx="3" fill="#20252c" stroke="#0f1215" />
        <text x="240" y="152" textAnchor="middle" fontFamily="Consolas, monospace" fontWeight="800" fontSize="9" letterSpacing="4" fill="#2b2f35">ALIEN STUDIO BASS</text>
      </>
    ),
  },
  // Sem amp: caixinha de linha direta
  none: {
    w: 300, h: 110, panel: { x: 16, y: 26, w: 268, h: 64 },
    draw: (p) => (
      <>
        {defs(p)}
        <rect x="0" y="10" width="300" height="100" rx="10" fill="#2b2d31" stroke="#45484e" strokeWidth="2" />
        <rect x="10" y="20" width="280" height="80" rx="6" fill="#1c1d20" />
        {[-6, 296].map((x) => <rect key={x} x={x} y="48" width="10" height="20" rx="2" fill="#555" />)}
      </>
    ),
  },
};

// ---------- Caixas ----------

const speaker = (cx: number, cy: number, r: number, alpha = 0.5) => (
  <g opacity={alpha}>
    <circle cx={cx} cy={cy} r={r} fill="#141414" />
    <circle cx={cx} cy={cy} r={r * 0.92} fill="#2e2e2e" />
    <circle cx={cx} cy={cy} r={r * 0.55} fill="#1d1d1d" />
    <circle cx={cx} cy={cy} r={r * 0.2} fill="#5a5a5a" />
  </g>
);

const casters = (w: number, h: number) => (
  <g fill="#1b1b1b" stroke="#444">
    <rect x={w * 0.14 - 7} y={h - 10} width="14" height="6" rx="2" /><circle cx={w * 0.14} cy={h - 3} r="4" />
    <rect x={w * 0.86 - 7} y={h - 10} width="14" height="6" rx="2" /><circle cx={w * 0.86} cy={h - 3} r="4" />
  </g>
);

const grid = (x: number, y: number, w: number, h: number, cols: number, rows: number, alpha: number) => {
  const r = Math.min(w / cols, h / rows) / 2 - 3;
  const out = [];
  for (let i = 0; i < cols; i++) for (let j = 0; j < rows; j++) out.push(<g key={`${i}${j}`}>{speaker(x + (w / cols) * (i + 0.5), y + (h / rows) * (j + 0.5), r, alpha)}</g>);
  return out;
};

export const CAB_ART: Record<string, { w: number; h: number; draw: (p: string) => ReactNode }> = {
  // 1x12 aberta: combo pequeno com fresta no alto e tela clara
  '1x12': {
    w: 150, h: 150,
    draw: (p) => (
      <>
        {defs(p)}
        <rect width="150" height="150" rx="8" fill={`url(#${p}tolex)`} />
        <rect x="10" y="10" width="130" height="16" rx="2" fill="#0a0a0a" />
        <rect x="10" y="32" width="130" height="108" rx="4" fill={`url(#${p}wheat)`} />
        {speaker(75, 86, 46, 0.35)}
        {corners(150, 150, 14)}
      </>
    ),
  },
  // 2x12 combo: larga, tela escura, debrum claro
  '2x12': {
    w: 210, h: 140,
    draw: (p) => (
      <>
        {defs(p)}
        <rect width="210" height="140" rx="6" fill={`url(#${p}tolex)`} />
        <rect x="8" y="8" width="194" height="124" rx="4" fill={`url(#${p}cloth)`} stroke="#c9c2b0" strokeWidth="2" />
        {grid(8, 8, 194, 124, 2, 1, 0.45)}
        {corners(210, 140, 14)}
      </>
    ),
  },
  // 4x12 fechada: topo inclinado (parte de cima recuada), alças laterais e cantoneiras
  '4x12': {
    w: 180, h: 168,
    draw: (p) => (
      <>
        {defs(p)}
        <polygon points="12,0 168,0 180,30 180,168 0,168 0,30" fill={`url(#${p}tolex)`} />
        <polygon points="18,6 162,6 172,32 8,32" fill={`url(#${p}cloth)`} opacity="0.75" />
        <rect x="8" y="34" width="164" height="126" rx="3" fill={`url(#${p}cloth)`} stroke="#0c0c0c" strokeWidth="1.5" />
        {grid(8, 8, 164, 152, 2, 2, 0.4)}
        <rect x="-4" y="78" width="6" height="30" rx="3" fill="#222" /><rect x="178" y="78" width="6" height="30" rx="3" fill="#222" />
        <g transform="translate(0 30)">{corners(180, 138, 14)}</g>
      </>
    ),
  },
  // 1x8 pequena: caixinha com alça de couro em cima
  '1x8': {
    w: 112, h: 118,
    draw: (p) => (
      <>
        {defs(p)}
        <path d="M30 18 q0 -14 14 -14 h24 q14 0 14 14" fill="none" stroke="#6b3d1e" strokeWidth="6" strokeLinecap="round" />
        <rect y="16" width="112" height="102" rx="10" fill="#26303a" />
        <rect x="8" y="24" width="96" height="86" rx="6" fill={`url(#${p}wheat)`} />
        {speaker(56, 67, 34, 0.35)}
      </>
    ),
  },
  // 4x10 de baixo: grade de metal perfurada, rodinhas
  '4x10b': {
    w: 168, h: 166,
    draw: (p) => (
      <>
        {defs(p)}
        <rect width="168" height="158" rx="6" fill={`url(#${p}tolex)`} />
        <rect x="8" y="8" width="152" height="142" rx="4" fill={`url(#${p}perf)`} stroke="#0a0a0a" strokeWidth="1.5" />
        {grid(8, 8, 152, 142, 2, 2, 0.35)}
        {corners(168, 158, 14)}
        {casters(168, 166)}
      </>
    ),
  },
  // 8x10 de baixo: "geladeira" alta e estreita, alças grandes, rodinhas
  '8x10b': {
    w: 112, h: 172,
    draw: (p) => (
      <>
        {defs(p)}
        <rect width="112" height="164" rx="6" fill={`url(#${p}tolex)`} />
        <rect x="7" y="7" width="98" height="150" rx="3" fill={`url(#${p}perf)`} stroke="#0a0a0a" strokeWidth="1.5" />
        {grid(7, 7, 98, 150, 2, 4, 0.3)}
        <rect x="-4" y="40" width="6" height="34" rx="3" fill="#222" /><rect x="110" y="40" width="6" height="34" rx="3" fill="#222" />
        {corners(112, 164, 12)}
        {casters(112, 172)}
      </>
    ),
  },
  // IR do usuário: caixa genérica com etiqueta
  user: {
    w: 190, h: 140,
    draw: (p) => (
      <>
        {defs(p)}
        <rect width="190" height="140" rx="6" fill={`url(#${p}tolex)`} />
        <rect x="8" y="8" width="174" height="124" rx="4" fill={`url(#${p}cloth)`} />
        {grid(8, 8, 174, 124, 2, 1, 0.4)}
        {corners(190, 140, 14)}
      </>
    ),
  },
  // sem caixa: caixa direta (DI) com dois conectores
  none: {
    w: 110, h: 76,
    draw: () => (
      <>
        <rect y="6" width="110" height="70" rx="8" fill="#3a3d42" stroke="#5a5e65" strokeWidth="2" />
        <rect x="-4" y="30" width="10" height="16" rx="2" fill="#666" /><rect x="104" y="30" width="10" height="16" rx="2" fill="#666" />
        <text x="55" y="42" textAnchor="middle" fontFamily="Consolas, monospace" fontWeight="800" fontSize="18" fill="#e5e5e5">DI</text>
        <text x="55" y="60" textAnchor="middle" fontFamily="Consolas, monospace" fontWeight="700" fontSize="8" letterSpacing="1" fill="#aaa">SEM CAIXA</text>
      </>
    ),
  },
};

/** Desenho SVG com prefixo único para os ids das texturas. */
export function ArtSvg({ w, h, draw, lit = false, className }: { w: number; h: number; draw: (p: string, lit: boolean) => ReactNode; lit?: boolean; className?: string }) {
  const p = useId().replace(/[^a-zA-Z0-9]/g, '');
  return (
    <svg className={className} width={w} height={h} viewBox={`-6 -2 ${w + 12} ${h + 4}`} style={{ width: w + 12, height: h + 4 }} aria-hidden="true">
      {draw(p, lit)}
    </svg>
  );
}
