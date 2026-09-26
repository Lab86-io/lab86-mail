import { afterEach, expect, mock, test } from 'bun:test';
import { useState } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { ModelPicker, type ModelPickerProps } from '../components/settings/ModelPicker';
import { ProviderGlyph } from '../components/settings/ProviderGlyph';
import { buildModelCatalog } from '../lib/ai/model-catalog';
import {
  loadPinnedModels,
  PINNED_MODELS_KEY,
  readDevicePinnedModels,
  resetPinnedModels,
  savePinnedModels,
  togglePinnedModel,
} from '../lib/shell/pinned-models';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
let view: ReactTestRenderer;
const catalog = buildModelCatalog();
const glm = 'z-ai/glm-5.3-flash';
const base = { slot: 'normal' as const, value: glm, catalog, onChange: () => {} };

test('provider logos inherit the theme foreground while retaining explicit brand fills', () => {
  const mono = renderToStaticMarkup(<ProviderGlyph provider="openai" />);
  expect(mono).toContain('fill="currentColor"');
  const brand = renderToStaticMarkup(<ProviderGlyph provider="google" />);
  expect(brand).toContain('fill="currentColor"');
  expect(brand).toMatch(/fill="url\(#[^"]+-google-0\)"/);
});

test('each provider logo resolves gradients within its own SVG instance', () => {
  const html = renderToStaticMarkup(
    <>
      <ProviderGlyph provider="google" />
      <ProviderGlyph provider="google" />
      <ProviderGlyph provider="qwen" />
      <ProviderGlyph provider="qwen" />
    </>,
  );
  const ids = [...html.matchAll(/id="([^"]+)"/g)].map((match) => match[1]);
  expect(ids).toHaveLength(8);
  expect(new Set(ids).size).toBe(ids.length);
  for (const [svg] of html.matchAll(/<svg\b[\s\S]*?<\/svg>/g)) {
    for (const [, id] of svg.matchAll(/fill="url\(#([^)]+)\)"/g)) expect(svg).toContain(`id="${id}"`);
  }
});
afterEach(async () => {
  if (view) await act(async () => view.unmount());
  resetPinnedModels();
});
const buttons = () => view.root.findAllByType('button');
const button = (name: string) => buttons().find((node) => node.props['aria-label'] === name)!;
const rows = () => buttons().filter((node) => node.props['data-model-id']);
const text = (node: any): string =>
  typeof node === 'string' ? node : (node.children || []).map(text).join('');
async function mount(props: Partial<ModelPickerProps> = {}) {
  const onChange = mock((_id: string) => {});
  await act(async () => {
    view = create(<ModelPicker {...base} onChange={onChange} {...props} />);
  });
  return onChange;
}
async function click(name: string) {
  await act(async () => button(name).props.onClick());
}
async function search(query: string) {
  await act(async () => view.root.findByType('input').props.onChange({ target: { value: query } }));
}

test('the Odyssey panel and model choices render immediately without a trigger or popup', () => {
  const html = renderToStaticMarkup(<ModelPicker {...base} id="normal-search" />);
  expect(html).toContain('data-slot="model-selector-panel"');
  expect(html).toContain('data-model-id="z-ai/glm-5.3-flash"');
  expect(html).toContain('id="normal-search"');
  expect(html).not.toContain('role="dialog"');
  expect(html).not.toContain('aria-haspopup');
  expect(html).not.toContain('model-picker-trigger');
});

test('selecting changes the controlled choice without closing the panel or clearing its search', async () => {
  function Harness() {
    const [value, setValue] = useState('openai/gpt-5.5');
    return <ModelPicker {...base} value={value} onChange={setValue} />;
  }
  await act(async () => {
    view = create(<Harness />);
  });
  await search('z.ai flash');
  expect(rows().map((row) => row.props['data-model-id'])).toEqual([glm]);
  await click('Select GLM-5.3 Flash');
  expect(button('Select GLM-5.3 Flash').props['aria-pressed']).toBe(true);
  expect(view.root.findByType('input').props.value).toBe('z.ai flash');
  expect(view.root.findByType('section').props['data-slot']).toBe('model-selector-panel');
  expect(text(view.root)).toContain('Selected: GLM-5.3 Flash');
});

test('provider filters toggle and combine with search; text-only models stay excluded', async () => {
  await mount();
  await click('Anthropic');
  expect(rows().length).toBeGreaterThan(0);
  expect(rows().every((row) => row.props['data-model-id'].startsWith('anthropic/'))).toBe(true);
  await search('HAIKU');
  expect(rows().map((row) => row.props['data-model-id'])).toEqual(['anthropic/claude-haiku-4.5']);
  await click('Clear search');
  await click('Anthropic');
  expect(rows().some((row) => row.props['data-model-id'] === glm)).toBe(true);
  await search('deepseek');
  expect(rows()).toHaveLength(0);
  expect(text(view.root)).toContain('No vision models match');
});

