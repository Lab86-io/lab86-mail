import { beforeAll, describe, expect, test } from 'bun:test';

// The client captures provider configuration at module load. A different
// suite may have imported it before the tools harness cleared the environment,
// so prove the no-provider contract in an isolated process with explicit empty
// keys. This never changes the parent process's models, environment, or cache.
let result: {
  hasAi: boolean;
  provider: { provider: string; primary: string; fast: string };
  primary: string;
  fast: string;
  primaryError: string | null;
  fastError: string | null;
};
beforeAll(() => {
  const child = Bun.spawnSync({
    cmd: [
      process.execPath,
      '-e',
      `
      const client = await import('./lib/ai/client.ts');
      const failure = (fn) => { try { fn(); return null; } catch (error) { return error.message; } };
      console.log(JSON.stringify({
        hasAi: client.hasAi(), provider: client.describeProvider(),
        primary: client.OPENAI_PRIMARY_MODEL, fast: client.OPENAI_FAST_MODEL,
        primaryError: failure(client.primaryModel), fastError: failure(client.fastModel),
      }));
    `,
    ],
    cwd: process.cwd(),
    env: { ...process.env, OPENROUTER_API_KEY: '', OPENAI_API_KEY: '', ANTHROPIC_API_KEY: '' },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  expect(child.exitCode).toBe(0);
  result = JSON.parse(child.stdout.toString());
});

describe('ai/client provider resolution without keys', () => {
  test('hasAi is false and describeProvider reports none', () => {
    expect(result.hasAi).toBe(false);
    expect(result.provider).toEqual({ provider: 'none', primary: '', fast: '' });
  });

  test('the default model ids resolve to strings', () => {
    expect(typeof result.primary).toBe('string');
    expect(typeof result.fast).toBe('string');
  });

  test('primaryModel / fastModel throw a clear error when nothing is configured', () => {
    expect(result.primaryError).toMatch(/No AI provider configured/);
    expect(result.fastError).toMatch(/No AI provider configured/);
  });
});
