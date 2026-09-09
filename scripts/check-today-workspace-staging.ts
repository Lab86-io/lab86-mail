/** Read-only personal staging smoke. No consent changes, Work writes, or sends. */
import assert from 'node:assert/strict';
import { runWithAiRequestContext } from '../lib/ai/context';
import { api, convexQuery } from '../lib/hosted/convex';
import { gatherBriefWeather } from '../lib/mail/brief-weather';
import { loadNarrativeWorkspace } from '../lib/narrative/workspace-service';
import { kvList } from '../lib/store/kv';

function required(name: string) {
  const value = process.env[name];
  assert(value, `Set ${name} explicitly before running this account-scoped staging smoke.`);
  return value;
}
const expectedEnvironment = required('SMOKE_RAILWAY_ENVIRONMENT_ID');
const expectedConvex = required('SMOKE_CONVEX_URL');
const userId = required('SMOKE_USER_ID');
const expectedEmail = required('SMOKE_USER_EMAIL');
assert.notEqual(process.env.RAILWAY_ENVIRONMENT_NAME, 'production', 'This smoke is staging-only');
assert.equal(process.env.RAILWAY_ENVIRONMENT_ID, expectedEnvironment);
assert.equal(process.env.NEXT_PUBLIC_CONVEX_URL, expectedConvex);
const user = await convexQuery<any>(api.users.getByClerkId, { userId });
assert.equal(user?.email, expectedEmail);
const before = await convexQuery<any>(api.narrative.status, { userId });
assert.equal(before.settings.enabled, true, 'Existing opt-in required');
const consent = (state: any) =>
  JSON.stringify([
    state.settings.enabled,
    state.settings.sources,
    state.settings.model,
    state.settings.timezone,
  ]);
await runWithAiRequestContext(
  { userId, userEmail: user.email, userName: user.name, userTimezone: before.settings.timezone, agent: 'ai' },
  async () => {
    const reports = await kvList<any>('dailyReport', { limit: 1 });
    const at = reports[0]?.generatedAt || Date.now();
    const result = await loadNarrativeWorkspace(userId, at, true);
    assert.equal(result.enabled, true);
    assert.equal(result.mode, 'generated', 'Live model composition must succeed');
    assert(result.threads.length > 0 && result.threads.length <= 3);
    assert(
      result.threads.every(
        (t) => t.sources.length > 0 && t.sources.every((s) => s.href.startsWith('/narrative?id=')),
      ),
    );
    const weather = await gatherBriefWeather(reports[0] || { sections: {} }, userId);
    const after = await convexQuery<any>(api.narrative.status, { userId });
    assert.equal(consent(after), consent(before));
    console.log(
      JSON.stringify({
        status: 'passed',
        environment: 'staging',
        mode: result.mode,
        threads: result.threads.length,
        sources: result.threads.reduce((n, t) => n + t.sources.length, 0),
        ownedWorkLinks: result.threads.filter((t) => t.work).length,
        weather: weather
          ? { available: true, unit: weather.unit, provider: weather.source || 'Open-Meteo' }
          : { available: false },
        consent: 'unchanged',
        workWrites: 0,
        sends: 0,
      }),
    );
  },
);
