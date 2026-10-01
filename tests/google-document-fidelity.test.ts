import { afterEach, describe, expect, test } from 'bun:test';
import {
  __setGoogleDocumentDepsForTest,
  GoogleDocumentConflictError,
  GoogleDocumentSaveMismatchError,
  updateGoogleNativeFile,
} from '../lib/documents/google';
import { googleDocHasOpenComments } from '../lib/documents/google-comments';
import { googleDocTarget, googleDocUpdateRequests } from '../lib/documents/google-doc-diff';
import {
  assertGoogleFileEditable,
  googleFileEditability,
  googleListPreset,
  normalizeLink,
  projectGoogleDoc,
} from '../lib/documents/google-fidelity';
import {
  __setGoogleImportDepsForTest,
  googleDocModel,
  importGoogleNativeFile,
} from '../lib/documents/google-import';
import {
  googleLinkedFileSyncLimitation,
  LINKED_GOOGLE_FILE_SYNC_LIMITATION,
} from '../lib/documents/google-write-policy';
import { createDefaultDocumentModel } from '../lib/documents/model';
import { GoogleDocsSimulator, simulatorFetch } from './google-docs-simulator';

const paragraph = {
  startIndex: 1,
  endIndex: 8,
  paragraph: { elements: [{ textRun: { content: 'Source\n' } }] },
};
const plain = { revisionId: 'revision', body: { content: [paragraph] } };
afterEach(() => {
  __setGoogleDocumentDepsForTest();
  __setGoogleImportDepsForTest();
});

test('plain document round-trips preserve blank paragraphs without appending new ones', async () => {
  const access = (async () => ({ connection: { provider: 'google_drive' }, accessToken: 'fixture' })) as any;
  const doc = new GoogleDocsSimulator([{ text: 'Source' }, { text: '' }]);
  const google = simulatorFetch(doc, { name: 'Memo', legacy: true });
  __setGoogleImportDepsForTest({ getCloudFileAccess: access, fetch: google.fetch });
  __setGoogleDocumentDepsForTest({ getCloudFileAccess: access, fetch: google.fetch });
  const imported = await importGoogleNativeFile({
    userId: 'owner',
    connectionId: 'drive',
    fileId: 'doc',
    mimeType: 'application/vnd.google-apps.document',
  });
  expect(imported.model.kind).toBe('doc');
  if (imported.model.kind !== 'doc') throw new Error('Expected document');
  expect(imported.model.blocks.map((block) => block.text)).toEqual(['Source', '']);
  const save = (model: unknown) =>
    updateGoogleNativeFile({
      userId: 'owner',
      connectionId: 'drive',
      fileId: 'doc',
      kind: 'doc',
      title: 'Memo',
      model,
      expectedProviderVersion: google.version(),
    });
  // An unchanged model sends no batchUpdate at all.
  await save(imported.model);
  expect(google.calls.some((call) => call.url.endsWith(':batchUpdate'))).toBe(false);
  const edited = {
    ...imported.model,
    blocks: imported.model.blocks.map((block, index) =>
      index === 0 ? { ...block, text: 'Source text' } : block,
    ),
  };
  await save(edited);
  const batches = google.calls.filter((call) => call.url.endsWith(':batchUpdate'));
  expect(batches).toHaveLength(1);
  expect(batches[0].body).toEqual({
    requests: [
      { insertText: { location: { index: 7 }, text: ' text' } },
      { updateTextStyle: { range: { startIndex: 7, endIndex: 12 }, textStyle: {}, fields: '*' } },
    ],
    writeControl: { requiredRevisionId: 'rev-1' },
  });
  expect(doc.text()).toEqual(['Source text', '']);
});
test('only losslessly supported document content can be edited in place', () => {
  expect(googleFileEditability('doc', plain).editable).toBe(true);
  for (const source of [
    { ...plain, body: { content: [paragraph, { table: {} }] } },
    { ...plain, body: { content: [{ ...paragraph, paragraph: { ...paragraph.paragraph, bullet: {} } }] } },
    {
      ...plain,
      body: {
        content: [{ paragraph: { elements: [{ inlineObjectElement: { inlineObjectId: 'image' } }] } }],
      },
    },
    {
      ...plain,
      body: {
        content: [
          { paragraph: { elements: [{ textRun: { content: 'Styled', textStyle: { bold: true } } }] } },
        ],
      },
    },
    { ...plain, tabs: [{}, {}] },
    { ...plain, suggestedDocumentStyleChanges: {} },
    { ...plain, body: { content: [paragraph, { sectionBreak: {}, endIndex: 9 }] } },
    {},
  ])
    expect(googleFileEditability('doc', source).editable).toBe(false);
  expect(googleFileEditability('sheet', {}).editable).toBe(false);
  expect(googleFileEditability('deck', {}).editable).toBe(false);
});
test('unsafe documents and missing version metadata cause zero provider mutations', async () => {
  for (const [source, version] of [
    [{ ...plain, body: { content: [paragraph, { table: {} }] } }, '9'],
    [{ ...plain, revisionId: undefined }, '9'],
    [plain, undefined],
  ] as const) {
    const writes: string[] = [];
    __setGoogleDocumentDepsForTest({
      getCloudFileAccess: (async () => ({
        connection: { provider: 'google_drive' },
        accessToken: 'fixture',
      })) as any,
      fetch: (async (url: unknown, init?: RequestInit) => {
        if (init?.method && init.method !== 'GET') writes.push(String(url));
        return Response.json(String(url).includes('docs.googleapis.com') ? source : { version });
      }) as any,
    });
    await expect(
      updateGoogleNativeFile({
        userId: 'owner',
        connectionId: 'drive',
        fileId: 'doc',
        kind: 'doc',
        title: 'Edit',
        model: createDefaultDocumentModel('doc'),
        expectedProviderVersion: '9',
      }),
    ).rejects.toThrow();
    expect(writes).toEqual([]);
  }
});

