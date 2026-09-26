import { expect, test } from 'bun:test';
import { unreadMessageIds } from '../lib/shell/reader-read-state';

test('the reader marks iCloud and Outlook messages read by their unread flag', () => {
  expect(
    unreadMessageIds([
      { _id: 'icloud-1', unread: true, labels: ['a1b2c3-folder-id'] },
      { _id: 'outlook-1', unread: false, labels: ['AAMkAD-inbox'] },
      { _id: 'gmail-1', unread: true, labels: ['INBOX', 'UNREAD'] },
    ]),
  ).toEqual(['icloud-1', 'gmail-1']);
});

test('the flag wins over a stale label, and old rows fall back to the label', () => {
  expect(
    unreadMessageIds([
      { _id: 'stale', unread: false, labels: ['UNREAD'] },
      { _id: 'old-row', labels: ['UNREAD'] },
      { _id: null, unread: true },
      { _id: 'plain' },
    ]),
  ).toEqual(['old-row']);
});
