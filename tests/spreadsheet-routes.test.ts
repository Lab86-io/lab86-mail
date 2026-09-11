import { describe, expect, mock, test } from 'bun:test';
import { NextRequest } from 'next/server';
import { createDocumentAiPost } from '../app/api/documents/[documentId]/ai/route';
import { createDocumentSuggestionPost } from '../app/api/documents/[documentId]/suggestions/[suggestionId]/route';
import { createDefaultDocumentModel } from '../lib/documents/model';
import { applySpreadsheetChanges } from '../lib/documents/spreadsheet-server';
import { changes, suiteCommands } from '../scripts/fixtures/spreadsheet-suite-plan';

const plan = { kind: 'sheet-changes' as const, version: 1 as const, changes, commands: suiteCommands };
const document = () => ({
  documentId: 'suite',
  kind: 'sheet' as const,
  title: 'Monthly commits',
  model: createDefaultDocumentModel('sheet', 'suite'),
  currentRevision: 2,
  createdAt: 0,
  updatedAt: 0,
  sourceRefs: [],
  suggestions: [{ suggestionId: 'proposal', baseRevision: 2, proposedModel: plan }],
});
const request = (body: unknown) =>
  new NextRequest('http://localhost/api/documents/suite/ai', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
const auth = {
  requireCurrentUser: async () => ({ userId: 'owner' }),
  enforceUserRateLimit: async () => ({ ok: true }),
};

describe('spreadsheet HTTP edits', () => {
  test('explicit generated edits save a real chart directly; a competing revision returns conflict', async () => {
    const current = document();
    const save = mock(async (input: any) => ({
      ok: true,
      document: { ...current, model: input.model, currentRevision: 3 },
    }));
    const suggest = mock(async () => ({ ok: true, suggestionId: 'unused' }));
    const deps: any = {
      ...auth,
      getDocument: async () => current,
      generateDocumentProposal: async () => ({
        title: 'Monthly commits',
        summary: 'Add a chart',
        model: plan,
      }),
      updateDocument: save,
      createDocumentSuggestion: suggest,
      reportUnexpectedError: () => {},
    };
    const response = await createDocumentAiPost(deps)(
      request({ mode: 'apply', instruction: 'Add a monthly chart' }),
      { params: Promise.resolve({ documentId: 'suite' }) },
    );
    expect(response.status).toBe(200);
    expect((await response.json()).applied).toBe(true);
    expect(save.mock.calls[0][0]).toMatchObject({
      userId: 'owner',
      expectedRevision: 2,
      model: { kind: 'sheet', version: 2, workbook: { sheets: [{ figures: [{ tag: 'chart' }] }] } },
    });
    expect(suggest).not.toHaveBeenCalled();
    deps.updateDocument = async () => ({ ok: false, code: 'REVISION_CONFLICT' });
    const conflict = await createDocumentAiPost(deps)(request({ mode: 'apply', instruction: 'Add chart' }), {
      params: Promise.resolve({ documentId: 'suite' }),
    });
    expect(conflict.status).toBe(409);
  });

  test('review apply evaluates the stored commands and ignores any supplied browser snapshot', async () => {
    const current = document();
    const apply = mock(async (input: any) => ({
      ok: true,
      document: { ...current, model: input.model, currentRevision: 3 },
    }));
    const deps: any = {
      ...auth,
      getDocument: async () => current,
      applySpreadsheetChanges,
      applyDocumentSuggestion: apply,
      resolveDocumentSuggestion: async () => ({ ok: true }),
    };
    const response = await createDocumentSuggestionPost(deps)(
      request({ decision: 'apply', expectedRevision: 2, model: { untrusted: 'replacement' } }),
      { params: Promise.resolve({ documentId: 'suite', suggestionId: 'proposal' }) },
    );
    expect(response.status).toBe(200);
    expect(apply.mock.calls[0][0].model.workbook.sheets[0].figures).toHaveLength(1);
    expect(apply.mock.calls[0][0].model.untrusted).toBeUndefined();
    current.currentRevision = 3;
    const conflict = await createDocumentSuggestionPost(deps)(
      request({ decision: 'apply', expectedRevision: 3 }),
      { params: Promise.resolve({ documentId: 'suite', suggestionId: 'proposal' }) },
    );
    expect(conflict.status).toBe(409);
    expect(apply).toHaveBeenCalledTimes(1);
  });
});