// DOC-1: the document the writer produces must read back as editable, with
// the same block types. This is the shape Docs returns after a save with a
// list, a numbered list, a quote, and a heading.
const quoteColor = { color: { rgbColor: { red: 0x52 / 255, green: 0x60 / 255, blue: 0x6d / 255 } } };
const written = {
  revisionId: 'revision-2',
  lists: {
    'kix.bullets': { listProperties: { nestingLevels: [{ glyphSymbol: '●', indentStart: {} }] } },
    'kix.numbers': { listProperties: { nestingLevels: [{ glyphType: 'DECIMAL', glyphFormat: '%0.' }] } },
  },
  body: {
    content: [
      { sectionBreak: {}, endIndex: 1 },
      {
        paragraph: {
          elements: [{ startIndex: 1, endIndex: 7, textRun: { content: 'Title\n', textStyle: {} } }],
          paragraphStyle: { namedStyleType: 'HEADING_1', direction: 'LEFT_TO_RIGHT' },
        },
      },
      {
        paragraph: {
          elements: [{ textRun: { content: 'Milk\n', textStyle: {} } }],
          paragraphStyle: {
            namedStyleType: 'NORMAL_TEXT',
            direction: 'LEFT_TO_RIGHT',
            indentFirstLine: { magnitude: 18, unit: 'PT' },
            indentStart: { magnitude: 36, unit: 'PT' },
          },
          bullet: { listId: 'kix.bullets', textStyle: { underline: false } },
        },
      },
      {
        paragraph: {
          elements: [{ textRun: { content: 'Step one\n' } }],
          paragraphStyle: { namedStyleType: 'NORMAL_TEXT', indentStart: { magnitude: 36, unit: 'PT' } },
          bullet: { listId: 'kix.numbers' },
        },
      },
      {
        paragraph: {
          elements: [
            { textRun: { content: 'Said well', textStyle: { italic: true, foregroundColor: quoteColor } } },
            { textRun: { content: '\n', textStyle: {} } },
          ],
          paragraphStyle: { namedStyleType: 'NORMAL_TEXT', indentStart: { magnitude: 24, unit: 'PT' } },
        },
      },
    ],
  },
};

test('a document the writer saved stays editable and keeps its block types (DOC-1)', async () => {
  expect(googleFileEditability('doc', written)).toEqual({ editable: true });
  const access = (async () => ({ connection: { provider: 'google_drive' }, accessToken: 'fixture' })) as any;
  __setGoogleImportDepsForTest({
    getCloudFileAccess: access,
    fetch: (async (url: unknown) =>
      Response.json(
        String(url).includes('docs.googleapis.com') ? written : { name: 'Memo', version: '3' },
      )) as any,
  });
  const imported = await importGoogleNativeFile({
    userId: 'owner',
    connectionId: 'drive',
    fileId: 'doc',
    mimeType: 'application/vnd.google-apps.document',
  });
  if (imported.model.kind !== 'doc') throw new Error('Expected document');
  expect(imported.model.blocks.map((block) => [block.type, block.text])).toEqual([
    ['heading', 'Title'],
    ['bullet', 'Milk'],
    ['numbered', 'Step one'],
    ['quote', 'Said well'],
  ]);
});

test('lists and quotes outside the writer subset stay preview only', () => {
  const withParagraph = (paragraph: any) => ({ ...written, body: { content: [{ paragraph }] } });
  const nested = withParagraph({
    elements: [{ textRun: { content: 'Deep\n' } }],
    bullet: { listId: 'kix.bullets', nestingLevel: 1 },
  });
  const unknownList = withParagraph({
    elements: [{ textRun: { content: 'x\n' } }],
    bullet: { listId: 'missing' },
  });
  const boldQuote = withParagraph({
    elements: [
      { textRun: { content: 'Loud', textStyle: { bold: true, italic: true, foregroundColor: quoteColor } } },
    ],
    paragraphStyle: { indentStart: { magnitude: 24, unit: 'PT' } },
  });
  const otherIndent = withParagraph({
    elements: [{ textRun: { content: 'x', textStyle: { italic: true, foregroundColor: quoteColor } } }],
    paragraphStyle: { indentStart: { magnitude: 48, unit: 'PT' } },
  });
  const plainIndent = withParagraph({
    elements: [{ textRun: { content: 'x\n' } }],
    paragraphStyle: { indentStart: { magnitude: 24, unit: 'PT' } },
  });
  const hanging = withParagraph({
    elements: [{ textRun: { content: 'x\n' } }],
    paragraphStyle: { indentFirstLine: { magnitude: 24, unit: 'PT' } },
  });
  for (const source of [nested, unknownList, boldQuote, otherIndent, plainIndent, hanging])
    expect(googleFileEditability('doc', source).editable).toBe(false);
});

