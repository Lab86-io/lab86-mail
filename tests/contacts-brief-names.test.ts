import { describe, expect, mock, test } from 'bun:test';
import { extractPeople, loadBriefContactNames } from '../lib/mail/daily-report';
import { emptyNarrativeContext } from '../lib/narrative/context';
import { meetingPeople, prepareNarrativeMeeting } from '../lib/narrative/meeting-prep';

const thread: any = { _id: 't1', account: 'acct', fromAddress: 'ann@acme.com', subject: 'Plan' };
const messages: any[] = [
  { from: 'ann@acme.com', to: 'me@lab86.io, "bob" <bob@acme.com>', cc: 'Cy Young <cy@acme.com>' },
];
const self = new Set(['me@lab86.io']);

describe('Brief people use saved names', () => {
  test('a bare address gets the saved name; a real header name stays', () => {
    const names = new Map([
      ['ann@acme.com', 'Ann Lee'],
      ['bob@acme.com', 'Robert Stone'],
      ['cy@acme.com', 'Cyrus Young'],
    ]);
    expect(extractPeople(thread, messages, self, names)).toEqual(['Ann Lee', 'Robert Stone', 'Cy Young']);
    expect(extractPeople(thread, messages, self)).toEqual(['ann@acme.com', 'bob', 'Cy Young']);
  });

  test('one lookup for the weak, non-self addresses of every thread', async () => {
    const calls: any[] = [];
    const lookup = async (userId: string, emails: string[]) => {
      calls.push({ userId, emails: [...emails].sort() });
      return new Map([['ann@acme.com', 'Ann Lee']]);
    };
    const byKey = new Map([['acct:t1', messages]]);
    const names = await loadBriefContactNames('user_1', [thread], byKey, self, lookup);
    expect(names.get('ann@acme.com')).toBe('Ann Lee');
    expect(calls).toEqual([{ userId: 'user_1', emails: ['ann@acme.com', 'bob@acme.com'] }]);
    expect(await loadBriefContactNames(null, [thread], byKey, self, lookup)).toEqual(new Map());
    const strong: any = { ...thread, fromAddress: 'Ann Lee <ann@acme.com>' };
    expect(await loadBriefContactNames('user_1', [strong], new Map(), self, lookup)).toEqual(new Map());
    const failing = async () => {
      throw new Error('down');
    };
    expect(await loadBriefContactNames('user_1', [thread], byKey, self, failing)).toEqual(new Map());
  });
});

describe('meeting prep uses saved names', () => {
  const event = {
    title: 'Atlas launch',
    startAt: 100,
    endAt: 200,
    participants: [{ email: 'Ann@acme.com' }, { email: 'bob@acme.com', name: 'Bob' }, { name: 'Room 4' }],
    organizer: { email: 'cy@acme.com', name: '  ' },
  };

  test('attendees listed by address get the saved name', async () => {
    const lookup = mock(async () => new Map([['ann@acme.com', 'Ann Lee']]));
    expect(await meetingPeople('u', event, lookup)).toEqual([
      { email: 'Ann@acme.com', name: 'Ann Lee' },
      { email: 'bob@acme.com', name: 'Bob' },
      { email: undefined, name: 'Room 4' },
      { email: 'cy@acme.com', name: undefined },
    ]);
    expect(lookup).toHaveBeenCalledWith('u', ['ann@acme.com', 'cy@acme.com']);
    const failing = mock(async () => {
      throw new Error('down');
    });
    expect((await meetingPeople('u', event, failing))[0].name).toBeUndefined();
    const none = mock(async () => new Map());
    await meetingPeople('u', { ...event, participants: [], organizer: undefined } as any, none);
    expect(none).not.toHaveBeenCalled();
  });

  test('the prep query and prompt carry the saved name, with no extra model call', async () => {
    const context = mock(async () => ({ ...emptyNarrativeContext('meeting'), enabled: true, evidence: [] }));
    const generate = mock(async () => ({ text: '{}' }));
    const result = await prepareNarrativeMeeting(
      'u',
      { accountId: 'a', calendarId: 'c', eventId: 'e' },
      undefined,
      {
        event: mock(async () => event) as any,
        context: context as any,
        generate: generate as any,
        names: async () => new Map([['ann@acme.com', 'Ann Lee']]),
      },
    );
    expect(result.mode).toBe('empty');
    expect((context.mock.calls[0] as any)[1].query).toContain('Ann Lee');
    expect(generate).not.toHaveBeenCalled();
  });
});
