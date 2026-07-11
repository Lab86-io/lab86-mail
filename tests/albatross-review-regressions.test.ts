import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { notificationPreferenceInput } from '@/lib/notifications/preferences';
import { type ChatSessionSummary, filterChatSessionsByScope } from '@/lib/store/chat-sessions';

const read = (relativePath: string) => readFileSync(path.join(process.cwd(), relativePath), 'utf8');

describe('CodeRabbit Albatross regressions', () => {
  test('chat scope filtering happens before the result cap', () => {
    const globalRows: ChatSessionSummary[] = Array.from({ length: 35 }, (_, index) => ({
      _id: `global-${index}`,
      title: `Global ${index}`,
      messageCount: 1,
      createdAt: 1_000 - index,
      updatedAt: 1_000 - index,
      scope: { kind: 'global' },
    }));
    const areaRow: ChatSessionSummary = {
      _id: 'area-old',
      title: 'Area conversation',
      messageCount: 2,
      createdAt: 1,
      updatedAt: 1,
      scope: { kind: 'area', areaId: 'area-1' },
    };

    expect(
      filterChatSessionsByScope([...globalRows, areaRow], { kind: 'area', areaId: 'area-1' }, 30),
    ).toEqual([areaRow]);
  });

  test('notification preference mutations receive only validator fields', () => {
    expect(
      notificationPreferenceInput({
        _id: 'stored-id',
        userId: 'server-only-user',
        timezone: 'America/New_York',
        eveningCheckinEnabled: true,
        eveningCheckinLocalTime: '19:00',
        inAppEnabled: true,
        webPushEnabled: false,
        emailFallbackEnabled: true,
        emailFallbackDelayMinutes: 90,
      }),
    ).toEqual({
      timezone: 'America/New_York',
      eveningCheckinEnabled: true,
      eveningCheckinLocalTime: '19:00',
      inAppEnabled: true,
      webPushEnabled: false,
      emailFallbackEnabled: true,
      emailFallbackDelayMinutes: 90,
    });
  });

  test('artifact and answer controls retain their security and accessibility contracts', () => {
    const detail = read('components/albatross/WorkDetail.tsx');
    const companion = read('components/albatross/AlbatrossCompanion.tsx');
    expect(detail).toContain('sandbox="allow-scripts allow-popups"');
    expect(detail).not.toContain('allow-popups-to-escape-sandbox');
    expect(detail).toContain('aria-label="Answer in your own words"');
    expect(companion.match(/aria-label="Answer Albatross in your own words"/g)).toHaveLength(2);
  });
});
