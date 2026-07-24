import { describe, expect, it } from 'bun:test';
import {
  BRIEF_FONT_FAMILIES,
  briefThemeTokens,
  postBriefTheme,
  readBriefTheme,
} from '../lib/theme/brief-theme';

describe('briefThemeTokens', () => {
  it('mirrors resolved app variables into --brief-* tokens', () => {
    const vars: Record<string, string> = {
      '--color-bg': ' #101014 ',
      '--color-text': '#f5f5f5',
      '--color-text-muted': '#9a9a9a',
      '--color-border': '#2a2a30',
      '--color-accent': 'oklch(70% 0.12 210)',
      '--color-accent-soft': 'rgba(20,120,200,0.14)',
      '--color-accent-2': 'oklch(73% 0.09 70)',
      '--color-accent-3': 'oklch(73% 0.06 320)',
      '--color-bg-elevated': '#1b1b21',
      '--color-surface-well': '#0c0c10',
      '--color-surface-float': '#26262d',
    };
    const theme = briefThemeTokens((name) => vars[name] ?? '', 'news');
    expect(theme['--brief-bg']).toBe('#101014');
    expect(theme['--brief-ink']).toBe('#f5f5f5');
    expect(theme['--brief-muted']).toBe('#9a9a9a');
    expect(theme['--brief-hairline']).toBe('#2a2a30');
    expect(theme['--brief-accent']).toBe('oklch(70% 0.12 210)');
    expect(theme['--brief-accent-soft']).toBe('rgba(20,120,200,0.14)');
    expect(theme['--brief-accent-2']).toBe('oklch(73% 0.09 70)');
    expect(theme['--brief-accent-3']).toBe('oklch(73% 0.06 320)');
    expect(theme['--brief-card']).toBe('#1b1b21');
    expect(theme['--brief-well']).toBe('#0c0c10');
    expect(theme['--brief-float']).toBe('#26262d');
    expect(theme['--brief-font-display']).toBe(BRIEF_FONT_FAMILIES.news);
    expect(theme['--brief-font-body']).toBe(BRIEF_FONT_FAMILIES.sans);
    expect(theme['--brief-display-tracking']).toBe('0em');
  });

  it('falls back to the light defaults when variables are unresolved', () => {
    const theme = briefThemeTokens(() => '', null);
    expect(theme['--brief-bg']).toBe('#faf9f6');
    expect(theme['--brief-ink']).toBe('#1a1a1a');
    expect(theme['--brief-accent']).toBe('#c2683c');
    // The second accent falls back to a warm editorial default distinct from
    // the terracotta accent.
    expect(theme['--brief-accent-2']).toBe('#774914');
    expect(theme['--brief-accent-2']).not.toBe(theme['--brief-accent']);
    // The third voice and the depth rungs fall back against the warm paper.
    expect(theme['--brief-accent-3']).toBe('#305880');
    expect(theme['--brief-card']).toBe('#fefdfb');
    expect(theme['--brief-well']).toBe('#f1f0eb');
    expect(theme['--brief-float']).toBe('#fffffd');
    expect(theme['--brief-font-display']).toBe(BRIEF_FONT_FAMILIES.serif);
  });

  it('gives Instrument Serif its wider display tracking', () => {
    const theme = briefThemeTokens(() => '', 'instrument');
    expect(theme['--brief-font-display']).toBe(BRIEF_FONT_FAMILIES.instrument);
    expect(theme['--brief-display-tracking']).toBe('0.045em');
  });

  it('treats unknown font keys as the serif default', () => {
    const theme = briefThemeTokens(() => '', 'wingdings');
    expect(theme['--brief-font-display']).toBe(BRIEF_FONT_FAMILIES.serif);
  });
});

describe('postBriefTheme', () => {
  it('posts the lab86-host theme message with * target', () => {
    const posted: Array<{ message: unknown; target: string }> = [];
    const win = {
      postMessage: (message: unknown, target: string) => posted.push({ message, target }),
    } as unknown as Window;
    postBriefTheme(win, 'sans');
    expect(posted).toHaveLength(1);
    expect(posted[0].target).toBe('*');
    const message = posted[0].message as { source: string; type: string; theme: Record<string, string> };
    expect(message.source).toBe('lab86-host');
    expect(message.type).toBe('theme');
    expect(message.theme['--brief-font-display']).toBe(BRIEF_FONT_FAMILIES.sans);
  });

  it('is a no-op without a window', () => {
    expect(() => postBriefTheme(null)).not.toThrow();
    expect(() => postBriefTheme(undefined)).not.toThrow();
  });
});

describe('readBriefTheme', () => {
  it('returns fallback tokens when no document is available', () => {
    const theme = readBriefTheme('grotesk');
    expect(theme['--brief-font-display']).toBe(BRIEF_FONT_FAMILIES.grotesk);
    expect(theme['--brief-bg']).toBeTruthy();
  });
});
