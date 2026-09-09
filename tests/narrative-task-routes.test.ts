import { describe, expect, mock, test } from 'bun:test';
import { NextRequest } from 'next/server';
import { createNarrativeContextGet } from '../app/api/narrative/context/route';
import { createNarrativeMeetingPost } from '../app/api/narrative/meeting/route';
import { AuthRequiredError } from '../lib/auth/current-user';
import { emptyNarrativeContext } from '../lib/narrative/context';
import { MeetingContextError } from '../lib/narrative/meeting-prep';
import { RateLimitError } from '../lib/rate-limit';

function harness() {
  return {
    user: mock(async () => ({ userId: 'owner', email: 'owner@example.test' })) as any,
    rate: mock(async () => undefined) as any,
    context: mock(async () => emptyNarrativeContext('search')) as any,
    prepare: mock(async () => ({ mode: 'empty' })) as any,
  };
}
const meeting = (body: any = { accountId: 'a', calendarId: 'c', eventId: 'e' }) =>
  new NextRequest('https://example.test/api/narrative/meeting', {
    method: 'POST',
    body: JSON.stringify(body),
  });
describe('task context endpoints', () => {
  test('malformed authenticated meeting requests still consume the quota', async () => {
    const deps = harness();
    expect((await createNarrativeMeetingPost(deps)(meeting({}))).status).toBe(400);
    expect(deps.rate).toHaveBeenCalledTimes(1);
    deps.rate.mockRejectedValueOnce(new RateLimitError('Slow down', 1000, 1));
    expect((await createNarrativeMeetingPost(deps)(meeting({}))).status).toBe(429);
    expect(deps.prepare).not.toHaveBeenCalled();
  });
  test('context is private and tenant identity is server-owned', async () => {
    const deps = harness();
    const response = await createNarrativeContextGet(deps)(
      new NextRequest('https://example.test/api/narrative/context?q=Atlas&topic=work:one&userId=forged'),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(deps.context).toHaveBeenCalledWith('owner', {
      purpose: 'search',
      query: 'Atlas',
      topic: 'work:one',
    });
    expect(
      (
        await createNarrativeContextGet(deps)(
          new NextRequest('https://example.test/api/narrative/context?purpose=compose'),
        )
      ).status,
    ).toBe(400);
  });
  test('meeting accepts selectors only, never injected event text or tenant', async () => {
    const deps = harness();
    const response = await createNarrativeMeetingPost(deps)(
      meeting({ accountId: 'a', calendarId: 'c', eventId: 'e', title: 'Injected', userId: 'forged' }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(deps.prepare).toHaveBeenCalledWith(
      'owner',
      { accountId: 'a', calendarId: 'c', eventId: 'e' },
      expect.any(AbortSignal),
    );
    expect((await createNarrativeMeetingPost(deps)(meeting({ eventId: 'e' }))).status).toBe(400);
    deps.prepare.mockRejectedValue(new MeetingContextError('Changed', 409));
    expect((await createNarrativeMeetingPost(deps)(meeting())).status).toBe(409);
  });
  test('both endpoints protect auth, rate limits, and private errors', async () => {
    for (const kind of ['context', 'meeting']) {
      const deps = harness();
      const invoke = () =>
        kind === 'context'
          ? createNarrativeContextGet(deps)(new NextRequest('https://example.test/api/narrative/context'))
          : createNarrativeMeetingPost(deps)(meeting());
      deps.user.mockRejectedValueOnce(new AuthRequiredError('Private'));
      expect((await invoke()).status).toBe(401);
      deps.rate.mockRejectedValueOnce(new RateLimitError('Slow down', 1000, 1));
      expect((await invoke()).status).toBe(429);
      deps[kind === 'context' ? 'context' : 'prepare'].mockRejectedValueOnce(
        new Error('private database details'),
      );
      const response = await invoke();
      expect(response.status).toBe(503);
      expect(await response.text()).not.toContain('private database');
    }
  });
});