test('a linked spreadsheet or deck never offers Sync Google (DOC-3)', () => {
  expect(googleLinkedFileSyncLimitation('deck', { fileId: 'g1' })).toBe(LINKED_GOOGLE_FILE_SYNC_LIMITATION);
  expect(googleLinkedFileSyncLimitation('sheet', { fileId: 'g1' })).toBe(LINKED_GOOGLE_FILE_SYNC_LIMITATION);
  expect(googleLinkedFileSyncLimitation('doc', { fileId: 'g1' })).toBeNull();
  expect(googleLinkedFileSyncLimitation('deck', undefined)).toBeNull();
});

// --- Rich mode: inline formatting, links, nested lists, title and subtitle. ---

const LINK_BLUE = { color: { rgbColor: { red: 0.06666667, green: 0.33333334, blue: 0.8 } } };
const NAMED_STYLES = {
  styles: [
    {
      namedStyleType: 'NORMAL_TEXT',
      textStyle: {
        bold: false,
        italic: false,
        underline: false,
        strikethrough: false,
        smallCaps: false,
        backgroundColor: {},
        foregroundColor: { color: { rgbColor: {} } },
        fontSize: { magnitude: 11, unit: 'PT' },
        weightedFontFamily: { fontFamily: 'Arial', weight: 400 },
        baselineOffset: 'NONE',
      },
      paragraphStyle: {
        namedStyleType: 'NORMAL_TEXT',
        alignment: 'START',
        lineSpacing: 115,
        direction: 'LEFT_TO_RIGHT',
        spacingMode: 'COLLAPSE_LISTS',
        spaceAbove: { unit: 'PT' },
        spaceBelow: { unit: 'PT' },
        keepLinesTogether: false,
        keepWithNext: false,
        avoidWidowAndOrphan: true,
      },
    },
    {
      namedStyleType: 'HEADING_1',
      textStyle: { fontSize: { magnitude: 20, unit: 'PT' } },
      paragraphStyle: {
        namedStyleType: 'HEADING_1',
        direction: 'LEFT_TO_RIGHT',
        spaceAbove: { magnitude: 20, unit: 'PT' },
        spaceBelow: { magnitude: 6, unit: 'PT' },
        keepLinesTogether: true,
        keepWithNext: true,
      },
    },
  ],
};

/** A paragraph as documents.get returns it, with indexes counted from `start`. */
function docParagraph(
  start: number,
  runs: Array<[string, Record<string, unknown>?]>,
  paragraphStyle: any = {},
) {
  let cursor = start;
  const elements = runs.map(([content, textStyle = {}]) => {
    const element = {
      startIndex: cursor,
      endIndex: cursor + content.length,
      textRun: { content, textStyle },
    };
    cursor += content.length;
    return element;
  });
  return {
    startIndex: start,
    endIndex: cursor,
    paragraph: {
      elements,
      paragraphStyle: { namedStyleType: 'NORMAL_TEXT', direction: 'LEFT_TO_RIGHT', ...paragraphStyle },
    },
  };
}

function docJson(paragraphs: Array<(start: number) => any>, tab: Record<string, unknown> = {}) {
  const content: any[] = [
    {
      endIndex: 1,
      sectionBreak: { sectionStyle: { columnSeparatorStyle: 'NONE', contentDirection: 'LEFT_TO_RIGHT' } },
    },
  ];
  let cursor = 1;
  for (const make of paragraphs) {
    const item = make(cursor);
    content.push(item);
    cursor = item.endIndex;
  }
  return {
    documentId: 'doc-brief',
    title: 'Project brief',
    revisionId: 'ALBJ4Ls-revision-1',
    suggestionsViewMode: 'SUGGESTIONS_INLINE',
    tabs: [
      {
        tabProperties: { tabId: 't.0', index: 0 },
        documentTab: { body: { content }, namedStyles: NAMED_STYLES, ...tab },
      },
    ],
  };
}

/** The test Doc "Project brief": a heading and three paragraphs with inline formatting. */
const projectBrief = () =>
  docJson([
    (start) =>
      docParagraph(start, [['Project brief\n']], { headingId: 'h.4x2kq1', namedStyleType: 'HEADING_1' }),
    (start) =>
      docParagraph(start, [
        ['We launch the pilot in '],
        ['October', { bold: true }],
        [' with '],
        ['three teams', { italic: true }],
        ['.\n'],
      ]),
    (start) =>
      docParagraph(start, [
        ['See the '],
        ['plan', { underline: true, foregroundColor: LINK_BLUE, link: { url: 'https://example.com/plan' } }],
        [' for dates.\n'],
      ]),
    (start) =>
      docParagraph(start, [
        ['Budget is '],
        ['$40k', { bold: true, italic: true }],
        [', not '],
        ['$30k', { strikethrough: true }],
        ['.\n', { bold: false }],
      ]),
  ]);

