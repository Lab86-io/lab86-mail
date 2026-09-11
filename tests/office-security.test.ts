import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { AuthRequiredError } from '../lib/auth/current-user';
import { exportDocument } from '../lib/documents/export';
import { createDefaultDocumentModel } from '../lib/documents/model';
import { officeCapability, officeFailure } from '../lib/documents/office-http';
import {
  OFFICE_MAX_BYTES,
  OfficeError,
  officeConfiguration,
  officeExtension,
  readOfficeRequest,
  readOfficeResponse,
  signOfficeToken,
  validateOfficeArchive,
  validateOfficeDownloadUrl,
  verifyOfficeToken,
} from '../lib/documents/office-security';
import { RateLimitError } from '../lib/rate-limit';

const secret = 'office-test-secret-at-least-32-characters';
describe('Office pilot security boundary', () => {
  test('maps recoverable failures without exposing internal transport details', async () => {
    const missingAuth = officeFailure(new AuthRequiredError('Sign in to edit this file.'));
    expect(missingAuth.status).toBe(401);
    expect(await missingAuth.json()).toMatchObject({ ok: false, error: 'Sign in to edit this file.' });
    const conflict = officeFailure(new OfficeError('Reopen this file.', 409));
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({ error: 'Reopen this file.' });
    const limited = officeFailure(new RateLimitError('Please wait.', 2_000, 30));
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).toBe('2');
    const unknown = officeFailure(new Error('private callback URL and credential'));
    expect(unknown.status).toBe(500);
    expect(await unknown.text()).not.toContain('credential');
  });

  test('requires deliberate enablement, licensing acknowledgment, strong secret, and safe origins', () => {
    const env = {
      OFFICE_EDITOR_ENABLED: 'true',
      OFFICE_LICENSE_ACCEPTED: 'true',
      OFFICE_JWT_SECRET: secret,
      OFFICE_DOCUMENT_SERVER_URL: 'https://office.example.test',
      OFFICE_APP_ORIGIN: 'https://mail.example.test',
      NODE_ENV: 'production',
    } as NodeJS.ProcessEnv;
    expect(officeConfiguration({})).toBeNull();
    expect(officeConfiguration({ ...env, OFFICE_LICENSE_ACCEPTED: 'false' })).toBeNull();
    expect(officeConfiguration({ ...env, OFFICE_JWT_SECRET: 'weak' })).toBeNull();
    expect(officeConfiguration(env)?.server).toBe('https://office.example.test');
    expect(
      officeConfiguration({
        ...env,
        OFFICE_DOCUMENT_SERVER_URL: 'https://OFFICE.example.test:443/',
        OFFICE_EDITOR_PROVIDER: ' Collabora ',
      }),
    ).toMatchObject({ server: 'https://office.example.test', provider: 'collabora' });
    expect(() => officeConfiguration({ ...env, OFFICE_EDITOR_PROVIDER: 'typo' })).toThrow(
      'OFFICE_EDITOR_PROVIDER',
    );
    expect(officeConfiguration({ ...env, OFFICE_EDITOR_ENABLED: 'false' }, true)?.server).toBe(
      'https://office.example.test',
    );
    expect(() =>
      officeConfiguration({ ...env, OFFICE_DOCUMENT_SERVER_URL: 'http://127.0.0.1:8080' }),
    ).toThrow();
    expect(() =>
      officeConfiguration({
        ...env,
        OFFICE_DOCUMENT_SERVER_URL: 'https://user:password@office.example.test',
      }),
    ).toThrow();
    expect(() =>
      officeConfiguration({ ...env, OFFICE_APP_ORIGIN: 'https://mail.example.test/path' }),
    ).toThrow();
  });

  test('binds signed capabilities to purpose, file, session, identity and expiry', () => {
    const payload = {
      purpose: 'download',
      documentId: 'file-1',
      sessionId: 'session-1',
      userId: 'user-1',
      revision: 1,
      exp: Math.floor(Date.now() / 1000) + 60,
    };
    const token = signOfficeToken(payload, secret);
    const request = new Request(`https://mail.test/api/office/file-1/content?token=${token}`);
    expect(officeCapability(request, secret, 'file-1', 'download')).toMatchObject(payload);
    expect(() => officeCapability(request, secret, 'file-2', 'download')).toThrow();
    expect(() => officeCapability(request, secret, 'file-1', 'callback')).toThrow();
    expect(() => verifyOfficeToken(`${token}tampered`, secret)).toThrow();
    expect(() => verifyOfficeToken(token, 'different-secret')).toThrow();
    expect(() => verifyOfficeToken(token, secret, Date.now() + 120_000)).toThrow();
    expect(() =>
      officeCapability(
        new Request(`https://mail.test/?token=${signOfficeToken({ ...payload, exp: undefined }, secret)}`),
        secret,
        'file-1',
        'download',
      ),
    ).toThrow();
  });

  test('only downloads save output from the exact configured server origin', () => {
    expect(
      validateOfficeDownloadUrl(
        'https://office.example.test/cache/file.docx?token=x',
        'https://office.example.test',
      ),
    ).toContain('/cache/');
    for (const url of [
      'http://169.254.169.254/latest/meta-data',
      'https://office.example.test.attacker.test/file',
      'https://office.example.test:8443/file',
      'https://user:pass@office.example.test/file',
      'file:///etc/passwd',
    ]) {
      expect(() => validateOfficeDownloadUrl(url, 'https://office.example.test')).toThrow();
    }
  });

  test('enforces streamed byte limits even without Content-Length', async () => {
    const oversized = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(OFFICE_MAX_BYTES));
          controller.enqueue(new Uint8Array(1));
          controller.close();
        },
      }),
    );
    await expect(readOfficeResponse(oversized)).rejects.toThrow('25 MB');
    expect(await readOfficeResponse(new Response(new Uint8Array([1, 2, 3])))).toEqual(Buffer.from([1, 2, 3]));
    await expect(readOfficeResponse(new Response(null, { status: 500 }))).rejects.toThrow();
    const request = new Request('https://mail.test/callback', {
      method: 'POST',
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(20));
          controller.close();
        },
      }),
      duplex: 'half',
    } as RequestInit);
    await expect(readOfficeRequest(request, 10)).rejects.toThrow('too large');
    expect(
      await readOfficeRequest(new Request('https://mail.test/callback', { method: 'POST', body: 'ok' }), 10),
    ).toEqual(Buffer.from('ok'));
  });

  test('validates real synthetic DOCX/XLSX/PPTX exports without altering any bytes', async () => {
    for (const kind of ['doc', 'sheet', 'deck'] as const) {
      const file = await exportDocument({
        documentId: 'office-synthetic',
        kind,
        title: 'Office pilot',
        model: createDefaultDocumentModel(kind, 'office-synthetic'),
        currentRevision: 1,
        sourceRefs: [],
        createdAt: 1,
        updatedAt: 1,
      });
      const copy = new Uint8Array(file.bytes);
      expect(validateOfficeArchive(file.bytes, file.extension)).toBe(
        createHash('sha256').update(copy).digest('hex'),
      );
      expect(file.bytes).toEqual(copy);
      expect(() => validateOfficeArchive(file.bytes, file.extension === 'docx' ? 'xlsx' : 'docx')).toThrow();
    }
    expect(() => officeExtension('unsafe.docm')).toThrow();
    expect(() => officeExtension('book.XLSX')).not.toThrow();
    expect(() => validateOfficeArchive(new Uint8Array([80, 75, 3, 4]), 'docx')).toThrow();
  });
});
