import { describe, expect, test } from 'bun:test';
import {
  DOCUMENT_HANDOFF_COPY,
  documentAttachmentContext,
  documentHandoffDetail,
  documentHandoffFor,
  normalizeDocumentAttachment,
  resolveDocumentTarget,
} from '../lib/albatross/document-handoff';
import type { ThreadRunView } from '../lib/albatross/thread-contract';
import { threadRunFixtures } from '../lib/albatross/thread-fixtures';

// Document mode in the thread (docs/albatross-document-handoff.md, D5). Story:
// Albatross made the Harbor Design studio hours invoice and hands it to the
// user to fill in.

const NOW = Date.UTC(2026, 9, 8, 15, 0);
const template = threadRunFixtures(NOW).readyDraft;

function documentRun(over: Partial<ThreadRunView>): ThreadRunView {
  return {
    ...template,
    id: 'run_invoice',
    stepKey: 'step-2',
    stepTitle: 'Fill in the hours invoice',
    summary: 'I made the Harbor Design invoice.',
    next: {
      kind: 'review_document',
      label: 'Fill in hours',
      detail: 'Fill in the months and hours you worked.',
      doneLabel: null,
      allow: null,
      saveSignIn: null,
      allowAnswer: null,
      target: { kind: 'document', id: 'doc_invoice' },
    },
    artifacts: [],
    ...over,
  };
}

describe('documentHandoffFor', () => {
  test('finds the open handoff whose target names the document', () => {
    const run = documentRun({});
    expect(documentHandoffFor([run], { provider: 'albatross', id: 'doc_invoice' })).toBe(run);
  });

  test('a Word target is matched by its link', () => {
    const run = documentRun({
      outcome: 'your_turn',
      next: {
        ...documentRun({}).next!,
        target: { kind: 'document', url: '/?view=files&office=word_invoice' },
      },
    });
    expect(documentHandoffFor([run], { provider: 'office', id: 'word_invoice' })).toBe(run);
  });

  test('a run that made the document matches by its artifact', () => {
    const run = documentRun({
      next: { ...documentRun({}).next!, kind: 'review', target: { kind: 'url', url: 'https://example.com' } },
      artifacts: [
        { kind: 'draft', id: 'doc_invoice', title: 'Not a document' },
        { kind: 'document', id: 'doc_other', title: 'Other' },
        { kind: 'document', title: 'Invoice', url: '/?view=files&office=word_invoice' },
      ],
    });
    expect(documentHandoffFor([run], { provider: 'office', id: 'word_invoice' })).toBe(run);
    expect(documentHandoffFor([run], { provider: 'albatross', id: 'doc_invoice' })).toBeNull();
  });

  test('a handoff with no next action still matches by artifact', () => {
    const run = documentRun({
      next: null,
      artifacts: [{ kind: 'document', id: 'doc_invoice', title: 'Invoice' }],
    });
    expect(documentHandoffFor([run], { provider: 'albatross', id: 'doc_invoice' })).toBe(run);
  });

  test('the newest matching run wins', () => {
    const older = documentRun({ id: 'run_older' });
    const newer = documentRun({ id: 'run_newer' });
    expect(documentHandoffFor([older, newer], { provider: 'albatross', id: 'doc_invoice' })?.id).toBe(
      'run_newer',
    );
  });

  test('ignores done runs, questions, and stopped runs, and returns null with no match', () => {
    const done = documentRun({ id: 'run_done', state: 'done', outcome: 'done' });
    const question = documentRun({ id: 'run_question', outcome: 'needs_answer' });
    const stopped = documentRun({ id: 'run_stopped', outcome: 'stopped' });
    const target = { provider: 'albatross' as const, id: 'doc_invoice' };
    expect(documentHandoffFor([done, question, stopped], target)).toBeNull();
    expect(documentHandoffFor([], target)).toBeNull();
    expect(documentHandoffFor([documentRun({})], { provider: 'albatross', id: 'doc_unknown' })).toBeNull();
  });

  test('skips an older match behind a newer closed run, and finds it', () => {
    const open = documentRun({ id: 'run_open' });
    const closed = documentRun({ id: 'run_closed', state: 'done', outcome: 'done' });
    expect(documentHandoffFor([open, closed], { provider: 'albatross', id: 'doc_invoice' })?.id).toBe(
      'run_open',
    );
  });
});

describe('documentHandoffDetail', () => {
  test('the handoff detail, trimmed, or null', () => {
    expect(documentHandoffDetail(documentRun({}))).toBe('Fill in the months and hours you worked.');
    expect(
      documentHandoffDetail(
        documentRun({ next: { ...documentRun({}).next!, detail: '  Check the rate.  ' } }),
      ),
    ).toBe('Check the rate.');
    expect(
      documentHandoffDetail(documentRun({ next: { ...documentRun({}).next!, detail: '   ' } })),
    ).toBeNull();
    expect(documentHandoffDetail(documentRun({ next: null }))).toBeNull();
    expect(documentHandoffDetail(null)).toBeNull();
  });
});