test('the Project brief Doc opens editable in the rich editor and keeps its formatting', async () => {
  expect(googleFileEditability('doc', projectBrief(), 'rich')).toEqual({ editable: true });
  const access = (async () => ({ connection: { provider: 'google_drive' }, accessToken: 'fixture' })) as any;
  const urls: string[] = [];
  __setGoogleImportDepsForTest({
    getCloudFileAccess: access,
    fetch: (async (url: unknown) => {
      urls.push(String(url));
      if (String(url).includes('/comments?')) return Response.json({ comments: [] });
      return Response.json(
        String(url).includes('docs.googleapis.com')
          ? projectBrief()
          : { name: 'Project brief', version: '4' },
      );
    }) as any,
  });
  const imported = await importGoogleNativeFile({
    userId: 'owner',
    connectionId: 'drive',
    fileId: 'doc-brief',
    mimeType: 'application/vnd.google-apps.document',
    mode: 'rich',
  });
  expect(urls).toContain('https://docs.googleapis.com/v1/documents/doc-brief?includeTabsContent=true');
  expect(imported.editability).toEqual({ editable: true });
  if (imported.model.kind !== 'doc') throw new Error('Expected document');
  expect(imported.model.blocks.map(({ id: _id, ...block }) => block)).toEqual([
    { type: 'heading', level: 1, text: 'Project brief' },
    {
      type: 'paragraph',
      text: 'We launch the pilot in October with three teams.',
      runs: [
        { text: 'We launch the pilot in ' },
        { text: 'October', bold: true },
        { text: ' with ' },
        { text: 'three teams', italic: true },
        { text: '.' },
      ],
    },
    {
      type: 'paragraph',
      text: 'See the plan for dates.',
      runs: [
        { text: 'See the ' },
        { text: 'plan', link: 'https://example.com/plan' },
        { text: ' for dates.' },
      ],
    },
    {
      type: 'paragraph',
      text: 'Budget is $40k, not $30k.',
      runs: [
        { text: 'Budget is ' },
        { text: '$40k', bold: true, italic: true },
        { text: ', not ' },
        { text: '$30k', strike: true },
        { text: '.' },
      ],
    },
  ]);
});

test('a client without the rich editor gets the same Doc as a preview with a named reason', () => {
  expect(googleFileEditability('doc', projectBrief())).toEqual({
    editable: false,
    reason:
      'Preview only: this Doc has text formatting and links. Albatross cannot edit these safely here. Open the original in Google to edit it.',
  });
  expect(googleFileEditability('sheet', {}, 'rich').reason).toContain('Preview only');
});

test('each unsupported part of a Doc keeps it a preview and is named in the notice', () => {
  const text = (start: number) => docParagraph(start, [['Body\n']]);
  const withElement = (element: Record<string, unknown>) => (start: number) => ({
    startIndex: start,
    endIndex: start + 6,
    paragraph: {
      elements: [
        { startIndex: start, endIndex: start + 1, ...element },
        { startIndex: start + 1, endIndex: start + 6, textRun: { content: 'Body\n', textStyle: {} } },
      ],
      paragraphStyle: { namedStyleType: 'NORMAL_TEXT' },
    },
  });
  const styled = (textStyle: Record<string, unknown>) => (start: number) =>
    docParagraph(start, [['Body', textStyle], ['\n']]);
  const paragraphStyled = (paragraphStyle: Record<string, unknown>) => (start: number) =>
    docParagraph(start, [['Body\n']], paragraphStyle);
  const cases: Array<[unknown, string]> = [
    [docJson([text, (start) => ({ startIndex: start, endIndex: start + 10, table: {} })]), 'tables'],
    [docJson([withElement({ inlineObjectElement: { inlineObjectId: 'kix.image' } })]), 'images or drawings'],
    [docJson([withElement({ pageBreak: {} })]), 'page breaks'],
    [docJson([withElement({ footnoteReference: { footnoteId: 'kix.fn' } })]), 'footnotes'],
    [docJson([withElement({ equation: {} })]), 'equations'],
    [docJson([withElement({ horizontalRule: {} })]), 'horizontal lines'],
    [docJson([withElement({ person: { personProperties: { email: 'a@b.c' } } })]), 'smart chips'],
    [docJson([withElement({ autoText: { type: 'PAGE_NUMBER' } })]), 'page numbers or other automatic text'],
    [docJson([text], { namedRanges: { budget: { name: 'budget', namedRanges: [] } } }), 'named ranges'],
    [
      {
        ...docJson([text]),
        tabs: [...docJson([text]).tabs, { tabProperties: { tabId: 't.1' }, documentTab: {} }],
      },
      'more than one tab',
    ],
    [{ ...docJson([text]), tabs: [{ ...docJson([text]).tabs[0], childTabs: [{}] }] }, 'more than one tab'],
    [
      docJson([
        (start) => {
          const item = docParagraph(start, [['Body\n']]);
          (item.paragraph.elements[0].textRun as any).suggestedInsertionIds = ['suggest.1'];
          return item;
        },
      ]),
      'suggested edits',
    ],
    [docJson([styled({ weightedFontFamily: { fontFamily: 'Arial', weight: 700 } })]), 'fonts'],
    [docJson([styled({ foregroundColor: { color: { rgbColor: { red: 1 } } } })]), 'text colors'],
    [
      docJson([styled({ backgroundColor: { color: { rgbColor: { red: 1, green: 1 } } } })]),
      'highlight colors',
    ],
    [docJson([styled({ fontSize: { magnitude: 18, unit: 'PT' } })]), 'font sizes'],
    [docJson([styled({ weightedFontFamily: { fontFamily: 'Lobster', weight: 400 } })]), 'fonts'],
    [docJson([styled({ baselineOffset: 'SUPERSCRIPT' })]), 'superscript or subscript text'],
    [docJson([styled({ smallCaps: true })]), 'small caps'],
    [docJson([styled({ link: { headingId: 'h.abc' } })]), 'links to places in the document'],
    [docJson([styled({ link: { url: 'ftp://example.com/file' } })]), 'links that Albatross cannot keep'],
    [docJson([paragraphStyled({ alignment: 'CENTER' })]), 'paragraph alignment, spacing or indents'],
    [docJson([paragraphStyled({ namedStyleType: 'HEADING_4' })]), 'headings below level 3'],
    [docJson([paragraphStyled({ direction: 'RIGHT_TO_LEFT' })]), 'right-to-left text'],
    [docJson([paragraphStyled({ pageBreakBefore: true })]), 'page breaks'],
    [
      docJson([paragraphStyled({ shading: { backgroundColor: { color: { rgbColor: { red: 1 } } } } })]),
      'paragraph borders or shading',
    ],
  ];
  for (const [source, reason] of cases) {
    const permission = googleFileEditability('doc', source, 'rich');
    expect({ reason, editable: permission.editable }).toEqual({ reason, editable: false });
    expect(permission.reason).toContain(reason);
    expect(permission.reason).not.toMatch(/\bAI\b/u);
  }
  // A suggestion anywhere in the Doc is also named.
  const suggested = docJson([text]);
  (suggested.tabs[0].documentTab as any).suggestedDocumentStyleChanges = { s1: {} };
  expect(googleFileEditability('doc', suggested, 'rich').reason).toContain('suggested edits');
});

