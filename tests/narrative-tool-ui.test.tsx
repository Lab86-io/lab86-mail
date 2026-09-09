import { afterEach, describe, expect, mock, test } from 'bun:test';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { NarrativeDraftAssistant } from '../components/narrative/NarrativeDraftAssistant';
import { NarrativeMeetingPrep } from '../components/narrative/NarrativeMeetingPrep';
import { emptyNarrativeContext } from '../lib/narrative/context';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const originalFetch = globalThis.fetch;
let view: ReactTestRenderer;
afterEach(async () => {
  if (view) await act(async () => view.unmount());
  globalThis.fetch = originalFetch;
});
const text = (node: any): string =>
  typeof node === 'string' ? node : (node.children || []).map(text).join('');
const button = (label: string) =>
  view.root.findAllByType('button').find((node) => text(node).trim() === label)!;
const packet = {
  ...emptyNarrativeContext('search'),
  enabled: true,
  evidence: [
    {
      id: 'one',
      title: 'Granola planning',
      text: 'Decision pending QA',
      source: 'mcp:granola',
      topics: [],
      trust: 'observed',
      occurredAt: 1,
      observedAt: 2,
    },
  ],
};
const props = { to: 'alex@example.test', subject: 'Atlas', body: 'Keep my draft', onApply: mock(() => {}) };

describe('narrative drafting interaction', () => {
  test('non-JSON proxy failures show safe draft and meeting messages', async () => {
    globalThis.fetch = (async () =>
      new Response('<html>proxy details</html>', { status: 503 })) as typeof fetch;
    await act(async () => {
      view = create(<NarrativeDraftAssistant {...props} />);
    });
    await act(async () => button('Draft with context').props.onClick());
    expect(text(view.root)).toContain('Context is unavailable');
    await act(async () => button('Generate draft').props.onClick());
    expect(text(view.root)).toContain('Your message is unchanged');
    await act(async () => view.update(<NarrativeMeetingPrep accountId="a" calendarId="c" eventId="e" />));
    await act(async () => button('Prepare meeting').props.onClick());
    expect(text(view.root)).toContain('Meeting prep is unavailable');
    expect(text(view.root)).not.toContain('proxy details');
  });
  test('context starts unchecked, generation does not edit the message, acceptance is explicit', async () => {
    const requests: Array<{ url: string; body: any }> = [];
    globalThis.fetch = (async (url, init) => {
      requests.push({ url: String(url), body: init?.body && JSON.parse(String(init.body)) });
      return Response.json(String(url).includes('/context') ? packet : { draft: 'New draft' });
    }) as typeof fetch;
    const apply = mock(() => {});
    await act(async () => {
      view = create(<NarrativeDraftAssistant {...props} onApply={apply} />);
    });
    expect(requests).toHaveLength(0);
    await act(async () => button('Draft with context').props.onClick());
    const checkbox = view.root.findByType('input');
    expect(checkbox.props.checked).toBe(false);
    expect(button('Draft with context').props['aria-expanded']).toBe(true);
    await act(async () => checkbox.props.onChange({ target: { checked: true } }));
    await act(async () => button('Generate draft').props.onClick());
    expect(requests.at(-1)?.body).toMatchObject({
      contextIds: ['one'],
      contextVersions: { one: '' },
      instructions: 'Existing draft:\nKeep my draft',
    });
    expect(apply).not.toHaveBeenCalled();
    await act(async () =>
      view.root
        .findByProps({ 'aria-label': 'Suggested email draft' })
        .props.onChange({ target: { value: 'Edited preview' } }),
    );
    await act(async () => button('Use draft').props.onClick());
    expect(apply).toHaveBeenCalledWith('Edited preview');
    expect(requests.some((request) => request.url === '/api/compose')).toBe(false);
  });
  test('cancel aborts in-flight generation; recipient changes invalidate the context and preview', async () => {
    let finish: (response: Response) => void = () => {};
    let signal: AbortSignal | undefined;
    globalThis.fetch = (async (url, init) => {
      if (String(url).includes('/context')) return Response.json(packet);
      signal = init?.signal as AbortSignal;
      return new Promise<Response>((resolve) => {
        finish = resolve;
      });
    }) as typeof fetch;
    await act(async () => {
      view = create(<NarrativeDraftAssistant {...props} />);
    });
    await act(async () => button('Draft with context').props.onClick());
    await act(async () => button('Generate draft').props.onClick());
    await act(async () => button('Cancel').props.onClick());
    expect(signal?.aborted).toBe(true);
    await act(async () => finish(Response.json({ draft: 'Too late' })));
    expect(text(view.root)).not.toContain('Use draft');
    await act(async () => button('Draft with context').props.onClick());
    await act(async () =>
      view.root.findByType('textarea').props.onChange({ target: { value: 'Keep my instructions' } }),
    );
    await act(async () => view.update(<NarrativeDraftAssistant {...props} to="someone-else@example.test" />));
    expect(view.root.findAllByType('input')).toHaveLength(0);
    expect(button('Draft with context').props['aria-expanded']).toBe(true);
    expect(view.root.findByType('textarea').props.value).toBe('Keep my instructions');
    await act(async () => view.update(<NarrativeDraftAssistant {...props} topic="mail:another-thread" />));
    expect(button('Draft with context').props['aria-expanded']).toBe(false);
  });
  test('disabled memory and network errors preserve manual drafting and show actionable states', async () => {
    let fail = false;
    globalThis.fetch = (async () =>
      fail
        ? Response.json({ error: 'Context changed' }, { status: 409 })
        : Response.json(emptyNarrativeContext('search'))) as typeof fetch;
    await act(async () => {
      view = create(<NarrativeDraftAssistant {...props} />);
    });
    await act(async () => button('Draft with context').props.onClick());
    expect(text(view.root)).toContain('Narrative memory is off');
    expect(button('Generate draft').props.disabled).toBe(false);
    fail = true;
    await act(async () => button('Generate draft').props.onClick());
    expect(text(view.root.findByProps({ role: 'alert' }))).toContain('Context changed');
    await act(async () => button('Refresh context').props.onClick());
    expect(text(view.root)).not.toContain('Use draft');
  });
  test('editing the message preserves instructions but invalidates selected evidence and late drafts', async () => {
    let finish: (response: Response) => void = () => {};
    let signal: AbortSignal | undefined;
    const requests: any[] = [];
    globalThis.fetch = (async (url, init) => {
      if (String(url).includes('/context')) return Response.json(packet);
      requests.push(JSON.parse(String(init?.body)));
      signal = init?.signal as AbortSignal;
      return new Promise<Response>((resolve) => {
        finish = resolve;
      });
    }) as typeof fetch;
    await act(async () => {
      view = create(<NarrativeDraftAssistant {...props} />);
    });
    await act(async () => button('Draft with context').props.onClick());
    await act(async () =>
      view.root.findByType('textarea').props.onChange({ target: { value: 'Keep it short' } }),
    );
    await act(async () => view.root.findByType('input').props.onChange({ target: { checked: true } }));
    await act(async () => button('Generate draft').props.onClick());
    await act(async () =>
      view.update(<NarrativeDraftAssistant {...props} body="Updated message" subject="Updated subject" />),
    );
    expect(signal?.aborted).toBe(true);
    await act(async () => finish(Response.json({ draft: 'Obsolete draft' })));
    expect(button('Draft with context').props['aria-expanded']).toBe(true);
    expect(view.root.findByType('textarea').props.value).toBe('Keep it short');
    expect(view.root.findAllByType('input')).toHaveLength(0);
    expect(text(view.root)).not.toContain('Use draft');
    await act(async () => button('Generate draft').props.onClick());
    expect(requests.at(-1)).toMatchObject({ contextIds: [], subject: 'Updated subject' });
    expect(requests.at(-1).instructions).toContain('Updated message');
  });
});

