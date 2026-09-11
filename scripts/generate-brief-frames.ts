/** Original vector mouldings; regenerate with bun scripts/generate-brief-frames.ts. */
import { writeFileSync } from 'node:fs';

type Design = { id: string; colors: string[]; motif: string; bands: number[] };
const black = ['#0c0d0e', '#444348', '#18181c', '#09090b', '#323037', '#121114'];
const designs: Design[] = [
  { id: 'gothic-cathedral', colors: black, motif: 'lancet', bands: [0, 4, 9, 15, 54, 61, 68, 75, 80] },
  { id: 'gothic-quatrefoil', colors: black, motif: 'quatrefoil', bands: [0, 6, 12, 18, 57, 63, 69, 76, 80] },
  {
    id: 'gothic-thorn',
    colors: ['#101012', '#39383d', '#1d191e', '#08080a', '#4f4649'],
    motif: 'thorn',
    bands: [0, 3, 8, 17, 57, 66, 70, 77, 80],
  },
  {
    id: 'gothic-ebony',
    colors: black,
    motif: 'ripple',
    bands: [0, 4, 8, 14, 21, 28, 35, 42, 49, 56, 63, 70, 76, 80],
  },
  {
    id: 'gothic-tracery',
    colors: ['#07090a', '#364246', '#151e21', '#0b1012', '#465152'],
    motif: 'tracery',
    bands: [0, 5, 11, 18, 57, 65, 71, 77, 80],
  },
  {
    id: 'gothic-reliquary',
    colors: ['#100e0e', '#514134', '#181416', '#09090b', '#817055', '#241c18'],
    motif: 'lancet',
    bands: [0, 4, 9, 15, 54, 61, 68, 75, 80],
  },
  {
    id: 'modern-graphite',
    colors: ['#101214', '#515356', '#272a2e', '#101214'],
    motif: 'plain',
    bands: [0, 4, 14, 62, 75, 80],
  },
  {
    id: 'modern-ivory',
    colors: ['#bdb9ae', '#fffdf7', '#e9e6df', '#8f8a80'],
    motif: 'plain',
    bands: [0, 3, 11, 65, 76, 80],
  },
  {
    id: 'modern-oak',
    colors: ['#6e5036', '#d6b789', '#b39165', '#705234', '#382b1d'],
    motif: 'wood',
    bands: [0, 4, 10, 60, 71, 80],
  },
  {
    id: 'modern-aluminum',
    colors: ['#55595c', '#f1f0e9', '#999d9e', '#363a3b'],
    motif: 'brushed',
    bands: [0, 5, 12, 66, 76, 80],
  },
  {
    id: 'modern-walnut',
    colors: ['#251a14', '#806049', '#573e2a', '#39271c', '#16120f'],
    motif: 'wood',
    bands: [0, 4, 9, 60, 70, 80],
  },
  {
    id: 'deco-stepped',
    colors: ['#282120', '#bba16d', '#675436', '#121719', '#dcc696'],
    motif: 'steps',
    bands: [0, 5, 12, 20, 30, 40, 50, 60, 70, 76, 80],
  },
  {
    id: 'deco-fan',
    colors: ['#161a1b', '#c6a66a', '#312b25', '#101617', '#967a46'],
    motif: 'fan',
    bands: [0, 4, 10, 17, 58, 65, 73, 77, 80],
  },
  {
    id: 'deco-sunburst',
    colors: ['#503b22', '#e0c58a', '#a5854f', '#292420', '#f0dba9'],
    motif: 'sunburst',
    bands: [0, 5, 11, 18, 58, 65, 72, 77, 80],
  },
  {
    id: 'deco-emerald',
    colors: ['#102826', '#baaa73', '#23413a', '#0f211f', '#958555'],
    motif: 'chevron',
    bands: [0, 4, 9, 16, 59, 66, 73, 77, 80],
  },
  {
    id: 'deco-champagne',
    colors: ['#726550', '#eee2bf', '#bdac87', '#524838', '#ddcfab'],
    motif: 'steps',
    bands: [0, 5, 12, 22, 32, 42, 52, 62, 72, 77, 80],
  },
];

function ring(inset: number, next: number, fill: string) {
  const size = 240 - 2 * inset,
    hole = 240 - 2 * next;
  return `<path fill="${fill}" fill-rule="evenodd" d="M${inset} ${inset}h${size}v${size}h-${size}z M${next} ${next}v${hole}h${hole}v-${hole}z"/>`;
}

