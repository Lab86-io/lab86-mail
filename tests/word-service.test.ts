import { expect, test } from 'bun:test';
import { AGENT_TOOL_NAMES } from '../lib/ai/loop';
import { TOOL_GROUPS } from '../lib/ai/tool-groups';
import { createDefaultDocumentModel } from '../lib/documents/model';
import type { OfficeFile } from '../lib/documents/office-service';
import { createWordPackage, readWordPackage } from '../lib/documents/word-package';
import { createWordService } from '../lib/documents/word-service';
import { TOOLS } from '../lib/tools';
import { wordDocumentCreate, wordDocumentEdit, wordDocumentGet } from '../lib/tools/word-documents';

async function fixture() {
  const bytes = await createWordPackage('Report', [{ op: 'insert_paragraph', text: 'Original text' }]);
  const file: OfficeFile = {
    documentId: 'word-1',
    title: 'Report.docx',
    extension: 'docx',
    currentRevision: 1,
    createdAt: 1,
    updatedAt: 1,
    versions: [],
    version: { revision: 1, url: 'https://owned.example.test/word', size: bytes.length, sha256: 'old' },
  };
  let uploaded: Uint8Array | undefined;
  let clock = 0;
  const calls: any[] = [];
  let mutationResult = { ok: true, revision: 2 };
  const source = {
    documentId: 'simple',
    title: 'Original draft',
    kind: 'doc' as const,
    currentRevision: 3,
    model: createDefaultDocumentModel('doc'),
    sourceRefs: [],
    createdAt: 1,
    updatedAt: 1,
  };
  const dependencies = {
    requireOffice: () => ({
      server: 'https://office.test',
      app: 'https://app.test',
      secret: 'test',
      provider: 'collabora',
    }),
    getDocument: async () => source,
    getOfficeFile: async () => file,
    createOfficeFile: async (input: any) => {
      calls.push({ create: input });
      return file;
    },
    storeOfficeBytes: async (_owner: string, next: Uint8Array) => {
      uploaded = next;
      return 'storage';
    },
    fetch: async () => new Response(new Uint8Array(bytes)),
    convexMutation: async (_api: any, input: any) => {
      calls.push(input);
      return input.action ? { ok: true, ready: false } : mutationResult;
    },
    randomUUID: () =>
      '11111111-1111-4111-8111-111111111111' as `${string}-${string}-${string}-${string}-${string}`,
    now: () => clock,
    wait: async (ms: number) => {
      clock += ms;
    },
  };
  return {
    file,
    source,
    dependencies,
    calls,
    service: createWordService(dependencies as any),
    uploaded: () => uploaded,
    rejectSave: () => {
      mutationResult = { ok: false, revision: 2 };
    },
  };
}

test('Word services create and read binary files and preserve the original when copying a simple document', async () => {
  const f = await fixture();
  expect(await f.service.read('owner', 'word-1')).toMatchObject({
    revision: 1,
    paragraphs: [{ index: 0 }, { text: 'Original text' }],
  });
  const created = await f.service.create('owner', {
    title: 'New report',
    edits: [{ op: 'insert_paragraph', text: 'Actual content' }],
  });
  expect(created.openPath).toBe('/?view=files&office=word-1');
  expect((await readWordPackage(f.uploaded()!)).paragraphs[1].text).toBe('Actual content');
  expect(f.calls[0].create.title).toBe('New report.docx');
  await expect(
    f.service.create('owner', { title: '', sourceDocumentId: 'simple', expectedRevision: 2 }),
  ).rejects.toThrow('source changed');
  await f.service.create('owner', { title: '', sourceDocumentId: 'simple', expectedRevision: 3 });
  expect(f.source.currentRevision).toBe(3);
  expect(f.calls.at(-1).create.title).toBe('Original draft.docx');
});