test('pinning is separate from selecting, and pins can be filtered and removed', async () => {
  const change = await mount();
  await click('Pin GLM-5.3 Flash');
  expect(change).not.toHaveBeenCalled();
  expect(button('Unpin GLM-5.3 Flash').props['aria-pressed']).toBe(true);
  await click('Pinned models');
  expect(rows().map((row) => row.props['data-model-id'])).toEqual([glm]);
  await click('Unpin GLM-5.3 Flash');
  expect(rows()).toHaveLength(0);
  await click('All providers');
  expect(rows().length).toBeGreaterThan(1);
  expect(buttons().every((node) => node.findAllByType('button').length === 1)).toBe(true);
});

test('normal and fast selectors keep independent searches, favorites and selections', async () => {
  const normalChange = mock(() => {});
  const fastChange = mock(() => {});
  await act(async () => {
    view = create(
      <>
        <ModelPicker {...base} onChange={normalChange} />
        <ModelPicker {...base} slot="fast" onChange={fastChange} />
      </>,
    );
  });
  const panels = view.root.findAllByType('section');
  await act(async () => panels[0].findByType('input').props.onChange({ target: { value: 'glm' } }));
  expect(panels[1].findByType('input').props.value).toBe('');
  await act(async () =>
    panels[0]
      .findAllByType('button')
      .find((b) => b.props['data-model-id'] === glm)!
      .props.onClick(),
  );
  expect(normalChange).toHaveBeenCalledWith(glm);
  expect(fastChange).not.toHaveBeenCalled();
  expect(panels[0].findByType('ul').props.id).not.toBe(panels[1].findByType('ul').props.id);
});

test('disabled panels disable search, filters, favorites, rows and tier controls', async () => {
  const change = await mount({ slot: 'fast', disabled: true });
  expect(view.root.findByType('input').props.disabled).toBe(true);
  expect(buttons().every((node) => node.props.disabled)).toBe(true);
  await click('Select GLM-5.3 Flash');
  await click('Pin GLM-5.3 Flash');
  expect(change).not.toHaveBeenCalled();
  expect(button('Pin GLM-5.3 Flash')).toBeDefined();
});

test('a changed provider catalog and externally changed value update the persistent panel', async () => {
  await mount();
  await click('Z.ai');
  await act(async () =>
    view.update(
      <ModelPicker
        {...base}
        catalog={buildModelCatalog({ provider: 'anthropic' })}
        value="anthropic/claude-haiku-4.5"
      />,
    ),
  );
  expect(rows().length).toBeGreaterThan(0);
  expect(rows().every((row) => row.props['data-model-id'].startsWith('anthropic/'))).toBe(true);
  expect(button('Select Claude Haiku 4.5').props['aria-pressed']).toBe(true);
  expect(button('Z.ai')).toBeUndefined();
});

test('fast tiers and older models can be expanded without exposing retired choices', async () => {
  await mount({ slot: 'fast', value: '' });
  expect(button('Select GPT-5.5')).toBeUndefined();
  await act(async () =>
    buttons()
      .find((b) => text(b) === 'Show all tiers')!
      .props.onClick(),
  );
  expect(button('Select GPT-5.5')).toBeDefined();
  await act(async () =>
    buttons()
      .find((b) => text(b) === 'Show older models')!
      .props.onClick(),
  );
  expect(
    rows().some((row) => catalog.find((m) => m.id === row.props['data-model-id'])?.status === 'legacy'),
  ).toBe(true);
  expect(
    rows().every((row) => catalog.find((m) => m.id === row.props['data-model-id'])?.status !== 'deprecated'),
  ).toBe(true);
});

test('unknown, retired and empty saved choices render safely with an available list', async () => {
  for (const value of ['unknown/model', 'openai/gpt-5.1-chat', '']) {
    const html = renderToStaticMarkup(<ModelPicker {...base} value={value} />);
    expect(html).toContain('Select GLM-5.3 Flash');
    expect(html).toContain(value ? 'Saved model unavailable' : 'Choose a model above');
  }
  const html = renderToStaticMarkup(<ModelPicker {...base} catalog={[]} />);
  expect(html).toContain('No vision models match');
});

/** A fake /api/prefs that keeps the pinned models for one user. */
function prefsServer(initial: string[] = [], options: { failSaves?: boolean } = {}) {
  let saved = [...initial];
  const posts: string[][] = [];
  const fetcher = mock(async (url: string, init?: RequestInit) => {
    expect(url).toBe('/api/prefs');
    if (init?.method !== 'POST')
      return Response.json({ ok: true, prefs: { undoSendSeconds: 10, pinnedModels: saved } });
    const body = JSON.parse(String(init.body));
    posts.push(body.pinnedModels);
    if (options.failSaves) return Response.json({ ok: false, error: 'down' }, { status: 500 });
    saved = body.pinnedModels;
    return Response.json({ ok: true, prefs: { pinnedModels: saved } });
  });
  return { fetcher, posts, saved: () => saved };
}

