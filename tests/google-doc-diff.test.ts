import { describe, expect, test } from 'bun:test';
import { effectiveRuns } from '../components/files/editors/doc-rich-text';
import {
  commonPrefixLength,
  commonSuffixLength,
  GOOGLE_LIST_TAB_MESSAGE,
  googleDocTarget,
  googleDocUpdateRequests,
} from '../lib/documents/google-doc-diff';
import { GoogleDocumentFidelityError, projectGoogleDoc } from '../lib/documents/google-fidelity';
import { googleDocModel } from '../lib/documents/google-import';
import type { DocBlock } from '../lib/documents/model';
import { GoogleDocsSimulator, presetList } from './google-docs-simulator';

const LINK_BLUE = { color: { rgbColor: { red: 17 / 255, green: 85 / 255, blue: 204 / 255 } } };

/** "Project brief": a heading, then three paragraphs with inline formatting, a link and a list. */
function projectBrief() {
  return new GoogleDocsSimulator(
    [
      { text: 'Project brief', paragraphStyle: { namedStyleType: 'HEADING_1', headingId: 'h.brief' } },
      {
        text: 'Launch the pilot in October with three teams.',
        runs: [
          { text: 'Launch the pilot in ' },
          { text: 'October', style: { bold: true } },
          { text: ' with ' },
          { text: 'three teams', style: { italic: true, underline: true } },
          { text: '.' },
        ],
      },
      {
        text: 'Read the plan and the old draft.',
        runs: [
          { text: 'Read the ' },
          {
            text: 'plan',
            style: { link: { url: 'https://example.com/plan' }, underline: true, foregroundColor: LINK_BLUE },
          },
          { text: ' and the ' },
          { text: 'old draft', style: { strikethrough: true } },
          { text: '.' },
        ],
      },
      {
        text: 'Run npm test before a release.',
        runs: [
          { text: 'Run ' },
          { text: 'npm test', style: { weightedFontFamily: { fontFamily: 'Roboto Mono', weight: 400 } } },
          { text: ' before a release.' },
        ],
      },
      { text: 'Scope', bullet: { listId: 'kix.list' } },
      { text: 'Pilot teams', bullet: { listId: 'kix.list', nestingLevel: 1 } },
      { text: 'Dates', bullet: { listId: 'kix.list' } },
    ],
    { 'kix.list': presetList('BULLET_DISC_CIRCLE_SQUARE') },
  );
}

function modelOf(doc: GoogleDocsSimulator) {
  const projection = projectGoogleDoc(doc.toJson(), 'rich');
  expect(projection.reasons).toEqual([]);
  const model = googleDocModel(projection);
  if (model.kind !== 'doc') throw new Error('Expected a doc');
  return model;
}

/** Writes the model with the diff, then reads the Doc back. */
function save(doc: GoogleDocsSimulator, blocks: DocBlock[]) {
  const projection = projectGoogleDoc(doc.toJson(), 'rich');
  const requests = googleDocUpdateRequests(projection, googleDocTarget(blocks));
  const result = doc.batchUpdate({ requests, writeControl: { requiredRevisionId: doc.revisionId } });
  if (result.status !== 200) throw new Error(JSON.stringify(result.body));
  const after = projectGoogleDoc(doc.toJson(), 'rich');
  return { requests, after };
}

/** The blocks as the reader returns them: no ids, equal neighbor runs merged, no runs on plain text. */
const withoutIds = (blocks: readonly DocBlock[]) =>
  blocks.map(({ id: _id, ...block }) => {
    // A link is always underlined in Docs, so the reader does not repeat the underline.
    const runs = block.runs
      ? effectiveRuns({
          ...block,
          runs: block.runs.map(({ underline, ...run }) =>
            run.link || !underline ? run : { ...run, underline },
          ),
        })
      : undefined;
    const { runs: _runs, ...rest } = block;
    return runs ? { ...rest, runs } : rest;
  });

