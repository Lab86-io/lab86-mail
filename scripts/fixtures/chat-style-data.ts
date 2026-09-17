import { resolveToolShape } from '../../lib/ai/tool-shapes';

export const chatStyleDocuments = [
  {
    documentId: 'style-deck',
    title: 'A calmer place to work',
    kind: 'deck',
    currentRevision: 3,
    model: {
      kind: 'deck',
      version: 1,
      activeSlideId: 'slide-0',
      slides: ['A calmer place to work', 'Make room for the next step', 'A shared direction'].map(
        (title, index) => ({
          id: `slide-${index}`,
          title,
          background: ['#193c36', '#efe6ce', '#d6dfe5'][index],
          elements: [
            {
              id: 'heading',
              type: 'text',
              x: 8,
              y: 16,
              width: 82,
              height: 50,
              fontSize: 60,
              text: title,
              color: index ? '#193c36' : '#efe6ce',
            },
            {
              id: 'caption',
              type: 'text',
              x: 8,
              y: 78,
              width: 82,
              height: 12,
              fontSize: 20,
              text: 'STUDIO NORTH · SEPTEMBER 2026',
              color: index ? '#193c36' : '#efe6ce',
            },
          ],
        }),
      ),
    },
  },
  {
    documentId: 'style-doc',
    title: 'Studio proposal',
    kind: 'doc',
    currentRevision: 2,
    model: {
      kind: 'doc',
      version: 1,
      blocks: Array.from({ length: 16 }, (_, index) => ({
        id: `block-${index}`,
        type: index % 4 === 0 ? 'heading' : 'paragraph',
        text:
          index % 4 === 0
            ? 'A shared direction'
            : 'Keep the plan clear. Bring the launch photography, site updates, and opening event into one schedule.',
      })),
    },
  },
  {
    documentId: 'style-sheet',
    title: 'Launch budget',
    kind: 'sheet',
    currentRevision: 1,
    model: {
      kind: 'sheet',
      version: 1,
      activeSheetId: 'budget',
      sheets: [
        {
          id: 'budget',
          name: 'Budget',
          rowCount: 20,
          columnCount: 4,
          cells: {
            A1: { value: 'Item' },
            B1: { value: 'Budget' },
            A2: { value: 'Photography' },
            B2: { value: 2400 },
            A3: { value: 'Design' },
            B3: { value: 3200 },
          },
        },
      ],
    },
  },
];

function result(toolName: string, toolCallId: string, output: unknown) {
  return [
    { type: `tool-${toolName}`, toolCallId, state: 'output-available', input: {}, output },
    { type: 'data-tool-shape', id: toolCallId, data: resolveToolShape(toolName, {}, output) },
  ];
}

export const chatStyleMessages = [
  {
    id: 'style-user',
    role: 'user',
    parts: [
      { type: 'text', text: 'Prepare the studio presentation and keep the proposal and budget beside it.' },
    ],
  },
  {
    id: 'style-assistant',
    role: 'assistant',
    parts: [
      { type: 'text', text: 'The presentation is ready. I kept the source files together for review.' },
      ...result('document_edit', 'style-edit', {
        ok: true,
        documentId: 'style-deck',
        title: 'A calmer place to work',
        kind: 'deck',
        revision: 3,
        status: 'applied',
        summary: 'Updated the opening, direction, and next steps.',
        openPath: '/?view=files&document=style-deck',
      }),
      { type: 'text', text: 'These files contain the plan and the cost breakdown.' },
      ...result('document_list', 'style-list', { documents: chatStyleDocuments.slice(1) }),
    ],
  },
];
