import { describe, expect, mock, test } from 'bun:test';
import { emptyNarrativeContext } from '../lib/narrative/context';
import { MeetingContextError, prepareNarrativeMeeting } from '../lib/narrative/meeting-prep';

const selector = { accountId: 'account', calendarId: 'calendar', eventId: 'event' };
const record = {
  title: 'Atlas launch',
  startAt: 100,
  endAt: 200,
  participants: [{ email: 'alex@example.test', name: 'Alex' }],
};
function harness() {
  const packet = {
    ...emptyNarrativeContext('meeting'),
    enabled: true,
    evidence: [
      {
        id: 'source',
        title: 'Atlas planning',
        text: 'Granola meeting: Launch decision pending QA',
        source: 'mcp:granola',
        topics: [],
        trust: 'observed' as const,
        occurredAt: 1,
        observedAt: 2,
      },
    ],
  };
  return {
    event: mock(async () => record) as any,
    context: mock(async () => packet) as any,
    generate: mock(async () => ({
      text: JSON.stringify({
        points: [{ text: 'Launch is waiting on QA.', sourceIds: ['E1'] }],
        questions: ['Is QA ready?'],
      }),
    })) as any,
  };
}
describe('narrative meeting prep', () => {
  test('uses owned calendar records, related people, aliases and current source references', async () => {
    const deps = harness();
    const result = await prepareNarrativeMeeting('owner', selector, undefined, deps);
    expect(result.mode).toBe('generated');
    expect(result.points).toEqual([{ text: 'Launch is waiting on QA.', sourceIds: ['source'] }]);
    expect(deps.event).toHaveBeenCalledWith('owner', selector);
    expect(deps.context.mock.calls[0][1]).toMatchObject({
      purpose: 'meeting',
      topic: 'event:account:event',
      query: 'Atlas launch alex@example.test Alex',
    });
    expect(deps.generate.mock.calls[0][0]).toMatchObject({
      userId: 'owner',
      maxRetries: 0,
      maxOutputTokens: 1600,
    });
    expect(deps.generate.mock.calls[0][0].prompt).toContain('"id":"E1"');
    expect(deps.context).toHaveBeenCalledTimes(2);
  });
  test('missing or cancelled events do not read private context', async () => {
    const deps = harness();
    for (const row of [null, { ...record, status: 'cancelled' }]) {
      deps.event.mockResolvedValue(row);
      await expect(prepareNarrativeMeeting('owner', selector, undefined, deps)).rejects.toBeInstanceOf(
        MeetingContextError,
      );
    }
    expect(deps.context).not.toHaveBeenCalled();
  });
  test('empty or disabled context avoids paid generation and does not infer inactivity', async () => {
    const deps = harness();
    deps.context.mockResolvedValue(emptyNarrativeContext('meeting'));
    const result = await prepareNarrativeMeeting('owner', selector, undefined, deps);
    expect(result.mode).toBe('empty');
    expect(result.context.coverage).toContain('No historical context');
    expect(deps.generate).not.toHaveBeenCalled();
  });
  test('provider errors and hallucinated citation ids return exact evidence excerpts', async () => {
    const deps = harness();
    for (const text of [
      'malformed',
      JSON.stringify({ points: [{ text: 'Fake fact', sourceIds: ['E999'] }], questions: [] }),
    ]) {
      deps.generate.mockResolvedValue({ text });
      const result = await prepareNarrativeMeeting('owner', selector, undefined, deps);
      expect(result.mode).toBe('evidence');
      expect(result.points[0].text).toBe('Granola meeting: Launch decision pending QA');
      expect(JSON.stringify(result)).not.toContain('Fake fact');
    }
    deps.generate.mockRejectedValue(new Error('private provider error'));
    expect((await prepareNarrativeMeeting('owner', selector, undefined, deps)).mode).toBe('evidence');
  });
  test('cancellation and changes while generating discard the entire result', async () => {
    const deps = harness();
    const abort = new AbortController();
    abort.abort();
    await expect(prepareNarrativeMeeting('owner', selector, abort.signal, deps)).rejects.toMatchObject({
      status: 499,
    });
    deps.event.mockResolvedValueOnce(record).mockResolvedValueOnce(null);
    await expect(prepareNarrativeMeeting('owner', selector, undefined, deps)).rejects.toMatchObject({
      status: 409,
    });
    deps.event.mockResolvedValue(record);
    const packet = await deps.context();
    deps.context.mockResolvedValueOnce(packet).mockResolvedValueOnce(emptyNarrativeContext('meeting'));
    await expect(prepareNarrativeMeeting('owner', selector, undefined, deps)).rejects.toMatchObject({
      status: 409,
    });
  });
});