test('values that only repeat the named style are not formatting', () => {
  const echoed = docJson([
    (start) =>
      docParagraph(
        start,
        [
          [
            'Pasted text',
            {
              fontSize: { magnitude: 11, unit: 'PT' },
              weightedFontFamily: { fontFamily: 'Arial', weight: 400 },
              foregroundColor: { color: { rgbColor: {} } },
              backgroundColor: {},
              baselineOffset: 'NONE',
              underline: false,
            },
          ],
          ['\n'],
        ],
        { lineSpacing: 115, spaceAbove: { unit: 'PT' }, alignment: 'START' },
      ),
  ]);
  const projection = projectGoogleDoc(echoed, 'plain');
  expect(projection.reasons).toEqual([]);
  expect(projection.paragraphs[0].redundantKeys).toEqual(['lineSpacing', 'spaceAbove', 'alignment']);
  expect(projection.paragraphs[0].block).toEqual({ type: 'paragraph', text: 'Pasted text' });
  // A heading change resets those repeated values, so the paragraph takes the heading's values.
  const requests = googleDocUpdateRequests(
    projection,
    googleDocTarget([{ id: 'h', type: 'heading', level: 1, text: 'Pasted text' }]),
  );
  expect(requests[0]).toEqual({
    updateParagraphStyle: {
      range: { startIndex: 1, endIndex: 13 },
      paragraphStyle: { namedStyleType: 'HEADING_1' },
      fields: 'namedStyleType,lineSpacing,spaceAbove,alignment',
    },
  });
  expect(requests[1]).toEqual({
    updateTextStyle: { range: { startIndex: 1, endIndex: 12 }, textStyle: {}, fields: '*' },
  });
});

test('title, subtitle and nested lists read in rich mode only', () => {
  const lists = {
    'kix.n': {
      listProperties: {
        nestingLevels: [
          { glyphType: 'DECIMAL', glyphFormat: '%0.' },
          { glyphType: 'ALPHA', glyphFormat: '%1.' },
          { glyphType: 'ROMAN', glyphFormat: '%2.' },
        ],
      },
    },
    'kix.check': { listProperties: { nestingLevels: [{ glyphSymbol: '❏' }] } },
  };
  const source = docJson(
    [
      (start) => docParagraph(start, [['Plan\n']], { namedStyleType: 'TITLE' }),
      (start) => docParagraph(start, [['Second draft\n']], { namedStyleType: 'SUBTITLE' }),
      (start) => ({
        ...docParagraph(start, [['Step\n']], { indentStart: { magnitude: 36, unit: 'PT' } }),
        paragraph: {
          ...docParagraph(start, [['Step\n']]).paragraph,
          bullet: { listId: 'kix.n', textStyle: { underline: false } },
        },
      }),
      (start) => ({
        ...docParagraph(start, [['Detail\n']]),
        paragraph: {
          ...docParagraph(start, [['Detail\n']]).paragraph,
          bullet: { listId: 'kix.n', nestingLevel: 1 },
        },
      }),
    ],
    { lists },
  );
  const rich = projectGoogleDoc(source, 'rich');
  expect(rich.reasons).toEqual([]);
  expect(rich.paragraphs.map((paragraph) => paragraph.block)).toEqual([
    { type: 'heading', level: 1, variant: 'title', text: 'Plan' },
    { type: 'heading', level: 2, variant: 'subtitle', text: 'Second draft' },
    { type: 'numbered', text: 'Step' },
    { type: 'numbered', text: 'Detail', listLevel: 1 },
  ]);
  expect(projectGoogleDoc(source, 'plain').reasons).toEqual(['title or subtitle styles', 'nested lists']);
  const checklist = docJson(
    [
      (start) => ({
        ...docParagraph(start, [['Todo\n']]),
        paragraph: { ...docParagraph(start, [['Todo\n']]).paragraph, bullet: { listId: 'kix.check' } },
      }),
    ],
    { lists },
  );
  expect(projectGoogleDoc(checklist, 'rich').reasons).toEqual(['checklists']);
});

