import { afterEach, expect, mock, test } from 'bun:test';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { useEventDialogOpen } from '../components/calendar/engine/event-details-dialog';
import { NarrativeSettings, ObservationCard } from '../components/narrative/Narrative';
import { narrativeBriefPollInterval } from '../components/narrative/NarrativeBrief';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const originalFetch = globalThis.fetch;
let view: ReactTestRenderer | undefined;
let client: QueryClient | undefined;
afterEach(async () => {
  if (view) await act(async () => view!.unmount());
  client?.clear();
  globalThis.fetch = originalFetch;
});
const text = (node: any): string =>
  typeof node === 'string' ? node : (node.children || []).map(text).join('');
const button = (label: string) => view!.root.findAllByType('button').find((node) => text(node) === label)!;
const wrap = (node: React.ReactNode) => <QueryClientProvider client={client!}>{node}</QueryClientProvider>;

test('dialog observers work in uncontrolled mode and controlled mode delegates changes', async () => {
  let state: ReturnType<typeof useEventDialogOpen>;
  const change = mock(() => {});
  function Harness({ open }: { open?: boolean }) {
    state = useEventDialogOpen(open, change);
    return null;
  }
  await act(async () => {
    view = create(<Harness />);
  });
  await act(async () => state[1](true));
  expect(state![0]).toBe(true);
  expect(change).toHaveBeenCalledWith(true);
  await act(async () => view!.update(<Harness open={false} />));
  await act(async () => state[1](true));
  expect(state![0]).toBe(false);
});

test('brief polling stops when disabled or settled', () => {
  expect(narrativeBriefPollInterval()).toBe(false);
  expect(narrativeBriefPollInterval({ enabled: false, running: true })).toBe(false);
  expect(narrativeBriefPollInterval({ enabled: true, running: false })).toBe(false);
  expect(narrativeBriefPollInterval({ enabled: true, running: true })).toBe(8000);
});

test('correction editor uses the latest entry and preserves typing during refetches', async () => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const entry = {
    _id: 'one',
    title: 'Plan',
    text: 'Original',
    trust: 'reported',
    occurredAt: 1,
    observedAt: 1,
  } as any;
  const render = (value: string) =>
    wrap(<ObservationCard entry={{ ...entry, text: value }} onChange={() => {}} />);
  await act(async () => {
    view = create(render('Original'));
  });
  await act(async () => view!.update(render('New source text')));
  await act(async () => button('Correct').props.onClick());
  expect(view!.root.findByType('textarea').props.value).toBe('New source text');
  await act(async () =>
    view!.root.findByType('textarea').props.onChange({ target: { value: 'My correction' } }),
  );
  await act(async () => view!.update(render('Another refresh')));
  await act(async () => button('Correct').props.onClick());
  expect(view!.root.findByType('textarea').props.value).toBe('My correction');
});

test('proxy HTML errors have an actionable narrative message', async () => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  globalThis.fetch = (async () => new Response('<html>proxy failed</html>', { status: 502 })) as typeof fetch;
  await act(async () => {
    view = create(wrap(<NarrativeSettings />));
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  expect(text(view!.root.findByProps({ role: 'alert' }))).toContain('Narrative request failed');
});

test('turning memory off clears unsaved local source selections', async () => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  let enabled = true;
  const data = () => ({
    available: true,
    settings: { enabled, sources: enabled ? ['chat'] : [], model: 'current' },
    sources: [
      { id: 'chat', label: 'Chat', status: 'ready' },
      { id: 'work', label: 'Work', status: 'ready' },
    ],
  });
  client.setQueryData(['narrative', 'status'], data());
  globalThis.fetch = (async (_url, init) => {
    if (init?.method === 'POST') {
      enabled = false;
      return Response.json({ ok: true });
    }
    return Response.json(data());
  }) as typeof fetch;
  await act(async () => {
    view = create(wrap(<NarrativeSettings />));
  });
  const work = view!.root.findAllByType('input')[1];
  await act(async () => work.props.onChange({ target: { checked: true } }));
  await act(async () => button('Turn off and remove memory').props.onClick());
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  expect(view!.root.findAllByType('input').every((node) => !node.props.checked)).toBe(true);
});