function expectSaved(doc: GoogleDocsSimulator, blocks: DocBlock[]) {
  const { requests, after } = save(doc, blocks);
  expect(after.reasons).toEqual([]);
  expect(after.paragraphs.map((paragraph) => paragraph.block)).toEqual(withoutIds(blocks));
  // The Doc now matches: a second save sends nothing.
  expect(googleDocUpdateRequests(after, googleDocTarget(blocks))).toEqual([]);
  return requests;
}

describe('Google Docs semantic writer', () => {
  test('imports mixed inline styles, a link, code and a nested list', () => {
    const model = modelOf(projectBrief());
    expect(withoutIds(model.blocks)).toEqual([
      { type: 'heading', level: 1, text: 'Project brief' },
      {
        type: 'paragraph',
        text: 'Launch the pilot in October with three teams.',
        runs: [
          { text: 'Launch the pilot in ' },
          { text: 'October', bold: true },
          { text: ' with ' },
          { text: 'three teams', italic: true, underline: true },
          { text: '.' },
        ],
      },
      {
        type: 'paragraph',
        text: 'Read the plan and the old draft.',
        runs: [
          { text: 'Read the ' },
          { text: 'plan', link: 'https://example.com/plan' },
          { text: ' and the ' },
          { text: 'old draft', strike: true },
          { text: '.' },
        ],
      },
      {
        type: 'paragraph',
        text: 'Run npm test before a release.',
        runs: [{ text: 'Run ' }, { text: 'npm test', code: true }, { text: ' before a release.' }],
      },
      { type: 'bullet', text: 'Scope' },
      { type: 'bullet', text: 'Pilot teams', listLevel: 1 },
      { type: 'bullet', text: 'Dates' },
    ]);
  });

  test('a save with no edit sends no request', () => {
    const doc = projectBrief();
    const model = modelOf(doc);
    expect(
      googleDocUpdateRequests(projectGoogleDoc(doc.toJson(), 'rich'), googleDocTarget(model.blocks)),
    ).toEqual([]);
  });

  test('a one-word edit inside a bold run keeps the run bold and touches only that word', () => {
    const doc = projectBrief();
    const model = modelOf(doc);
    const blocks = structuredClone(model.blocks);
    blocks[1].text = 'Launch the pilot in November with three teams.';
    blocks[1].runs![1] = { text: 'November', bold: true };
    const requests = expectSaved(doc, blocks);
    // "Octo|ber" -> "Novem|ber": the shared suffix stays; the start index is after the heading.
    expect(requests).toEqual([
      { deleteContentRange: { range: { startIndex: 35, endIndex: 39 } } },
      { insertText: { location: { index: 35 }, text: 'Novem' } },
      {
        updateTextStyle: {
          range: { startIndex: 35, endIndex: 40 },
          textStyle: { bold: true },
          fields: '*',
        },
      },
    ]);
    expect(doc.text()[1]).toBe('Launch the pilot in November with three teams.');
  });

  test('a link edit changes the address, and new link text gets the link', () => {
    const doc = projectBrief();
    const model = modelOf(doc);
    const blocks = structuredClone(model.blocks);
    blocks[2].text = 'Read the full plan and the old draft.';
    blocks[2].runs = [
      { text: 'Read the ' },
      { text: 'full plan', link: 'https://example.com/plan-v2' },
      { text: ' and the ' },
      { text: 'old draft', strike: true },
      { text: '.' },
    ];
    const requests = expectSaved(doc, blocks);
    const styled = requests.filter((request) => request.updateTextStyle);
    expect(styled).toHaveLength(1);
    expect(styled[0].updateTextStyle.textStyle).toEqual({
      underline: true,
      link: { url: 'https://example.com/plan-v2' },
      foregroundColor: { color: { rgbColor: { red: 17 / 255, green: 85 / 255, blue: 204 / 255 } } },
    });
  });

  test('removing a link and bolding a word are style-only writes', () => {
    const doc = projectBrief();
    const model = modelOf(doc);
    const blocks = structuredClone(model.blocks);
    blocks[2].runs = [{ text: 'Read the plan and the ' }, { text: 'old draft', strike: true }, { text: '.' }];
    blocks[4].runs = [{ text: 'Scope', bold: true }];
    const requests = expectSaved(doc, blocks);
    expect(requests.every((request) => request.updateTextStyle)).toBe(true);
  });

  test('emoji and other surrogate pairs keep correct UTF-16 indexes', () => {
    const doc = new GoogleDocsSimulator([
      {
        text: 'Status 😀 done',
        runs: [{ text: 'Status ' }, { text: '😀', style: { bold: true } }, { text: ' done' }],
      },
      { text: '👩‍💻 team 🚀' },
    ]);
    const model = modelOf(doc);
    const blocks = structuredClone(model.blocks);
    // 😀 is D83D DE00 and 😁 is D83D DE01: the edit must not split the pair.
    blocks[0].text = 'Status 😁 done';
    blocks[0].runs = [{ text: 'Status ' }, { text: '😁', bold: true }, { text: ' done' }];
    blocks[1].text = '👩‍💻 team 🚀 shipped 🎉';
    const requests = expectSaved(doc, blocks);
    // Paragraph 2 starts at 16; "👩‍💻 team 🚀" is 13 code units long.
    expect(requests[0]).toEqual({ insertText: { location: { index: 29 }, text: ' shipped 🎉' } });
    expect(requests).toContainEqual({ deleteContentRange: { range: { startIndex: 8, endIndex: 10 } } });
    expect(requests).toContainEqual({ insertText: { location: { index: 8 }, text: '😁' } });
    expect(doc.text()).toEqual(['Status 😁 done', '👩‍💻 team 🚀 shipped 🎉']);
  });

  test('the shared prefix and suffix never end inside a surrogate pair', () => {
    expect(commonPrefixLength('a😀', 'a😁')).toBe(1);
    expect(commonSuffixLength('😀b', '😁b', 0)).toBe(1);
    expect(commonSuffixLength('x\ude00', 'y\ude00', 0)).toBe(0);
  });

  test('a new item after a list item stays in that list, without a new list', () => {
    const doc = projectBrief();
    const model = modelOf(doc);
    const blocks = structuredClone(model.blocks);
    blocks.splice(6, 0, { id: 'new', type: 'bullet', text: 'Pilot dates', listLevel: 1 });
    const requests = expectSaved(doc, blocks);
    expect(requests.some((request) => request.createParagraphBullets)).toBe(false);
    const listIds = new Set(
      projectGoogleDoc(doc.toJson(), 'rich').paragraphs.flatMap((paragraph) =>
        paragraph.list ? [paragraph.list.listId] : [],
      ),
    );
    expect(listIds.size).toBe(1);
  });

  test('a nesting change and a new list use tabs and createParagraphBullets', () => {
    const doc = projectBrief();
    const model = modelOf(doc);
    const blocks = structuredClone(model.blocks);
    blocks[6].listLevel = 2;
    blocks.push({ id: 'n1', type: 'numbered', text: 'First step' });
    blocks.push({ id: 'n2', type: 'numbered', text: 'Sub step', listLevel: 1 });
    const requests = expectSaved(doc, blocks);
    expect(requests).toContainEqual({
      insertText: { location: { index: expect.any(Number) }, text: '\t\t' },
    });
    expect(
      requests
        .filter((request) => request.createParagraphBullets)
        .map((request) => request.createParagraphBullets.bulletPreset),
    ).toEqual(['BULLET_DISC_CIRCLE_SQUARE', 'NUMBERED_DECIMAL_ALPHA_ROMAN']);
  });

  test('headings, title, subtitle and quotes change with paragraph styles only', () => {
    const doc = projectBrief();
    const model = modelOf(doc);
    const blocks = structuredClone(model.blocks);
    blocks[0] = { ...blocks[0], level: 1, variant: 'title' };
    blocks.splice(1, 0, { id: 'sub', type: 'heading', level: 2, variant: 'subtitle', text: 'Draft two' });
    blocks[4] = { id: blocks[4].id, type: 'quote', text: blocks[4].text };
    blocks[5] = { id: blocks[5].id, type: 'paragraph', text: 'Scope' };
    const requests = expectSaved(doc, blocks);
    expect(requests).toContainEqual({
      updateParagraphStyle: {
        range: { startIndex: 1, endIndex: 15 },
        paragraphStyle: { namedStyleType: 'TITLE' },
        fields: 'namedStyleType',
      },
    });
  });

  test('removing paragraphs, also the last one, never deletes the closing newline', () => {
    const doc = projectBrief();
    const model = modelOf(doc);
    expectSaved(doc, model.blocks.slice(0, 2));
    expect(doc.text()).toEqual(['Project brief', 'Launch the pilot in October with three teams.']);
    expectSaved(doc, [{ id: 'only', type: 'paragraph', text: '' }]);
    expect(doc.text()).toEqual(['']);
    expectSaved(doc, [
      { id: 'a', type: 'heading', level: 2, text: 'Fresh start' },
      { id: 'b', type: 'bullet', text: 'One' },
      { id: 'c', type: 'bullet', text: 'Two', listLevel: 1 },
    ]);
  });

  test('a line break inside a paragraph is written as a vertical tab', () => {
    const doc = new GoogleDocsSimulator([{ text: 'Street 1\u000bCity' }]);
    const model = modelOf(doc);
    expect(model.blocks[0].text).toBe('Street 1\nCity');
    const blocks = structuredClone(model.blocks);
    blocks[0].text = 'Street 1\nCity\nCountry';
    const requests = expectSaved(doc, blocks);
    expect(requests).toEqual([
      { insertText: { location: { index: 14 }, text: '\u000bCountry' } },
      // New text always gets its style set, here the plain default.
      { updateTextStyle: { range: { startIndex: 14, endIndex: 22 }, textStyle: {}, fields: '*' } },
    ]);
  });

  test('characters that Docs removes are left out before the comparison', () => {
    const doc = new GoogleDocsSimulator([{ text: 'Plain' }]);
    const blocks: DocBlock[] = [{ id: 'p', type: 'paragraph', text: 'Plain\r text\u0001' }];
    const { after } = save(doc, blocks);
    expect(after.paragraphs[0].block.text).toBe('Plain text');
    expect(googleDocUpdateRequests(after, googleDocTarget(blocks))).toEqual([]);
  });

  test('a new list item that starts with a tab is refused before any write', () => {
    const doc = new GoogleDocsSimulator([{ text: 'Plain' }]);
    expect(() =>
      googleDocUpdateRequests(
        projectGoogleDoc(doc.toJson(), 'rich'),
        googleDocTarget([{ id: 'b', type: 'bullet', text: '\tIndented' }]),
      ),
    ).toThrow(GOOGLE_LIST_TAB_MESSAGE);
    expect(() => googleDocUpdateRequests({ paragraphs: [], lists: {} }, [])).toThrow(
      GoogleDocumentFidelityError,
    );
  });

  test('a full rewrite of a long Doc pairs paragraphs in order', () => {
    const doc = new GoogleDocsSimulator(
      Array.from({ length: 120 }, (_, index) => ({ text: `Old ${index}` })),
    );
    const blocks: DocBlock[] = Array.from({ length: 101 }, (_, index) => ({
      id: `n${index}`,
      type: index % 10 ? 'paragraph' : 'heading',
      ...(index % 10 ? {} : { level: 2 as const }),
      text: `New line ${index}`,
    }));
    const requests = expectSaved(doc, blocks);
    // The 19 paragraphs with no partner are removed whole; the rest change in place.
    expect(requests.filter((request) => request.deleteContentRange)).toHaveLength(19 + 101);
    expect(doc.text()).toHaveLength(101);
  });

  test('a code edit keeps the font of the code run', () => {
    const doc = projectBrief();
    const model = modelOf(doc);
    const blocks = structuredClone(model.blocks);
    blocks[3].text = 'Run npm test --watch before a release.';
    blocks[3].runs = [
      { text: 'Run ' },
      { text: 'npm test --watch', code: true },
      { text: ' before a release.' },
    ];
    blocks[4].runs = [{ text: 'Scope', code: true }];
    const requests = expectSaved(doc, blocks);
    const fonts = requests
      .filter((request) => request.updateTextStyle?.textStyle.weightedFontFamily)
      .map((request) => request.updateTextStyle.textStyle.weightedFontFamily.fontFamily);
    expect(fonts).toEqual(['Roboto Mono', 'Courier New']);
  });
});