test('open comments keep a Doc a preview; resolved ones do not', async () => {
  const access = (async () => ({ connection: { provider: 'google_drive' }, accessToken: 'fixture' })) as any;
  const open = async (comments: unknown, status = 200) => {
    __setGoogleImportDepsForTest({
      getCloudFileAccess: access,
      fetch: (async (url: unknown) => {
        if (String(url).includes('/comments?')) return Response.json(comments, { status });
        return Response.json(String(url).includes('docs.googleapis.com') ? projectBrief() : { version: '4' });
      }) as any,
    });
    return (
      await importGoogleNativeFile({
        userId: 'owner',
        connectionId: 'drive',
        fileId: 'doc-brief',
        mimeType: 'application/vnd.google-apps.document',
        mode: 'rich',
      })
    ).editability;
  };
  expect(await open({ comments: [{ resolved: false, anchor: 'kix.anchor' }] })).toEqual({
    editable: false,
    reason:
      'Preview only: this Doc has open comments. Albatross cannot edit this safely here. Open the original in Google to edit it.',
  });
  expect(await open({ comments: [{ resolved: true, anchor: 'kix.anchor' }, { resolved: false }] })).toEqual({
    editable: true,
  });
  expect((await open({}, 403)).reason).toContain('comments that Albatross cannot check');
});

test('the comment check reads every page and stops at a limit', async () => {
  let pages = 0;
  expect(
    await googleDocHasOpenComments(async () => {
      pages += 1;
      return pages < 3
        ? { comments: [{ resolved: true, anchor: 'a' }], nextPageToken: `p${pages}` }
        : { comments: [] };
    }, 'doc'),
  ).toBe(false);
  expect(pages).toBe(3);
  expect(await googleDocHasOpenComments(async () => ({ comments: [], nextPageToken: 'more' }), 'doc')).toBe(
    true,
  );
});

