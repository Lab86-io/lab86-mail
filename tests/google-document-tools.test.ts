import { afterEach, expect, mock, test } from 'bun:test';
import { createDefaultDocumentModel } from '../lib/documents/model';
import {
  __setGoogleDocumentToolDepsForTest,
  googleDocumentEdit,
  googleDocumentGet,
} from '../lib/tools/google-documents';
import { runTool, toolContext } from './tools/harness';

const identity = {
  connectionId: 'drive-1',
  fileId: 'file-1',
  mimeType: 'application/vnd.google-apps.document' as const,
};
const model = createDefaultDocumentModel('doc', 'test');
const file = {
  title: 'Proposal',
  kind: 'doc' as const,
  model,
  providerVersion: '7',
  editability: { editable: true },
};
afterEach(() => __setGoogleDocumentToolDepsForTest());
test('main chat can read the original Google file without importing a copy', async () => {
  const read = mock(async (_input: unknown) => file);
  __setGoogleDocumentToolDepsForTest({ read });
  const result = await runTool(googleDocumentGet.handler, identity, toolContext());
  expect(result.model).toEqual(model);
  expect(read.mock.calls[0][0]).toMatchObject(identity);
});
test('Google edits are review-only and bound to the provider revision', async () => {
  __setGoogleDocumentToolDepsForTest({ read: async () => file });
  const args = {
    ...identity,
    title: 'Revised proposal',
    model,
    expectedProviderVersion: '7',
    summary: 'Tightened the introduction',
  };
  const result = await runTool(googleDocumentEdit.handler, args, toolContext());
  expect(result.status).toBe('proposed');
  expect(result.model).toEqual(model);
  expect(result.openPath).toContain('provider=google_drive');
  await expect(
    runTool(googleDocumentEdit.handler, { ...args, expectedProviderVersion: '6' }, toolContext()),
  ).rejects.toThrow('changed');
});
test('read-only provider content cannot get a false editable proposal', async () => {
  __setGoogleDocumentToolDepsForTest({
    read: async () => ({ ...file, editability: { editable: false, reason: 'Unsupported formatting' } }),
  });
  await expect(
    runTool(
      googleDocumentEdit.handler,
      { ...identity, title: 'Proposal', model, expectedProviderVersion: '7', summary: 'Edit' },
      toolContext(),
    ),
  ).rejects.toThrow('Unsupported formatting');
});
