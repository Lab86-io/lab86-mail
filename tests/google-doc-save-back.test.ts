import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { NextRequest } from 'next/server';
import { GET, PATCH } from '../app/api/files/google/editor/route';
import * as currentUser from '../lib/auth/current-user';
import { googleFileDeepLinkUrl } from '../lib/documents/deep-link';
import { __setGoogleDocumentDepsForTest } from '../lib/documents/google';
import { __setGoogleImportDepsForTest } from '../lib/documents/google-import';
import { __setGoogleOfficeDepsForTest, saveGoogleOfficeFile } from '../lib/documents/google-office';
import {
  GOOGLE_DOC_MIME,
  GOOGLE_DOC_OFFICE_OPEN_REFUSED,
  GOOGLE_DOC_OFFICE_SAVE_REFUSED,
  googleNativeEditor,
} from '../lib/documents/google-write-policy';
import * as rateLimit from '../lib/rate-limit';

// Repro of the 2026-09-30 demo bug: with Office on, the Google Doc "Project
// brief" opened in Office as "Project brief.docx", and "Save to Google" failed
// with "Google write access is missing". The Office save replaces the Doc with
// a Drive v2 upload, which needs the full `drive` scope for a Doc that
// Albatross did not make. The owner chose: a Google Doc always opens in the
// Albatross editor, which saves with `documents.batchUpdate`.

const SHEET_MIME = 'application/vnd.google-apps.spreadsheet';
const SLIDES_MIME = 'application/vnd.google-apps.presentation';

const restores: Array<() => void> = [];
afterEach(() => {
  for (const restore of restores.splice(0).reverse()) restore();
  __setGoogleDocumentDepsForTest();
  __setGoogleImportDepsForTest();
  __setGoogleOfficeDepsForTest();
});

function signIn() {
  const user = spyOn(currentUser, 'requireCurrentUser').mockResolvedValue({
    userId: 'owner',
    email: 'albatross-test@lab86.io',
    name: 'Test',
    source: 'clerk',
  });
  const limit = spyOn(rateLimit, 'enforceUserRateLimit').mockResolvedValue(undefined as any);
  restores.push(
    () => user.mockRestore(),
    () => limit.mockRestore(),
  );
}

interface Call {
  method: string;
  url: string;
  body?: any;
}

