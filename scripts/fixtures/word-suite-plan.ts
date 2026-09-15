import type { WordEdit } from '../../lib/documents/word-package';
export const png =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAAABHNCSVQICAgIfAhkiAAAAAFzUkdCAK7OHOkAAACZSURBVHic7dBBEcAgAMAwQBbasIyGISOPNQp6nWffb/zY0gFaA3SA1gAdoDVAB2gN0AFaA3SA1gAdoDVAB2gN0AFaA3SA1gAdoDVAB2gN0AFaA3SA1gAdoDVAB2gN0AFaA3SA1gAdoDVAB2gN0AFaA3SA1gAdoDVAB2gN0AFaA3SA1gAdoDVAB2gN0AFaA3SA1gAdoDVAB2gPe+QDIpqdfeQAAAAASUVORK5CYII=';
export const fullWordEdits: WordEdit[] = [
  { op: 'insert_paragraph', text: 'Quarterly update', heading: 1 },
  { op: 'insert_paragraph', text: 'Revenue grew from $10 to $20.' },
  {
    op: 'format_text',
    paragraphs: [2],
    bold: true,
    italic: true,
    underline: true,
    strike: false,
    font: 'Arial',
    size: 14,
    color: '14532D',
    highlight: 'yellow',
  },
  {
    op: 'format_paragraph',
    paragraphs: [1],
    alignment: 'center',
    heading: 1,
    lineSpacing: 1.5,
    spaceAfter: 12,
    pageBreakBefore: false,
  },
  {
    op: 'insert_table',
    after: 2,
    rows: [
      ['Month', 'Revenue'],
      ['September', '$20'],
    ],
  },
  { op: 'set_header_footer', area: 'header', text: 'Lab86 · Quarterly report' },
  { op: 'set_header_footer', area: 'footer', text: 'Internal review' },
  { op: 'insert_image', dataUrl: png, width: 96, height: 96, alt: 'Report image' },
  { op: 'add_comment', paragraph: 2, text: 'Confirm the final figures.', author: 'Editor' },
  { op: 'page_setup', size: 'a4', landscape: true, marginInches: 0.75 },
];