describe('meeting prep interaction', () => {
  const selector = { accountId: 'a', calendarId: 'c', eventId: 'e' };
  test('runs on demand with source links and honest fallback; changing event resets prep', async () => {
    const requests: any[] = [];
    globalThis.fetch = (async (_url, init) => {
      requests.push(JSON.parse(String(init?.body)));
      return Response.json({
        context: packet,
        points: [{ text: 'Decision pending QA', sourceIds: ['one'] }],
        questions: ['Is QA done?'],
        mode: 'evidence',
      });
    }) as typeof fetch;
    await act(async () => {
      view = create(<NarrativeMeetingPrep {...selector} />);
    });
    expect(requests).toHaveLength(0);
    await act(async () => button('Prepare meeting').props.onClick());
    expect(requests).toEqual([selector]);
    expect(text(view.root)).toContain('Showing source excerpts');
    expect(view.root.findByType('a').props.href).toBe('/narrative?id=one');
    await act(async () => view.update(<NarrativeMeetingPrep {...selector} eventId="different" />));
    expect(text(view.root)).not.toContain('Decision pending QA');
  });
  test('handles no evidence, errors, and cancellation without changing the calendar', async () => {
    let response = Response.json({
      context: emptyNarrativeContext('meeting'),
      mode: 'empty',
      points: [],
      questions: [],
    });
    globalThis.fetch = (async () => response) as typeof fetch;
    await act(async () => {
      view = create(<NarrativeMeetingPrep {...selector} />);
    });
    await act(async () => button('Prepare meeting').props.onClick());
    expect(text(view.root)).toContain('No related history');
    response = Response.json({ error: 'Reconnect calendar' }, { status: 404 });
    await act(async () => button('Refresh prep').props.onClick());
    expect(text(view.root.findByProps({ role: 'alert' }))).toBe('Reconnect calendar');
    let signal: AbortSignal | undefined;
    globalThis.fetch = (async (_url, init) => {
      signal = init?.signal as AbortSignal;
      return new Promise(() => {});
    }) as typeof fetch;
    await act(async () => button('Prepare meeting').props.onClick());
    await act(async () => button('Cancel').props.onClick());
    expect(signal?.aborted).toBe(true);
    expect(text(view.root)).not.toContain('Preparing from your history');
  });
});