describe('the writer stays safe against Google', () => {
  const access = (async () => ({ connection: { provider: 'google_drive' }, accessToken: 'fixture' })) as any;
  const brief = () =>
    new GoogleDocsSimulator([
      { text: 'Project brief', paragraphStyle: { namedStyleType: 'HEADING_1' } },
      {
        text: 'Launch in October.',
        runs: [{ text: 'Launch in ' }, { text: 'October', style: { bold: true } }, { text: '.' }],
      },
    ]);
  const save = (google: ReturnType<typeof simulatorFetch>, model: unknown) =>
    updateGoogleNativeFile({
      userId: 'owner',
      connectionId: 'drive',
      fileId: 'doc-1',
      kind: 'doc',
      title: 'Project brief',
      model,
      expectedProviderVersion: google.version(),
      mode: 'rich',
    });
  const editedModel = (doc: GoogleDocsSimulator) => {
    const model = googleDocModel(projectGoogleDoc(doc.toJson(), 'rich'));
    if (model.kind !== 'doc') throw new Error('Expected document');
    model.blocks[1] = {
      ...model.blocks[1],
      text: 'Launch in late October.',
      runs: [{ text: 'Launch in ' }, { text: 'late October', bold: true }, { text: '.' }],
    };
    return model;
  };

  test('a save with formatting keeps the bold run and is checked after the write', async () => {
    const doc = brief();
    const google = simulatorFetch(doc);
    __setGoogleDocumentDepsForTest({ getCloudFileAccess: access, fetch: google.fetch });
    const saved = await save(google, editedModel(doc));
    expect(saved.providerVersion).toBe('10');
    const reads = google.calls.filter(
      (call) => call.url.includes('docs.googleapis.com') && call.method === 'GET',
    );
    expect(reads).toHaveLength(2);
    const after = projectGoogleDoc(doc.toJson(), 'rich');
    expect(after.paragraphs[1].block.runs).toEqual([
      { text: 'Launch in ' },
      { text: 'late October', bold: true },
      { text: '.' },
    ]);
  });

  test('a save that Google does not keep is corrected once, then reported', async () => {
    const doc = brief();
    doc.ignore.add('updateTextStyle');
    const google = simulatorFetch(doc);
    __setGoogleDocumentDepsForTest({ getCloudFileAccess: access, fetch: google.fetch });
    await expect(save(google, editedModel(doc))).rejects.toBeInstanceOf(GoogleDocumentSaveMismatchError);
    expect(google.calls.filter((call) => call.url.endsWith(':batchUpdate'))).toHaveLength(2);
  });

  test('an edit in Google between the read and the write is a conflict, not an overwrite', async () => {
    const doc = brief();
    const google = simulatorFetch(doc);
    const fetch = (async (url: unknown, init?: RequestInit) => {
      if (String(url).endsWith(':batchUpdate')) doc.revision += 1;
      return google.fetch(url as any, init);
    }) as typeof globalThis.fetch;
    __setGoogleDocumentDepsForTest({ getCloudFileAccess: access, fetch });
    await expect(save(google, editedModel(doc))).rejects.toBeInstanceOf(GoogleDocumentConflictError);
    expect(doc.text()[1]).toBe('Launch in October.');
  });

  test('an edit in Google just after the write is a conflict, not corrected over', async () => {
    const doc = brief();
    const google = simulatorFetch(doc);
    let wrote = false;
    const fetch = (async (url: unknown, init?: RequestInit) => {
      if (String(url).endsWith(':batchUpdate')) wrote = true;
      else if (wrote && String(url).includes('docs.googleapis.com')) {
        doc.insertText(1, 'Shared ');
        doc.revision += 1;
        wrote = false;
      }
      return google.fetch(url as any, init);
    }) as typeof globalThis.fetch;
    __setGoogleDocumentDepsForTest({ getCloudFileAccess: access, fetch });
    await expect(save(google, editedModel(doc))).rejects.toBeInstanceOf(GoogleDocumentConflictError);
    expect(google.calls.filter((call) => call.url.endsWith(':batchUpdate'))).toHaveLength(1);
    expect(doc.text()[0]).toBe('Shared Project brief');
  });

  test('a revision that Google changes on its own is still a save when the Doc matches', async () => {
    const doc = brief();
    const google = simulatorFetch(doc);
    let wrote = false;
    const fetch = (async (url: unknown, init?: RequestInit) => {
      if (String(url).endsWith(':batchUpdate')) wrote = true;
      else if (wrote && String(url).includes('docs.googleapis.com')) {
        doc.revision += 1;
        wrote = false;
      }
      return google.fetch(url as any, init);
    }) as typeof globalThis.fetch;
    __setGoogleDocumentDepsForTest({ getCloudFileAccess: access, fetch });
    await save(google, editedModel(doc));
    expect(google.calls.filter((call) => call.url.endsWith(':batchUpdate'))).toHaveLength(1);
    expect(doc.text()[1]).toBe('Launch in late October.');
  });

  test('a Doc with an open comment is not written', async () => {
    const doc = brief();
    const google = simulatorFetch(doc, { comments: [{ resolved: false, anchor: 'kix.a' }] });
    __setGoogleDocumentDepsForTest({ getCloudFileAccess: access, fetch: google.fetch });
    await expect(save(google, editedModel(doc))).rejects.toThrow('open comments');
    expect(google.calls.some((call) => call.url.endsWith(':batchUpdate'))).toBe(false);
  });

  test('a plain client cannot save over a Doc that has formatting', async () => {
    const doc = brief();
    const google = simulatorFetch(doc);
    __setGoogleDocumentDepsForTest({ getCloudFileAccess: access, fetch: google.fetch });
    await expect(
      updateGoogleNativeFile({
        userId: 'owner',
        connectionId: 'drive',
        fileId: 'doc-1',
        kind: 'doc',
        title: 'Project brief',
        model: { kind: 'doc', version: 1, blocks: [{ id: 'p', type: 'paragraph', text: 'Plain' }] },
        expectedProviderVersion: google.version(),
      }),
    ).rejects.toThrow('text formatting');
    expect(google.calls.some((call) => call.url.endsWith(':batchUpdate'))).toBe(false);
  });
});

test('the reader names the rarer parts of a Doc it cannot keep', () => {
  const body = (content: any[], tab: Record<string, unknown> = {}) => ({
    revisionId: 'r',
    body: { content: [{ endIndex: 1, sectionBreak: {} }, ...content] },
    ...tab,
  });
  const text = { paragraph: { elements: [{ textRun: { content: 'Body\n' } }] } };
  const reasonsOf = (source: unknown) => projectGoogleDoc(source, 'rich').reasons;
  expect(reasonsOf(body([text, 'not an element']))).toEqual(['content that Albatross cannot read']);
  expect(reasonsOf(body([text, { endIndex: 20, tableOfContents: {} }]))).toEqual(['a table of contents']);
  expect(reasonsOf(body([{ paragraph: { ...text.paragraph, positionedObjectIds: ['kix.pos'] } }]))).toEqual([
    'positioned images',
  ]);
  expect(reasonsOf(body([{ paragraph: { ...text.paragraph, positionedObjectIds: [] } }]))).toEqual([]);
  expect(reasonsOf(body([{ paragraph: { ...text.paragraph, unknownPart: {} } }]))).toEqual([
    'content that Albatross cannot read',
  ]);
  const lists = { 'kix.l': { listProperties: { nestingLevels: [{ glyphSymbol: '●' }] } } };
  expect(
    reasonsOf(
      body(
        [
          {
            paragraph: {
              ...text.paragraph,
              bullet: { listId: 'kix.l', textStyle: { fontSize: { magnitude: 30, unit: 'PT' } } },
            },
          },
        ],
        { lists },
      ),
    ),
  ).toEqual(['list styles that Albatross cannot keep']);
  // A link with its underline taken away is a link style the writer cannot keep.
  const linkRun = (textStyle: Record<string, unknown>) =>
    body([
      {
        paragraph: {
          elements: [
            {
              textRun: { content: 'Site', textStyle: { link: { url: 'https://example.com' }, ...textStyle } },
            },
            { textRun: { content: '\n' } },
          ],
        },
      },
    ]);
  expect(reasonsOf(linkRun({ underline: false }))).toEqual(['links that Albatross cannot keep']);
  expect(reasonsOf(linkRun({ underline: true }))).toEqual([]);
  // Plain text that is not underlined in a Doc whose normal text is underlined.
  expect(
    projectGoogleDoc(
      {
        ...body([
          {
            paragraph: {
              elements: [
                { textRun: { content: 'Plain', textStyle: { underline: false } } },
                { textRun: { content: '\n' } },
              ],
            },
          },
        ]),
        namedStyles: {
          styles: [{ namedStyleType: 'NORMAL_TEXT', textStyle: { underline: true, bold: true } }],
        },
      },
      'rich',
    ).reasons,
  ).toEqual(['text styles that Albatross cannot keep']);
  // Two runs that differ only in a repeated default read as one run.
  const merged = projectGoogleDoc(
    body([
      {
        paragraph: {
          elements: [
            { textRun: { content: 'Bold', textStyle: { bold: true } } },
            {
              textRun: {
                content: ' too',
                textStyle: { bold: true, fontSize: { magnitude: 11, unit: 'PT' } },
              },
            },
            { textRun: { content: '\n' } },
          ],
        },
      },
    ]),
    'rich',
  );
  expect(merged.paragraphs[0].block.runs).toEqual([{ text: 'Bold too', bold: true }]);
  expect(() => assertGoogleFileEditable('doc', body([text, { table: {} }]), 'rich')).toThrow('tables');
  expect(() => assertGoogleFileEditable('doc', body([text]))).not.toThrow();
});