/** A Google Doc that the user made in Google: Albatross has no Drive write access to it. */
function fakeGoogle() {
  const calls: Call[] = [];
  const state = { version: 9, revisionId: 'rev-1', name: 'Project brief' };
  const content = () => [
    { startIndex: 0, endIndex: 1, sectionBreak: { sectionStyle: {} } },
    {
      startIndex: 1,
      endIndex: 13,
      paragraph: {
        elements: [{ startIndex: 1, endIndex: 13, textRun: { content: 'Project brief\n', textStyle: {} } }],
        paragraphStyle: { namedStyleType: 'HEADING_1' },
      },
    },
    {
      startIndex: 13,
      endIndex: 40,
      paragraph: {
        elements: [
          {
            startIndex: 13,
            endIndex: 40,
            textRun: { content: 'Launch plan for the pilot.\n', textStyle: {} },
          },
        ],
        paragraphStyle: { namedStyleType: 'NORMAL_TEXT' },
      },
    },
  ];
  const fetch = (async (url: unknown, init?: RequestInit) => {
    const endpoint = String(url);
    const method = init?.method || 'GET';
    calls.push({ method, url: endpoint, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (endpoint.includes('/drive/v3/files/') && method === 'PATCH') {
      // Drive refuses the rename of a file that the app did not make.
      return Response.json(
        {
          error: {
            code: 403,
            message: 'The user has not granted the app write access to the file.',
            errors: [{ reason: 'appNotAuthorizedToFile' }],
          },
        },
        { status: 403 },
      );
    }
    if (endpoint.includes('/drive/v3/files/')) {
      return Response.json({
        id: 'doc-1',
        name: state.name,
        mimeType: GOOGLE_DOC_MIME,
        webViewLink: 'https://docs.google.com/document/d/doc-1/edit',
        version: String(state.version),
      });
    }
    if (endpoint.endsWith(':batchUpdate') && method === 'POST') {
      state.version += 1;
      state.revisionId = 'rev-2';
      return Response.json({ documentId: 'doc-1', replies: [] });
    }
    if (endpoint.includes('docs.googleapis.com/v1/documents/')) {
      return Response.json({
        documentId: 'doc-1',
        title: state.name,
        revisionId: state.revisionId,
        body: { content: content() },
      });
    }
    return new Response('unexpected', { status: 500 });
  }) as typeof globalThis.fetch;
  const access = (async () => ({
    connection: { provider: 'google_drive', connectionId: 'drive' },
    accessToken: 'drive-token',
  })) as any;
  __setGoogleImportDepsForTest({ getCloudFileAccess: access, fetch });
  __setGoogleDocumentDepsForTest({ getCloudFileAccess: access, fetch });
  return { calls, state };
}

describe('which editor opens a Google-native file', () => {
  test('a Google Doc opens in the Albatross editor, also with Office on', () => {
    expect(googleNativeEditor(GOOGLE_DOC_MIME, true)).toBe('albatross');
    expect(googleNativeEditor(GOOGLE_DOC_MIME, false)).toBe('albatross');
  });

  test('Sheets and Slides keep Office when it is on', () => {
    expect(googleNativeEditor(SHEET_MIME, true)).toBe('office');
    expect(googleNativeEditor(SLIDES_MIME, true)).toBe('office');
    expect(googleNativeEditor(SHEET_MIME, false)).toBe('albatross');
    expect(googleNativeEditor(SLIDES_MIME, false)).toBe('albatross');
  });

  test('every Files entry point goes through the one editor switch', () => {
    const read = (file: string) => readFileSync(path.join(process.cwd(), file), 'utf8');
    const editor = read('components/files/DocumentEditor.tsx');
    expect(editor).toContain("googleNativeEditor(source.mimeType, officeEnabled) === 'office'");
    // The Office copy of a Google file is made only in that branch.
    expect(editor.match(/'\/api\/files\/google\/office'/gu)).toHaveLength(1);
    const files = read('components/files/FilesSurface.tsx');
    expect(files).toMatch(/<GoogleDocumentEditor\s+officeEnabled=/u);
    // Links from search, tools, and the palette use the provider link that FilesSurface reads.
    expect(read('lib/search/global-search.ts')).toContain("params.set('provider', 'google_drive')");
    expect(read('lib/tools/google-documents.ts')).toContain("provider: 'google_drive'");
    expect(files).toContain("params.get('provider') === 'google_drive'");
  });

  test('the original-Doc link replaces an open Office file with the Google file', () => {
    expect(
      googleFileDeepLinkUrl(
        { connectionId: 'drive', fileId: 'doc-1', mimeType: GOOGLE_DOC_MIME },
        'https://mail.lab86.io/?view=files&office=google-abc&document=d1#top',
      ),
    ).toBe(
      `/?view=files&provider=google_drive&connection=drive&file=doc-1&mime=${encodeURIComponent(GOOGLE_DOC_MIME)}#top`,
    );
  });
});

describe('Albatross editor save of a Google Doc that Albatross did not make', () => {
  test('open, edit, and save send documents.batchUpdate, never a Drive upload', async () => {
    signIn();
    const google = fakeGoogle();
    const identity = { connectionId: 'drive', fileId: 'doc-1', mimeType: GOOGLE_DOC_MIME };

    const opened = await GET(
      new NextRequest(`http://localhost/api/files/google/editor?${new URLSearchParams(identity)}`),
    );
    expect(opened.status).toBe(200);
    const { file } = await opened.json();
    expect(file).toMatchObject({ kind: 'doc', title: 'Project brief', providerVersion: '9' });
    expect(file.editability).toEqual({ editable: true });
    expect(file.model.blocks.map((block: any) => block.text)).toEqual([
      'Project brief',
      'Launch plan for the pilot.',
    ]);

    // The user changes one sentence and the title.
    const model = {
      ...file.model,
      blocks: file.model.blocks.map((block: any, index: number) =>
        index === 1 ? { ...block, text: 'Launch plan for the October pilot.' } : block,
      ),
    };
    const saved = await PATCH(
      new NextRequest('http://localhost/api/files/google/editor', {
        method: 'PATCH',
        body: JSON.stringify({
          ...identity,
          title: 'Project brief v2',
          model,
          expectedProviderVersion: file.providerVersion,
        }),
      }),
    );
    expect(saved.status).toBe(200);
    const result = await saved.json();
    // The rename is skipped (no Drive write access), and the content save holds (PR #306).
    expect(result.file).toMatchObject({
      title: 'Project brief',
      renameSkipped: true,
      providerVersion: '10',
    });

    const batch = google.calls.filter((call) => call.url.endsWith(':batchUpdate'));
    expect(batch).toHaveLength(1);
    expect(batch[0].url).toBe('https://docs.googleapis.com/v1/documents/doc-1:batchUpdate');
    expect(batch[0].body.writeControl).toEqual({ requiredRevisionId: 'rev-1' });
    expect(batch[0].body.requests[0]).toEqual({
      deleteContentRange: { range: { startIndex: 1, endIndex: 39 } },
    });
    expect(batch[0].body.requests[1]).toEqual({
      insertText: { location: { index: 1 }, text: 'Project brief\nLaunch plan for the October pilot.' },
    });
    expect(batch[0].body.requests).toContainEqual({
      updateParagraphStyle: {
        range: { startIndex: 1, endIndex: 15 },
        paragraphStyle: { namedStyleType: 'HEADING_1' },
        fields: 'namedStyleType',
      },
    });
    // No Drive v2 upload and no content replacement through Drive.
    expect(google.calls.some((call) => call.url.includes('/upload/'))).toBe(false);
    expect(google.calls.some((call) => call.url.includes('/drive/v2/'))).toBe(false);
    const renames = google.calls.filter((call) => call.method === 'PATCH');
    expect(renames).toEqual([
      {
        method: 'PATCH',
        url: 'https://www.googleapis.com/drive/v3/files/doc-1?supportsAllDrives=true&fields=id',
        body: { name: 'Project brief v2' },
      },
    ]);
  });

  test('a save against a changed Doc is a conflict and writes nothing', async () => {
    signIn();
    const google = fakeGoogle();
    const saved = await PATCH(
      new NextRequest('http://localhost/api/files/google/editor', {
        method: 'PATCH',
        body: JSON.stringify({
          connectionId: 'drive',
          fileId: 'doc-1',
          mimeType: GOOGLE_DOC_MIME,
          title: 'Project brief',
          model: { kind: 'doc', version: 1, blocks: [{ id: 'b', type: 'paragraph', text: 'x' }] },
          expectedProviderVersion: '8',
        }),
      }),
    );
    expect(saved.status).toBe(409);
    expect(google.calls.some((call) => call.url.endsWith(':batchUpdate'))).toBe(false);
  });
});

describe('an Office copy of a Google Doc never replaces the Doc', () => {
  test('Save to Google stops before it reads the copy or calls Google', async () => {
    const session = JSON.stringify({
      userId: 'owner',
      connectionId: 'drive',
      fileId: 'doc-1',
      mimeType: GOOGLE_DOC_MIME,
      etag: 'etag-1',
      version: '1',
      expiresAt: Date.now() + 60_000,
    });
    let fetched = false;
    let wrote = false;
    __setGoogleOfficeDepsForTest({
      decryptSecret: (value) => value,
      getOfficeFile: (async () => ({
        documentId: 'google-copy',
        extension: 'docx',
        currentRevision: 2,
        google: { connectionId: 'drive', fileId: 'doc-1', session, syncedRevision: 1 },
        lastWopiSave: { id: 'receipt', revision: 2 },
        version: { url: 'https://storage.test/private' },
      })) as any,
      fetch: async () => {
        fetched = true;
        return new Response('');
      },
      saveGoogleWorkingCopy: async () => {
        wrote = true;
        throw new Error('must not upload');
      },
    });
    const failure = await saveGoogleOfficeFile('owner', 'google-copy', 'receipt').catch((error) => error);
    expect(failure).toMatchObject({ status: 409, message: GOOGLE_DOC_OFFICE_SAVE_REFUSED });
    expect(fetched).toBe(false);
    expect(wrote).toBe(false);
  });

  test('the refusal copy follows the product rules', () => {
    for (const message of [GOOGLE_DOC_OFFICE_OPEN_REFUSED, GOOGLE_DOC_OFFICE_SAVE_REFUSED]) {
      expect(message).not.toMatch(/\bAI\b/u);
      expect(message).toContain('Albatross');
      expect(message).not.toMatch(/drive scope|reconnect/iu);
    }
  });
});