describe('random edits always round-trip', () => {
  // A small seeded generator, so a failure repeats.
  function random(seed: number) {
    let state = seed >>> 0;
    return () => {
      state = (state * 1664525 + 1013904223) >>> 0;
      return state / 2 ** 32;
    };
  }
  const words = ['alpha', 'beta', 'gamma', '😀', 'δέλτα', 'é', 'zeta', '🚀🚀', 'eta', 'theta'];
  const types: DocBlock['type'][] = ['paragraph', 'heading', 'bullet', 'numbered', 'quote'];
  const marks = ['bold', 'italic', 'underline', 'strike', 'code'] as const;

  function randomBlock(next: () => number, id: string): DocBlock {
    const type = types[Math.floor(next() * types.length)];
    const count = Math.floor(next() * 4);
    const runs: NonNullable<DocBlock['runs']> = [];
    for (let index = 0; index < count; index += 1) {
      const run: NonNullable<DocBlock['runs']>[number] = {
        text: `${index ? ' ' : ''}${words[Math.floor(next() * words.length)]}`,
      };
      if (type !== 'quote') {
        if (next() < 0.3) run[marks[Math.floor(next() * marks.length)]] = true;
        if (next() < 0.1) run.link = `https://example.com/${Math.floor(next() * 3)}`;
      }
      runs.push(run);
    }
    const text = runs.map((run) => run.text).join('');
    const block: DocBlock = { id, type, text };
    if (runs.some((run) => Object.keys(run).length > 1)) block.runs = runs;
    if (type === 'heading') {
      block.level = (1 + Math.floor(next() * 3)) as 1 | 2 | 3;
      if (next() < 0.2) block.variant = block.level === 1 ? 'title' : 'subtitle';
      if (block.variant === 'subtitle') block.level = 2;
    }
    if ((type === 'bullet' || type === 'numbered') && next() < 0.4)
      block.listLevel = 1 + Math.floor(next() * 2);
    return block;
  }

  test('300 random saves leave the Doc equal to the model', () => {
    for (let seed = 1; seed <= 300; seed += 1) {
      const next = random(seed);
      const doc = new GoogleDocsSimulator([{ text: '' }]);
      let blocks: DocBlock[] = Array.from({ length: 1 + Math.floor(next() * 5) }, (_, index) =>
        randomBlock(next, `b${index}`),
      );
      for (let round = 0; round < 3; round += 1) {
        try {
          expectSaved(doc, blocks);
        } catch (error) {
          throw new Error(`seed ${seed} round ${round}: ${(error as Error).message}`);
        }
        // Edit: change, insert, remove or move a block.
        blocks = structuredClone(blocks);
        const action = next();
        const at = Math.floor(next() * blocks.length);
        if (action < 0.4) blocks[at] = randomBlock(next, blocks[at].id);
        else if (action < 0.7) blocks.splice(at, 0, randomBlock(next, `n${seed}-${round}`));
        else if (action < 0.85 && blocks.length > 1) blocks.splice(at, 1);
        else blocks.reverse();
      }
    }
  });
});
