import { describe, expect, mock, test } from 'bun:test';
import { NextRequest } from 'next/server';
import { createBriefWeatherGet } from '../app/api/brief/weather/route';
import { createWorkspaceRoutes } from '../app/api/narrative/workspace/route';
import { getAiRequestContext } from '../lib/ai/context';
import { AuthRequiredError } from '../lib/auth/current-user';
import { RateLimitError } from '../lib/rate-limit';

const request = (body?: unknown) =>
  new NextRequest(
    'https://example.test/api/narrative/workspace?at=100',
    body ? { method: 'POST', body: JSON.stringify(body) } : undefined,
  );
function harness() {
  return {
    user: mock(async () => ({ userId: 'owner' })) as any,
    rate: mock(async () => undefined) as any,
    load: mock(async () => ({ enabled: true, threads: [] })) as any,
    feedback: mock(async () => ({ ok: true })) as any,
  };
}
describe('Today workspace endpoints', () => {
  test('uses authenticated owner, no-store, bounded validated commands', async () => {
    const deps = harness();
    const routes = createWorkspaceRoutes(deps);
    const response = await routes.GET(request());
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(deps.load.mock.calls[0].slice(0, 3)).toEqual(['owner', 100, false]);
    expect((await routes.POST(request({ action: 'generate', at: 100 }))).status).toBe(200);
    expect(deps.load.mock.calls[1].slice(0, 3)).toEqual(['owner', 100, true]);
    for (const body of [
      { action: 'generate', at: -1 },
      { action: 'generate', at: 100, userId: 'victim' },
      { action: 'execute', at: 100 },
      { action: 'correct', at: 100, stamp: 'a'.repeat(64), sourceIds: ['one'] },
    ]) {
      expect((await routes.POST(request(body))).status).toBe(400);
    }
    expect(deps.feedback).not.toHaveBeenCalled();
    expect((await routes.GET(new NextRequest('https://example.test/api/narrative/workspace'))).status).toBe(
      400,
    );
  });
  test('authentication, rate limits and sanitized errors', async () => {
    const deps = harness();
    const routes = createWorkspaceRoutes(deps);
    deps.user.mockRejectedValueOnce(new AuthRequiredError('No'));
    expect((await routes.GET(request())).status).toBe(401);
    expect(deps.load).not.toHaveBeenCalled();
    deps.rate.mockRejectedValueOnce(new RateLimitError('Slow', 1000, 1));
    expect((await routes.POST(request({ action: 'generate', at: 100 }))).status).toBe(429);
    deps.load.mockRejectedValue(new Error('secret credentials'));
    const error = await routes.GET(request());
    expect(error.status).toBe(503);
    expect(await error.text()).not.toContain('secret');
  });
});
describe('Today weather', () => {
  test('uses account-scoped preferences and reports, strips precise coordinates', async () => {
    const deps = {
      user: mock(async () => ({ userId: 'owner' })) as any,
      rate: mock(async () => undefined) as any,
      preferences: mock(async () => ({ timezone: 'America/New_York', briefLocationEnabled: true })) as any,
      reports: mock(async () => {
        expect(getAiRequestContext().userId).toBe('owner');
        return [{ sections: { calendar: [] } }];
      }) as any,
      weather: mock(async () => ({
        latitude: 42,
        longitude: -77,
        location: 'Rochester',
        current: { temp: 72 },
      })) as any,
    };
    const response = await createBriefWeatherGet(deps)();
    const result = await response.json();
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(result.weather).toMatchObject({ location: 'Rochester', source: 'Open-Meteo' });
    expect(result.weather.latitude).toBeUndefined();
    expect(result.weather.longitude).toBeUndefined();
    expect(deps.preferences).toHaveBeenCalledWith('owner');
    deps.weather.mockRejectedValue(new Error('Offline'));
    expect((await (await createBriefWeatherGet(deps)()).json()).weather).toBeNull();
    deps.user.mockRejectedValue(new AuthRequiredError('No'));
    expect((await createBriefWeatherGet(deps)()).status).toBe(401);
  });
});