test('saved-file edits use revision compare-and-swap and surface concurrent failures without claiming success', async () => {
  const f = await fixture();
  const edits = [{ op: 'replace_text' as const, paragraph: 1, find: 'Original', replacement: 'Updated' }];
  await expect(f.service.edit('owner', 'word-1', 2, edits)).rejects.toThrow('changed');
  expect(f.uploaded()).toBeUndefined();
  expect(await f.service.edit('owner', 'word-1', 1, edits)).toMatchObject({ ok: true, revision: 2 });
  expect(f.calls.at(-1)).toMatchObject({ userId: 'owner', documentId: 'word-1', expectedRevision: 1 });
  expect((await readWordPackage(f.uploaded()!)).paragraphs[1].text).toBe('Updated text');
  f.rejectSave();
  await expect(f.service.edit('owner', 'word-1', 1, edits)).rejects.toThrow('changed');
});

test('an open Word editor is saved and released before the edit, then always resumed', async () => {
  const f = await fixture();
  f.file.wopiLock = { value: 'lock', sessionId: 'browser', expiresAt: 100_000 };
  f.dependencies.wait = async () => {
    f.file.aiEdit = {
      id: f.dependencies.randomUUID(),
      targetSessionId: 'browser',
      state: 'prepared',
      expiresAt: 100_000,
    };
    delete f.file.wopiLock;
  };
  const service = createWordService(f.dependencies as any);
  await service.edit('owner', 'word-1', 1, [{ op: 'insert_paragraph', text: 'AI added this' }]);
  expect(f.calls.map((call) => call.action || 'save')).toEqual(['request', 'save', 'complete']);
  expect(f.calls[1].requestId).toBe(f.dependencies.randomUUID());
});

test('autosaved typing invalidates stale paragraph indexes and resumes the editor without uploading an AI revision', async () => {
  const f = await fixture();
  f.file.wopiLock = { value: 'lock', sessionId: 'browser', expiresAt: 100_000 };
  f.dependencies.wait = async () => {
    f.file.aiEdit = {
      id: f.dependencies.randomUUID(),
      targetSessionId: 'browser',
      state: 'prepared',
      expiresAt: 100_000,
    };
    delete f.file.wopiLock;
    f.file.currentRevision = 2;
  };
  await expect(
    createWordService(f.dependencies as any).edit('owner', 'word-1', 1, [
      { op: 'insert_paragraph', text: 'AI edit' },
    ]),
  ).rejects.toThrow('autosaved');
  expect(f.calls.map((call) => call.action)).toEqual(['request', 'fail']);
  expect(f.uploaded()).toBeUndefined();
});

test('unresponsive and failed editors do not cause an edit or leave an abandoned pause request', async () => {
  const f = await fixture();
  f.file.wopiLock = { value: 'lock', sessionId: 'browser', expiresAt: 100_000 };
  f.file.aiEdit = {
    id: f.dependencies.randomUUID(),
    targetSessionId: 'browser',
    state: 'requested',
    expiresAt: 100_000,
  };
  await expect(
    f.service.edit('owner', 'word-1', 1, [{ op: 'insert_paragraph', text: 'AI edit' }]),
  ).rejects.toThrow('did not finish');
  expect(f.calls.at(-1).action).toBe('fail');
  expect(f.uploaded()).toBeUndefined();
  f.file.aiEdit.state = 'failed';
  await expect(
    f.service.edit('owner', 'word-1', 1, [{ op: 'insert_paragraph', text: 'AI edit' }]),
  ).rejects.toThrow('could not prepare');
});

test('Word tools are registered and authenticated before invoking document services', async () => {
  for (const tool of [wordDocumentCreate, wordDocumentGet, wordDocumentEdit]) {
    expect(TOOLS[tool.name]).toBe(tool);
    expect(AGENT_TOOL_NAMES.has(tool.name)).toBe(true);
    expect(TOOL_GROUPS.documents_more.tools).toContain(tool.name);
    await expect(tool.handler({} as never, { agent: 'user', userId: null } as any)).rejects.toThrow(
      'Not authenticated',
    );
  }
});
