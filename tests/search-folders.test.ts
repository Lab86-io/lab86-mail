import { describe, expect, test } from 'bun:test';
import {
  folderRowMatches,
  foldLabel,
  googleFolderId,
  normalizeFolder,
  SYSTEM_LABEL_ALIASES,
} from '../lib/mail/search/folders';

describe('normalizeFolder', () => {
  test('maps common aliases to canonical folders', () => {
    expect(normalizeFolder('inbox')).toBe('INBOX');
    expect(normalizeFolder('drafts')).toBe('DRAFTS');
    expect(normalizeFolder('junk')).toBe('SPAM');
    expect(normalizeFolder('all_mail')).toBe('ALL');
    expect(normalizeFolder('Custom')).toBe('Custom');
  });
});

describe('googleFolderId', () => {
  test('returns Gmail system label ids', () => {
    expect(googleFolderId('inbox')).toBe('INBOX');
    expect(googleFolderId('sent')).toBe('SENT');
    expect(googleFolderId('archive')).toBeNull();
  });
});

describe('folderRowMatches', () => {
  test('matches Microsoft-style folder names and attributes', () => {
    expect(folderRowMatches('sent', { name: 'Sent Items' })).toBe(true);
    expect(folderRowMatches('trash', { name: 'Deleted Items' })).toBe(true);
    expect(folderRowMatches('inbox', { attributes: ['\\Inbox'] })).toBe(true);
    expect(folderRowMatches('inbox', { name: 'Projects' })).toBe(false);
  });
  test('matches custom folder names by foldLabel equality', () => {
    expect(folderRowMatches('Projects', { name: 'projects' })).toBe(true);
  });
});

describe('foldLabel', () => {
  test('normalizes separators and case', () => {
    expect(foldLabel('\\Sent Items')).toBe('sentitems');
    expect(foldLabel('Sent_Items')).toBe('sentitems');
  });
});

describe('SYSTEM_LABEL_ALIASES', () => {
  test('includes provider-neutral sent and trash names', () => {
    expect(SYSTEM_LABEL_ALIASES.SENT).toContain('Sent Items');
    expect(SYSTEM_LABEL_ALIASES.TRASH).toContain('Deleted Items');
  });
});