describe('normalizeDocumentAttachment', () => {
  test('accepts an Albatross or a Word document with a trimmed id', () => {
    expect(
      normalizeDocumentAttachment({ kind: 'document', id: ' doc_invoice ', provider: 'albatross' }),
    ).toEqual({
      kind: 'document',
      id: 'doc_invoice',
      provider: 'albatross',
    });
    expect(normalizeDocumentAttachment({ kind: 'document', id: 'word_invoice', provider: 'office' })).toEqual(
      {
        kind: 'document',
        id: 'word_invoice',
        provider: 'office',
      },
    );
  });

  test('refuses everything else', () => {
    for (const entry of [
      null,
      undefined,
      'document',
      42,
      { kind: 'work', id: 'work-1', provider: 'albatross' },
      { kind: 'document', provider: 'albatross' },
      { kind: 'document', id: 7, provider: 'albatross' },
      { kind: 'document', id: '   ', provider: 'albatross' },
      { kind: 'document', id: 'd'.repeat(201), provider: 'albatross' },
      { kind: 'document', id: 'doc_invoice', provider: 'drive' },
      { kind: 'document', id: 'doc_invoice' },
    ])
      expect(normalizeDocumentAttachment(entry)).toBeNull();
    expect(
      normalizeDocumentAttachment({ kind: 'document', id: 'd'.repeat(200), provider: 'albatross' })?.id,
    ).toHaveLength(200);
  });
});

describe('documentAttachmentContext', () => {
  test('an Albatross document: document_get, document_edit in apply mode, and done: true', () => {
    const text = documentAttachmentContext({ kind: 'document', id: 'doc_invoice', provider: 'albatross' });
    expect(text).toContain('{"id":"doc_invoice","provider":"albatross"}');
    expect(text).toContain('document_get');
    expect(text).toContain('document_edit in mode "apply"');
    expect(text).not.toContain('word_document_edit');
    expect(text).toContain('albatross_handle_step with done: true');
    expect(text).toContain('never invent hours, rates, or amounts');
  });

  test('a Word document: the Word tools, and never document_get', () => {
    const text = documentAttachmentContext({ kind: 'document', id: 'word_invoice', provider: 'office' });
    expect(text).toContain('{"id":"word_invoice","provider":"office"}');
    expect(text).toContain('word_document_get');
    expect(text).toContain('word_document_edit');
    expect(text).toContain('Never pass this id to document_get.');
    expect(text).toContain('albatross_handle_step with done: true');
  });
});

describe('copy', () => {
  test('matches the spec words', () => {
    expect(DOCUMENT_HANDOFF_COPY).toMatchObject({
      yourPart: 'Your part',
      done: 'Done, continue',
      backToThread: 'Back to thread',
      close: 'Close',
      placeholder: 'Tell Albatross what to put in the document',
    });
  });
});

// A run from before the server filled the link named its Word file by id only.
describe('resolveDocumentTarget', () => {
  const files = [
    { kind: 'document', id: 'doc_summary', title: 'Hours summary', url: '/?view=files&document=doc_summary' },
    { kind: 'document', id: 'word_invoice', title: 'Invoice.docx', url: '/?view=files&office=word_invoice' },
    { kind: 'draft', id: 'word_other', title: 'Draft' },
  ];

  test('an id with no link takes the link of the run file with that id', () => {
    expect(resolveDocumentTarget(files, null, 'word_invoice')).toEqual({
      provider: 'office',
      id: 'word_invoice',
    });
    expect(resolveDocumentTarget(files, '  ', 'doc_summary')).toEqual({
      provider: 'albatross',
      id: 'doc_summary',
    });
  });

  test('a link wins; an unknown id or a file of another kind stays an Albatross document', () => {
    expect(resolveDocumentTarget(files, '/?view=files&document=doc_x', 'word_invoice')).toEqual({
      provider: 'albatross',
      id: 'doc_x',
    });
    expect(resolveDocumentTarget(files, null, 'word_other')).toEqual({
      provider: 'albatross',
      id: 'word_other',
    });
    expect(resolveDocumentTarget([], null, null)).toBeNull();
  });

  test('the handoff of a Word file named by id matches document mode for that file', () => {
    const run = documentRun({
      next: { ...documentRun({}).next!, target: { kind: 'document', id: 'word_invoice' } },
      artifacts: files.slice(0, 2) as ThreadRunView['artifacts'],
    });
    expect(documentHandoffFor([run], { provider: 'office', id: 'word_invoice' })).toBe(run);
  });
});