function deviceStore(value?: string) {
  const saved = new Map<string, string>(value === undefined ? [] : [[PINNED_MODELS_KEY, value]]);
  return {
    saved,
    getItem: (key: string) => saved.get(key) ?? null,
    setItem: (key: string, next: string) => void saved.set(key, next),
    removeItem: (key: string) => void saved.delete(key),
  };
}

async function withFetch<T>(fetcher: typeof fetch | ((...args: any[]) => any), run: () => Promise<T>) {
  const previous = globalThis.fetch;
  globalThis.fetch = fetcher as typeof fetch;
  try {
    return await run();
  } finally {
    globalThis.fetch = previous;
  }
}

const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 0)));

test('pins are saved for the user on the server and survive a reload', async () => {
  const server = prefsServer();
  await withFetch(server.fetcher, async () => {
    await mount();
    await settle();
    await click('Pin GLM-5.3 Flash');
    await settle();
    expect(server.saved()).toEqual([glm]);
    await act(async () => view.unmount());
    // A reload starts with no shared copy and reads the server list.
    resetPinnedModels();
    await mount();
    await settle();
    expect(button('Unpin GLM-5.3 Flash').props['aria-pressed']).toBe(true);
  });
});

test('a pin made before the server list loads is added to that list', async () => {
  const server = prefsServer(['openai/gpt-5.5']);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const slow = async (url: string, init?: RequestInit) => {
    if (init?.method !== 'POST') await gate;
    return server.fetcher(url, init);
  };
  await withFetch(slow, async () => {
    await mount();
    await click('Pin GLM-5.3 Flash');
    expect(server.posts).toEqual([]);
    release();
    await settle();
    await settle();
    expect(server.saved()).toEqual(['openai/gpt-5.5', glm]);
    expect(button('Unpin GLM-5.3 Flash').props['aria-pressed']).toBe(true);
    expect(button('Unpin GPT-5.5').props['aria-pressed']).toBe(true);
  });
});

test('a failed save puts the earlier pins back', async () => {
  const server = prefsServer([], { failSaves: true });
  await withFetch(server.fetcher, async () => {
    await mount();
    await settle();
    await click('Pin GLM-5.3 Flash');
    await settle();
    expect(server.posts).toEqual([[glm]]);
    expect(button('Pin GLM-5.3 Flash').props['aria-pressed']).toBe(false);
  });
});

test('device pins from an earlier version move to the server once, then leave the device', async () => {
  const server = prefsServer(['b/model']);
  const store = deviceStore(JSON.stringify(['a/model', 'b/model']));
  expect(await loadPinnedModels(server.fetcher, store)).toEqual(new Set(['a/model', 'b/model']));
  expect(server.posts).toEqual([['a/model', 'b/model']]);
  expect(store.saved.has(PINNED_MODELS_KEY)).toBe(false);
  expect(await loadPinnedModels(server.fetcher, store)).toEqual(new Set(['a/model', 'b/model']));
  expect(server.posts).toHaveLength(1);

  // Device pins the server already has need no save, and still leave the device.
  const known = deviceStore(JSON.stringify(['b/model']));
  await loadPinnedModels(prefsServer(['b/model']).fetcher, known);
  expect(known.saved.has(PINNED_MODELS_KEY)).toBe(false);
});

test('device pins stay on the device when the server cannot take them', async () => {
  const server = prefsServer([], { failSaves: true });
  const store = deviceStore(JSON.stringify(['a/model']));
  await expect(loadPinnedModels(server.fetcher, store)).rejects.toThrow('down');
  expect(store.saved.get(PINNED_MODELS_KEY)).toBe(JSON.stringify(['a/model']));
  const offline = mock(async () => Response.json({ ok: false }, { status: 401 }));
  await expect(loadPinnedModels(offline, store)).rejects.toThrow('could not be loaded');
  await expect(savePinnedModels(new Set(['a']), offline)).rejects.toThrow('could not be saved');
});

test('device pin storage ignores bad values and a blocked store', () => {
  expect(readDevicePinnedModels(deviceStore('{bad'))).toEqual([]);
  expect(readDevicePinnedModels(deviceStore('[1,"a"]'))).toEqual(['a']);
  expect(readDevicePinnedModels(null)).toEqual([]);
  expect(togglePinnedModel(new Set(['a']), 'a').size).toBe(0);
});
