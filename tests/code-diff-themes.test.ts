import { expect, test } from 'bun:test';

test('code diff loads built-in themes without duplicate registrations, including module reloads', () => {
  // A fresh process exercises module initialization even when another test
  // already imported the shared Tool UI registry.
  const result = Bun.spawnSync(
    [
      process.execPath,
      '--eval',
      `
      await import('./components/tool-ui/code-diff/code-diff.tsx');
      await import('./components/tool-ui/code-diff/code-diff.tsx?reload=1');
      const { getResolvedOrResolveTheme } = await import('@pierre/diffs');
      const themes = await Promise.all(['pierre-dark', 'pierre-light'].map(getResolvedOrResolveTheme));
      console.log(JSON.stringify(themes.map(theme => ({name: theme.name, tokens: theme.settings.length}))));
    `,
    ],
    { cwd: process.cwd() },
  );
  const stderr = new TextDecoder().decode(result.stderr);
  expect(result.exitCode).toBe(0);
  expect(stderr).not.toContain('theme name already registered');
  const themes = JSON.parse(new TextDecoder().decode(result.stdout));
  expect(themes.map((theme: { name: string }) => theme.name)).toEqual(['pierre-dark', 'pierre-light']);
  expect(themes.every((theme: { tokens: number }) => theme.tokens > 0)).toBe(true);
});