function ornament(motif: string, color: string): string {
  const style = `fill="none" stroke="${color}" stroke-width="1.3"`;
  if (motif === 'lancet')
    return `<g ${style}><path d="M91 54V40Q91 27 100 21Q109 27 109 40V54ZM113 54V40Q113 27 122 21Q131 27 131 40V54ZM135 54V40Q135 27 144 21Q153 27 153 40V54"/><path d="M94 54L100 32L106 54M116 54L122 32L128 54M138 54L144 32L150 54" opacity=".55"/></g>`;
  if (motif === 'quatrefoil')
    return `<g ${style}>${[100, 140].map((x) => `<path d="M${x} 24C${x + 13} 15 ${x + 21} 33 ${x + 10} 38C${x + 21} 49 ${x + 5} 60 ${x} 49C${x - 10} 60 ${x - 21} 43 ${x - 10} 38C${x - 21} 28 ${x - 6} 15 ${x} 24Z"/><circle cx="${x}" cy="38" r="4"/>`).join('')}</g>`;
  if (motif === 'thorn')
    return `<g ${style}><path d="M80 38Q100 16 120 38T160 38M80 38Q100 60 120 38T160 38M90 28L94 19L101 29M130 48L136 56L141 46M110 46L108 56L102 48M150 28L154 19L158 29"/></g>`;
  if (motif === 'tracery')
    return `<g ${style}><path d="M80 52Q100 10 120 52Q140 10 160 52M80 24Q100 66 120 24Q140 66 160 24"/><path d="M100 23L113 38L100 53L87 38ZM140 23L153 38L140 53L127 38Z"/></g>`;
  if (motif === 'fan')
    return `<g ${style}>${[100, 140].map((x) => `<path d="M${x} 55L${x - 18} 30Q${x} 14 ${x + 18} 30ZM${x} 55L${x - 10} 23M${x} 55V21M${x} 55L${x + 10} 23"/>`).join('')}</g>`;
  if (motif === 'chevron')
    return `<g ${style}>${[88, 108, 128, 148].map((x) => `<path d="M${x - 9} 26L${x} 39L${x + 9} 26M${x - 9} 40L${x} 53L${x + 9} 40"/>`).join('')}</g>`;
  if (motif === 'sunburst')
    return `<g ${style}>${Array.from({ length: 11 }, (_, i) => `<path d="M120 58L${84 + i * 7.2} 21"/>`).join('')}<path d="M103 57A17 17 0 0 1 137 57"/></g>`;
  if (motif === 'ripple')
    return `<g ${style} opacity=".6">${Array.from({ length: 20 }, (_, i) => `<path d="M${80 + i * 4} 21q3 8 0 16t0 16"/>`).join('')}</g>`;
  if (motif === 'wood' || motif === 'brushed')
    return `<g ${style} opacity=".18">${Array.from({ length: 12 }, (_, i) => `<path d="M80 ${16 + i * 3.7}Q115 ${14 + i * 3.7} 160 ${16 + i * 3.7}"/>`).join('')}</g>`;
  return '';
}

for (const design of designs) {
  let body = '';
  design.bands.slice(0, -1).forEach((inset, i) => {
    body += ring(inset, design.bands[i + 1], design.colors[i % design.colors.length]);
    body += ring(inset, inset + 0.65, '#ffffff18');
  });
  // Each side repeats seamlessly between the 80px corner slices.
  for (let rotation = 0; rotation < 360; rotation += 90) {
    const accent = design.id.startsWith('gothic') ? design.colors[1] : (design.colors[4] ?? design.colors[1]);
    body += `<g transform="rotate(${rotation} 120 120)">${ornament(design.motif, accent)}</g>`;
    if (design.motif === 'plain' || design.motif === 'wood' || design.motif === 'brushed') continue;
    const corner = design.id.startsWith('deco')
      ? '<path d="M18 63V18H63M25 63V25H63M32 63V32H63M39 63V39H63M46 63V46H63"/>'
      : '<path d="M22 56Q20 28 56 22Q57 38 42 42Q39 58 22 56ZM27 50L50 27M28 29Q17 16 29 20Q33 14 36 22"/><path d="M41 50L50 41L59 50L50 59Z"/>';
    body += `<g transform="rotate(${rotation} 120 120)" fill="none" stroke="${accent}" stroke-width="1.5">${corner}</g>`;
  }
  // Light runs across each moulding, never along its tiled edge; this avoids
  // visible brightness seams when border-image repeats the side strips.
  const light = [0, 90, 180, 270]
    .map(
      (rotation) =>
        `<path transform="rotate(${rotation} 120 120)" d="M0 0H240L160 80H80Z" fill="url(#light)"/>`,
    )
    .join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="240" height="240" viewBox="0 0 240 240"><defs><linearGradient id="light" x2="0" y2="80" gradientUnits="userSpaceOnUse"><stop stop-color="#fff" stop-opacity=".13"/><stop offset=".45" stop-color="#fff" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity=".28"/></linearGradient></defs>${body}${light}</svg>`;
  writeFileSync(`public/frames/${design.id}.svg`, svg);
}
console.log(`Wrote ${designs.length} original SVG frames.`);
