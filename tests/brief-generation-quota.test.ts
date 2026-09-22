import { expect, mock, test } from 'bun:test';
import { NextRequest } from 'next/server';
import { createToolPost } from '../app/api/tools/[name]/route';
import { AuthRequiredError } from '../lib/auth/current-user';
import { RateLimitError } from '../lib/rate-limit';

test('daily generation is authenticated and unthrottled while other tools keep their request policy', async () => {
  const deps = {
    user: mock(async () => ({ userId: 'owner' }) as any),
    rate: mock(async () => {
      throw new RateLimitError('Existing tool quota', 1000, 60);
    }),
    tool: (name: string) => ({ name, mutating: true }) as any,
    invoke: mock(async (_tool: unknown, _body: unknown, context: any) => ({ owner: context.userId })) as any,
  };
  const post = createToolPost(deps);
  const request = () =>
    new NextRequest('https://example.test/api/tools/generate_daily_report', {
      method: 'POST',
      body: JSON.stringify({ kind: 'manual', userId: 'forged' }),
    });
  const dailyRequest = request();
  const response = await post(dailyRequest, { params: Promise.resolve({ name: 'generate_daily_report' }) });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ result: { owner: 'owner' } });
  expect(deps.rate).not.toHaveBeenCalled();
  expect(deps.invoke.mock.calls[0][2].abortSignal).toBe(dailyRequest.signal);
  expect((await post(request(), { params: Promise.resolve({ name: 'send_mail' }) })).status).toBe(429);
  expect(deps.invoke).toHaveBeenCalledTimes(1);
  deps.user.mockRejectedValueOnce(new AuthRequiredError('Sign in required'));
  expect((await post(request(), { params: Promise.resolve({ name: 'generate_daily_report' }) })).status).toBe(
    401,
  );
  expect(deps.invoke).toHaveBeenCalledTimes(1);
});
