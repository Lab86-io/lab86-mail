import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { CLOUD_FILE_PROVIDER_DEFINITIONS } from '../lib/files/providers';
import { GOOGLE_MAIL_SCOPES } from '../lib/google/oauth';

const ROOT = path.join(import.meta.dir, '..');
const read = (rel: string) => readFileSync(path.join(ROOT, rel), 'utf8');

/** `https://www.googleapis.com/auth/gmail.modify` -> `gmail.modify`; the `email` alias -> `userinfo.email`. */
function shortScope(scope: string) {
  const name = scope.replace('https://www.googleapis.com/auth/', '');
  return name === 'email' ? 'userinfo.email' : name;
}

describe('Google scope lists', () => {
  test('the mailbox flow asks for the eight scopes of the production connector', () => {
    expect(GOOGLE_MAIL_SCOPES.map(shortScope)).toEqual([
      'openid',
      'userinfo.email',
      'userinfo.profile',
      'gmail.modify',
      'calendar',
      'contacts.readonly',
      'contacts.other.readonly',
      'directory.readonly',
    ]);
  });

  test('the Nylas provision script sends the same eight scopes to the Google connector', () => {
    const script = read('scripts/nylas-provision.ts');
    expect(script).toContain("import { GOOGLE_MAIL_SCOPES } from '../lib/google/oauth';");
    expect(script).toContain('const GOOGLE_CONNECTOR_SCOPES: string[] = [...GOOGLE_MAIL_SCOPES];');
    expect(script.replace(/\s+/g, ' ')).toContain("provider === 'google' ? GOOGLE_CONNECTOR_SCOPES :");
    // No second, hand-kept Google list that can drift from production.
    expect(script).not.toContain("'https://www.googleapis.com/auth/gmail.modify'");
  });

  test('the Drive flow asks for no Sheets, Slides, or full Drive scope', () => {
    const drive = CLOUD_FILE_PROVIDER_DEFINITIONS.google_drive.scopes.map(shortScope);
    expect(drive).toEqual(['openid', 'userinfo.email', 'drive.readonly', 'drive.file', 'documents']);
    for (const wide of ['spreadsheets', 'presentations', 'drive']) expect(drive).not.toContain(wide);
  });

  test('the summary table of scopes.md lists exactly the scopes that the code asks for', () => {
    const doc = read('docs/google-verification/scopes.md');
    const summary = doc.slice(doc.indexOf('## Summary'), doc.indexOf('\n## ', doc.indexOf('## Summary') + 1));
    const documented = [...summary.matchAll(/^\| `([a-z.]+)`/gm)].map((match) => match[1]);
    const requested = new Set([
      ...GOOGLE_MAIL_SCOPES.map(shortScope),
      ...CLOUD_FILE_PROVIDER_DEFINITIONS.google_drive.scopes.map(shortScope),
    ]);
    expect(new Set(documented)).toEqual(requested);
    expect(doc).not.toContain('## spreadsheets');
    expect(doc).not.toContain('## presentations');
  });
});
