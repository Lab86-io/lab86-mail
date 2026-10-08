import { describe, expect, test } from 'bun:test';
import { documentHandoffFor } from '../lib/albatross/document-handoff';
import {
  documentHandoffDetailFixture,
  documentHandoffRunsFixture,
  HOURS_DOCUMENT_ID,
  HOURS_DOCUMENT_PATH,
  hoursDocumentFixture,
} from '../lib/albatross/document-handoff-fixtures';
import { documentTargetOf } from '../lib/albatross/step-run-client';
import { runBlockAction } from '../lib/albatross/thread-view';
import { parseDocumentModel } from '../lib/documents/model';

// The dev harness states /dev/thread-preview?state=checkResult | document read these.
describe('document handoff fixtures', () => {
  const now = Date.UTC(2026, 9, 8, 14, 0, 0);

  test('the plan has three steps and the first one is done', () => {
    const detail = documentHandoffDetailFixture(now);
    expect(detail.work.title).toBe('Send the September hours and invoice to Harbor Design');
    expect(detail.execution.guideSteps.map((step) => step.key)).toEqual([
      'step-find',
      'step-document',
      'step-email',
    ]);
    expect(detail.execution.guideSteps[0].done).toBe(true);
    expect(detail.execution.totalSteps).toBe(3);
  });

  test('the result with nothing to open offers "Mark step done"; the document opens', () => {
    const runs = documentHandoffRunsFixture(now);
    expect(runBlockAction(runs.checkResult)).toEqual({ kind: 'mark_done', label: 'Mark step done' });
    const action = runBlockAction(runs.document);
    expect(action.kind).toBe('next');
    const target = documentTargetOf(HOURS_DOCUMENT_PATH, null);
    expect(target).toEqual({ provider: 'albatross', id: HOURS_DOCUMENT_ID });
    expect(documentHandoffFor([runs.checkResult, runs.document], target!)?.id).toBe(runs.document.id);
  });

  test('the document is a valid Albatross document with blanks to fill in', () => {
    const document = hoursDocumentFixture(now);
    expect(document.documentId).toBe(HOURS_DOCUMENT_ID);
    const model = parseDocumentModel(document.model, 'doc');
    expect(model.kind).toBe('doc');
    if (model.kind === 'doc')
      expect(model.blocks.filter((block) => block.text.includes('__'))).toHaveLength(7);
  });
});
