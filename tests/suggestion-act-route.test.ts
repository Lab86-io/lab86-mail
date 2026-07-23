import { describe, expect, test } from 'bun:test';
import { NextRequest } from 'next/server';
import { createSuggestionActPost, safeSuggestedEvent } from '../app/api/suggestions/act/route';
import { parseIcsEvents } from '../lib/calendar/ics';

const VALID_ICS = [
  'BEGIN:VCALENDAR',
  'BEGIN:VEVENT',
  'SUMMARY:Provider planning',
  'DTSTART:20260724T140000Z',
  'DTEND:20260724T150000Z',
  'LOCATION:Studio',
  'END:VEVENT',
  'END:VCALENDAR',
].join('\r\n');

function request() {
  return new NextRequest('http://localhost/api/suggestions/act', {
    method: 'POST',
    body: JSON.stringify({ suggestionId: 'suggestion_1', action: 'accept' }),
  });
}

function routeDependencies(payload: Record<string, unknown>) {
  const created: Array<Record<string, unknown>> = [];
  let queryCount = 0;
  return {
    deps: {
      requireCurrentUser: async () => ({
        userId: 'user_1',
        email: 'user@example.test',
        source: 'clerk' as const,
      }),
      enforceUserRateLimit: async () => ({ ok: true }),
      convexQuery: async () => {
        queryCount += 1;
        return queryCount === 1
          ? { status: 'pending', kind: 'event', payload }
          : { status: 'connected', grantId: 'grant_1' };
      },
      convexMutation: async () => ({ ok: true }),
      requireNylas: () => ({
        attachments: {
          download: async () => VALID_ICS,
        },
      }),
      createCalendarEvent: async (input: Record<string, unknown>) => {
        created.push(input);
        return { eventId: 'event_1' };
      },
      reportUnexpectedError: () => undefined,
    },
    created,
  };
}

describe('suggestion event acceptance', () => {
  test('applies the same bounds to an attachment-backed event', () => {
    const [parsed] = parseIcsEvents(
      [
        'BEGIN:VCALENDAR',
        'BEGIN:VEVENT',
        `SUMMARY:${'Planning '.repeat(60)}`,
        'DTSTART:20260724T140000Z',
        'DTEND:20260724T150000Z',
        'LOCATION:Studio',
        'END:VEVENT',
        'END:VCALENDAR',
      ].join('\r\n'),
    );

    expect(safeSuggestedEvent(parsed as unknown as Record<string, unknown>)).toEqual({
      title: `${'Planning '.repeat(60)}`.trim().slice(0, 300),
      startAt: Date.parse('2026-07-24T14:00:00Z'),
      endAt: Date.parse('2026-07-24T15:00:00Z'),
      allDay: false,
      description: undefined,
      location: 'Studio',
    });
  });

  test('rejects malformed attachment and embedded event durations', () => {
    const [oversizedAttachment] = parseIcsEvents(
      [
        'BEGIN:VCALENDAR',
        'BEGIN:VEVENT',
        'SUMMARY:Unsafe imported event',
        'DTSTART:20260701T140000Z',
        'DTEND:20260815T140000Z',
        'END:VEVENT',
        'END:VCALENDAR',
      ].join('\r\n'),
    );

    expect(safeSuggestedEvent(oversizedAttachment as unknown as Record<string, unknown>)).toBeNull();
    expect(
      safeSuggestedEvent({
        title: 'Backwards event',
        startAt: Date.parse('2026-07-24T15:00:00Z'),
        endAt: Date.parse('2026-07-24T14:00:00Z'),
      }),
    ).toBeNull();
  });

  test('bounds embedded text before provider mutation', () => {
    const event = safeSuggestedEvent({
      title: `  ${'T'.repeat(400)}  `,
      startAt: 100,
      endAt: 200,
      allDay: true,
      description: 'D'.repeat(12_000),
      location: 'L'.repeat(800),
    });

    expect(event?.title).toHaveLength(300);
    expect(event?.description).toHaveLength(10_000);
    expect(event?.location).toHaveLength(500);
    expect(event?.allDay).toBe(true);
  });

  test('passes a validated attachment event to the provider mutation path', async () => {
    const { deps, created } = routeDependencies({
      accountId: 'account_1',
      messageId: 'message_1',
      attachmentId: 'attachment_1',
    });

    const response = await createSuggestionActPost(deps as any)(request());

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      eventId: 'event_1',
      title: 'Provider planning',
    });
    expect(created).toEqual([
      {
        userId: 'user_1',
        accountId: 'account_1',
        title: 'Provider planning',
        startAt: Date.parse('2026-07-24T14:00:00Z'),
        endAt: Date.parse('2026-07-24T15:00:00Z'),
        allDay: false,
        description: undefined,
        location: 'Studio',
        notifyParticipants: false,
      },
    ]);
  });

  test('passes a validated embedded event to the provider mutation path', async () => {
    const { deps, created } = routeDependencies({
      accountId: 'account_1',
      event: {
        title: 'Embedded planning',
        startAt: 100,
        endAt: 200,
        allDay: true,
        reason: 'Detected from the source message.',
      },
    });

    const response = await createSuggestionActPost(deps as any)(request());

    expect(response.status).toBe(200);
    expect(created[0]).toMatchObject({
      title: 'Embedded planning',
      startAt: 100,
      endAt: 200,
      allDay: true,
      description: 'Created from email by Albatross. Detected from the source message.',
    });
  });

  test('returns 422 and never mutates the provider for an unsafe attachment event', async () => {
    const { deps, created } = routeDependencies({
      accountId: 'account_1',
      messageId: 'message_1',
      attachmentId: 'attachment_1',
    });
    deps.requireNylas = () =>
      ({
        attachments: {
          download: async () => VALID_ICS.replace('DTEND:20260724T150000Z', 'DTEND:20260924T150000Z'),
        },
      }) as any;

    const response = await createSuggestionActPost(deps as any)(request());

    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({
      ok: false,
      error: 'Could not read a safe event from this email.',
    });
    expect(created).toEqual([]);
  });
});
