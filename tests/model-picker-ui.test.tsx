import { afterEach, expect, mock, test } from 'bun:test';
import { useState } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { ModelPicker, type ModelPickerProps } from '../components/settings/ModelPicker';
import { ProviderGlyph } from '../components/settings/ProviderGlyph';
import { buildModelCatalog } from '../lib/ai/model-catalog';
import {
  PINNED_MODELS_KEY,
  readPinnedModels,
  togglePinnedModel,
  writePinnedModels,
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

test('pins survive a reload through device storage', async () => {
  const saved = new Map<string, string>();
  const previous = (globalThis as any).localStorage;
  (globalThis as any).localStorage = {
    getItem: (key: string) => saved.get(key) ?? null,
    setItem: (key: string, value: string) => void saved.set(key, value),
  };
  try {
    await mount();
    await click('Pin GLM-5.3 Flash');
    expect(saved.get(PINNED_MODELS_KEY)).toBe(JSON.stringify([glm]));
    await act(async () => view.unmount());
    await mount();
    expect(button('Unpin GLM-5.3 Flash').props['aria-pressed']).toBe(true);
  } finally {
    (globalThis as any).localStorage = previous;
  }
});

test('pin storage ignores bad values and a blocked store', () => {
  const store = { getItem: () => '{bad', setItem: () => {} };
  expect(readPinnedModels(store).size).toBe(0);
  expect(readPinnedModels({ getItem: () => '[1,"a"]', setItem: () => {} })).toEqual(new Set(['a']));
  expect(readPinnedModels(null).size).toBe(0);
  expect(() =>
    writePinnedModels(new Set(['a']), {
      getItem: () => null,
      setItem: () => {
        throw new Error('full');
      },
    }),
  ).not.toThrow();
  expect(togglePinnedModel(new Set(['a']), 'a').size).toBe(0);
});
