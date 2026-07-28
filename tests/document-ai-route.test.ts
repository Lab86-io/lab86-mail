import { describe, expect, mock, test } from 'bun:test';
import { NextRequest } from 'next/server';
import { createDocumentAiPost } from '../app/api/documents/[documentId]/ai/route';
import { DocumentGenerationError } from '../lib/documents/ai';
import { createDefaultDocumentModel } from '../lib/documents/model';

describe('document AI route', () => {
  test('maps invalid generated document models to a controlled 502 response', async () => {
    const reportUnexpectedError = mock(() => undefined);
    const post = createDocumentAiPost({
      requireCurrentUser: mock(async () => ({
        userId: 'user-1',
        email: 'person@example.test',
        name: 'Person',
        source: 'clerk',
      })),
      enforceUserRateLimit: mock(async () => ({ ok: true })),
      getDocument: mock(async () => ({
        documentId: 'document-1',
        kind: 'doc',
        title: 'Decision memo',
        model: createDefaultDocumentModel('doc'),
        currentRevision: 2,
        sourceRefs: [],
        suggestions: [],
        createdAt: 1_000,
        updatedAt: 2_000,
      })),
      generateDocumentProposal: mock(async () => {
        throw new DocumentGenerationError('invalid generated model');
      }),
      updateDocument: mock(async () => {
        throw new Error('Update must not run.');
      }),
      createDocumentSuggestion: mock(async () => {
        throw new Error('Suggestion creation must not run.');
      }),
      reportUnexpectedError,
    } as any);

    const response = await post(
      new NextRequest('http://localhost/api/documents/document-1/ai', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ instruction: 'Clarify the recommendation.' }),
      }),
      { params: Promise.resolve({ documentId: 'document-1' }) },
    );

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({
      ok: false,
      error: 'Albatross returned an invalid document edit. Try again.',
    });
    expect(reportUnexpectedError).toHaveBeenCalledWith(
      '[document-ai] Invalid model output:',
      expect.any(DocumentGenerationError),
    );
  });
});