test('a list joins its neighbor only with the preset that makes the same glyphs', () => {
  const list = (levels: Array<Record<string, string>>) => ({ listProperties: { nestingLevels: levels } });
  const numbered = (types: string[], format = '%0.') =>
    list(types.map((glyphType, index) => ({ glyphType, glyphFormat: index ? `%${index}.` : format })));
  expect(googleListPreset(numbered(['DECIMAL', 'DECIMAL', 'DECIMAL']), 'numbered')).toBe(
    'NUMBERED_DECIMAL_NESTED',
  );
  expect(googleListPreset(numbered(['DECIMAL', 'ALPHA', 'ROMAN'], '%0)'), 'numbered')).toBe(
    'NUMBERED_DECIMAL_ALPHA_ROMAN_PARENS',
  );
  expect(googleListPreset(numbered(['UPPER_ALPHA', 'ALPHA', 'ROMAN']), 'numbered')).toBe(
    'NUMBERED_UPPERALPHA_ALPHA_ROMAN',
  );
  expect(googleListPreset(numbered(['UPPER_ROMAN', 'UPPER_ALPHA', 'DECIMAL']), 'numbered')).toBe(
    'NUMBERED_UPPERROMAN_UPPERALPHA_DECIMAL',
  );
  expect(googleListPreset(numbered(['ZERO_DECIMAL', 'ALPHA', 'ROMAN']), 'numbered')).toBe(
    'NUMBERED_ZERODECIMAL_ALPHA_ROMAN',
  );
  expect(googleListPreset(numbered(['ROMAN', 'ROMAN', 'ROMAN']), 'numbered')).toBeNull();
  const bullets = (symbols: string[]) => list(symbols.map((glyphSymbol) => ({ glyphSymbol })));
  expect(googleListPreset(bullets(['★', '○', '■']), 'bullet')).toBe('BULLET_STAR_CIRCLE_SQUARE');
  expect(googleListPreset(bullets(['■', '■', '■']), 'bullet')).toBeNull();
  expect(googleListPreset(bullets(['?', '■', '■']), 'bullet')).toBeNull();
  expect(googleListPreset(list([]), 'bullet')).toBeNull();
  expect(normalizeLink('not a url')).toBe('not a url');
  expect(normalizeLink('https://example.com')).toBe('https://example.com/');
});

test('Google read failures become clear messages', async () => {
  const access = (async () => ({ connection: { provider: 'google_drive' }, accessToken: 'fixture' })) as any;
  const open = (fetch: unknown) => {
    __setGoogleImportDepsForTest({ getCloudFileAccess: access, fetch: fetch as any });
    return importGoogleNativeFile({
      userId: 'owner',
      connectionId: 'drive',
      fileId: 'doc',
      mimeType: 'application/vnd.google-apps.document',
    });
  };
  await expect(open(async () => Response.json({}, { status: 404 }))).rejects.toThrow('was not found');
  await expect(
    open(async () => Response.json({ error: { message: 'Backend error' } }, { status: 500 })),
  ).rejects.toThrow('Backend error');
  await expect(open(async () => new Response('nope', { status: 500 }))).rejects.toThrow(
    'Google could not open this file.',
  );
  await expect(
    open(async () => {
      throw Object.assign(new Error('slow'), { name: 'TimeoutError' });
    }),
  ).rejects.toThrow('timed out');
  await expect(
    open(async () => {
      throw new Error('offline');
    }),
  ).rejects.toThrow('offline');
});
