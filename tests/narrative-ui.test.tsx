import { describe, expect, test } from 'bun:test';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  NARRATIVE_LIMITS_COPY,
  NarrativeSearchButton,
  NarrativeSettings,
} from '../components/narrative/Narrative';
import { NarrativeBrief } from '../components/narrative/NarrativeBrief';
import { BRIEF_MAX_OUTPUT_TOKENS, maxOutputTokensForFeature } from '../lib/ai/gateway';

function render(node: ReactNode, key: unknown[], data: unknown) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(key, data);
  const html = renderToStaticMarkup(<QueryClientProvider client={client}>{node}</QueryClientProvider>);
  client.clear();
  return html;
}
describe('narrative surfaces', () => {
  test('search advertises its actual global shortcut, not the assistant shortcut', () => {
    const html = renderToStaticMarkup(<NarrativeSearchButton />);
    expect(html).toContain('aria-keyshortcuts="/"');
    expect(html).toContain('Search everything (slash)');
    expect(html).not.toContain('⌘K');
  });
  test('consent starts unselected, enabling is disabled, and destructive action asks for confirmation', () => {
    const html = render(<NarrativeSettings />, ['narrative', 'status'], {
      available: true,
      settings: { enabled: false, sources: [], model: 'z-ai/glm-5.3-flash' },
      sources: [{ id: 'chat', label: 'What you say in chats', status: 'ready' }],
    });
    expect(html).toContain('type="checkbox"');
    expect(html).not.toContain('checked=""');
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Enable narrative memory<\/button>/);
    expect(html).toContain('Forget all narrative memory…');
    expect(html).not.toContain('Confirm: forget narrative');
    expect(html).toContain('OpenRouter');
    // The settings copy states the limits the code enforces, and never says AI.
    const text = html.replace(/<[^>]*>/g, ' ');
    expect(text).not.toMatch(/\bAI\b/);
    expect(text).not.toContain('24 per day');
    expect(text).not.toContain('$0.50');
    expect(text).toContain(NARRATIVE_LIMITS_COPY);
  });
  test('the stated output limit is the gateway cap for narrative calls', () => {
    expect(NARRATIVE_LIMITS_COPY).toContain(BRIEF_MAX_OUTPUT_TOKENS.toLocaleString('en-US'));
    expect(maxOutputTokensForFeature('narrative_write')).toBe(BRIEF_MAX_OUTPUT_TOKENS);
  });
  test('unavailable pilot does not display active consent controls', () => {
    const html = render(<NarrativeSettings />, ['narrative', 'status'], { available: false });
    expect(html).toContain('not enabled for this account');
    expect(html).not.toContain('type="checkbox"');
  });
  test('Today uses live permission-checked narrative and source links, then reverts when revoked', () => {
    const node = <NarrativeBrief at={123} fallback={<p>Original brief</p>} />;
    const html = render(node, ['narrative', 'brief', 123], {
      enabled: true,
      entry: { _id: 'chapter', text: 'Your revised plan', model: 'glm', sourceIds: ['one', 'two'] },
    });
    expect(html.replace(/<[^>]*>/g, '')).toContain('Your revised plan');
    expect(html).toContain('/narrative?id=chapter');
    expect(html).not.toContain('Original brief');
    const revoked = render(node, ['narrative', 'brief', 123], { enabled: false, entry: null });
    expect(revoked).toContain('Original brief');
    expect(revoked).not.toContain('Your revised plan');
  });
});
