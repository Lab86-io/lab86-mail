import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import {
  HIDE_DONE_ABOVE,
  LIST_EMPTY_LINE,
  ListBody,
  orderedListItems,
  SETTLE_FILL_MS,
  SETTLE_HOLD_MS,
  splitPastedLines,
  visibleListItems,
} from '../components/albatross/shapes/ListBody';
import type { ListItem } from '../components/albatross/shapes/ListRow';
import {
  type Milestone,
  MilestoneEditor,
  MilestoneRail,
  milestoneLine,
  milestoneRowsFromText,
  milestonesToText,
  railStates,
} from '../components/albatross/shapes/MilestoneRail';
import {
  type MetricEntry,
  PracticeBody,
  parseMetricInput,
  targetLine,
  trendPoints,
} from '../components/albatross/shapes/PracticeBody';
import { ProjectBody } from '../components/albatross/shapes/ProjectBody';
import { agoLine, projectLogRows, sourceWord } from '../components/albatross/shapes/ProjectLog';
import {
  SHAPE_FADE_MS,
  SHAPE_STATUS_LINE,
  ShapeBodySwap,
  shapeFacts,
  shapeFinishes,
  shapeShowsPlan,
} from '../components/albatross/shapes/ShapeFrame';
import { ShapePicker, stepShape } from '../components/albatross/shapes/ShapePicker';
import { mergeMetricEntries, visibleMilestones, visibleShape } from '../components/albatross/WorkDetail';
import { SHAPE_MEANING } from '../lib/albatross/shape-policy';
import { WORK_SHAPES, type WorkShape } from '../lib/albatross/work-shape';

const repoRoot = join(import.meta.dir, '..');
const read = (relative: string) => readFileSync(join(repoRoot, relative), 'utf8');

const NOW = new Date(2026, 8, 3, 10, 0, 0, 0).getTime();
const DAY = 24 * 60 * 60_000;
const keyEvent = (key: string, extra: Record<string, unknown> = {}) => ({
  key,
  preventDefault() {},
  stopPropagation() {},
  ...extra,
});
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const markup = (renderer: ReactTestRenderer) => JSON.stringify(renderer.toJSON());

function buttonNamed(renderer: ReactTestRenderer, label: string): ReactTestInstance {
  return renderer.root.find(
    (node) => node.type === 'button' && node.children.length === 1 && node.children[0] === label,
  );
}

async function mount(element: React.ReactElement) {
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(element);
  });
  return renderer;
}

// ---------------------------------------------------------------------------
// The shape picker and the cross-fade
// ---------------------------------------------------------------------------

describe('the shape picker', () => {
  test('the shape word is a text button, and the list holds seven shapes with their meaning', async () => {
    const picked: WorkShape[] = [];
    const renderer = await mount(<ShapePicker value="list" onChange={(next) => picked.push(next)} />);
    const trigger = renderer.root.find(
      (node) => node.type === 'button' && node.props['aria-haspopup'] === 'listbox',
    );
    expect(trigger.children.join('')).toBe('list');
    expect(trigger.props['aria-expanded']).toBe(false);
    expect(renderer.root.findAll((node) => node.props.role === 'option')).toHaveLength(0);

    await act(async () => trigger.props.onClick());
    const options = renderer.root.findAll((node) => node.props.role === 'option');
    expect(options.map((node) => node.props['data-shape-option'])).toEqual([...WORK_SHAPES]);
    const html = markup(renderer);
    for (const shape of WORK_SHAPES) expect(html).toContain(SHAPE_MEANING[shape]);
    const current = options.find((node) => node.props['aria-selected'] === true);
    expect(current?.props['data-shape-option']).toBe('list');

    await act(async () => options[2].props.onClick());
    expect(picked).toEqual(['project']);
    expect(renderer.root.findAll((node) => node.props.role === 'option')).toHaveLength(0);
  });

  test('Down moves, Enter picks, Escape closes, and a pick of the same shape saves nothing', async () => {
    const picked: WorkShape[] = [];
    const renderer = await mount(<ShapePicker value="quick" onChange={(next) => picked.push(next)} />);
    const trigger = renderer.root.find(
      (node) => node.type === 'button' && node.props['aria-haspopup'] === 'listbox',
    );
    await act(async () => trigger.props.onKeyDown(keyEvent('ArrowDown')));
    expect(renderer.root.findAll((node) => node.props.role === 'option')).toHaveLength(7);
    await act(async () => trigger.props.onKeyDown(keyEvent('ArrowDown')));
    const focused = renderer.root.find((node) => node.props['data-focused'] === 'true');
    expect(focused.props['data-shape-option']).toBe('list');
    await act(async () => trigger.props.onKeyDown(keyEvent('Enter')));
    expect(picked).toEqual(['list']);

    await act(async () => trigger.props.onClick());
    await act(async () => trigger.props.onKeyDown(keyEvent('Escape')));
    expect(renderer.root.findAll((node) => node.props.role === 'option')).toHaveLength(0);

    await act(async () => trigger.props.onClick());
    await act(async () => trigger.props.onKeyDown(keyEvent('Enter')));
    expect(picked).toEqual(['list']);
  });

  test('the arrow keys do not wrap', () => {
    expect(stepShape('quick', -1)).toBe('quick');
    expect(stepShape('quick', 1)).toBe('list');
    expect(stepShape('recurring', 1)).toBe('recurring');
  });

  test('the body cross-fades in 200 ms on a shape change', async () => {
    const renderer = await mount(
      <ShapeBodySwap shape="list">{(shown, kind) => <p data-kind={kind}>{shown}</p>}</ShapeBodySwap>,
    );
    const frame = () => renderer.root.find((node) => node.props['data-shape-fade'] !== undefined);
    expect(frame().props.className).toContain('transition-opacity');
    expect(frame().props.className).toContain('duration-[var(--duration-normal)]');
    expect(frame().props['data-shape-fade']).toBe('in');
    expect(frame().props.className).toContain('opacity-100');

    await act(async () => {
      renderer.update(
        <ShapeBodySwap shape="practice">{(shown, kind) => <p data-kind={kind}>{shown}</p>}</ShapeBodySwap>,
      );
    });
    expect(frame().props['data-shape-fade']).toBe('out');
    expect(frame().props.className).toContain('opacity-0');
    expect(frame().props['data-shape-shown']).toBe('list');

    await act(async () => {
      await sleep(SHAPE_FADE_MS + 50);
    });
    expect(frame().props['data-shape-fade']).toBe('in');
    expect(frame().props['data-shape-shown']).toBe('practice');
    expect(renderer.root.findByType('p').props['data-kind']).toBe('practice');
  });

  test('the optimistic shape shows until the server agrees', () => {
    expect(visibleShape(undefined, null)).toBe('quick');
    expect(visibleShape('list', null)).toBe('list');
    expect(visibleShape('list', { value: 'project' })).toBe('project');
    expect(visibleShape('project', { value: 'project' })).toBe('project');
  });
});

// ---------------------------------------------------------------------------
// The list body
// ---------------------------------------------------------------------------

const listItems: ListItem[] = [
  { id: 'heat', text: 'Heat', done: false, addedAt: NOW - 9 * DAY },
  { id: 'alien', text: 'Alien', done: true, addedAt: NOW - 8 * DAY, doneAt: NOW - 2 * DAY },
  { id: 'dune', text: 'Dune part two', done: false, addedAt: NOW - 7 * DAY },
];

function rowOrder(renderer: ReactTestRenderer): string[] {
  return renderer.root
    .findAll((node) => node.type === 'li' && node.props['data-list-item'])
    .map((node) => node.props['data-list-item']);
}

describe('the list body', () => {
  test('open items sit first by age, done items last by finish time, a held item stays in its group', () => {
    const plain = orderedListItems(listItems);
    expect(plain.open.map((item) => item.id)).toEqual(['heat', 'dune']);
    expect(plain.done.map((item) => item.id)).toEqual(['alien']);

    const checked = listItems.map((item) =>
      item.id === 'heat' ? { ...item, done: true, doneAt: NOW } : item,
    );
    const held = orderedListItems(checked, new Map([['heat', false]]));
    expect(held.open.map((item) => item.id)).toEqual(['heat', 'dune']);
    const released = orderedListItems(checked);
    expect(released.open.map((item) => item.id)).toEqual(['dune']);
    expect(released.done.map((item) => item.id)).toEqual(['alien', 'heat']);
  });

  test('the optimistic toggles lay over the server rows', () => {
    const shown = visibleListItems(listItems, new Map([['dune', { done: true, at: NOW }]]));
    expect(shown.find((item) => item.id === 'dune')).toEqual({ ...listItems[2], done: true, doneAt: NOW });
    expect(shown.find((item) => item.id === 'heat')).toBe(listItems[0]);
  });

  test('pasted lines become several items', () => {
    expect(splitPastedLines('Heat\n- Alien\r\n\n* Dune part two  ')).toEqual([
      'Heat',
      'Alien',
      'Dune part two',
    ]);
  });

  test('Enter adds, clears the field, and keeps the add line first', async () => {
    const added: string[][] = [];
    const renderer = await mount(
      <ListBody
        items={listItems}
        onAdd={(texts) => added.push(texts)}
        onToggle={() => {}}
        onRemove={() => {}}
      />,
    );
    const field = renderer.root.find((node) => node.type === 'input');
    expect(field.props.placeholder).toBe('Add');
    await act(async () => field.props.onChange({ target: { value: '  Blade Runner ' } }));
    await act(async () => field.props.onKeyDown(keyEvent('Enter')));
    expect(added).toEqual([['Blade Runner']]);
    expect(renderer.root.find((node) => node.type === 'input').props.value).toBe('');
    await act(async () => field.props.onKeyDown(keyEvent('Enter')));
    expect(added).toHaveLength(1);
    const section = renderer.root.find((node) => node.props['data-shape-body'] === 'list');
    expect(section.children[0]).toBe(field);
  });

  test('a check fills in place, holds, then settles to the bottom below the hairline', async () => {
    let items = listItems;
    let renderer!: ReactTestRenderer;
    const render = () => (
      <ListBody
        items={items}
        onAdd={() => {}}
        onToggle={(id) => {
          items = items.map((item) =>
            item.id === id ? { ...item, done: !item.done, doneAt: item.done ? undefined : NOW } : item,
          );
          renderer.update(render());
        }}
        onRemove={() => {}}
      />
    );
    renderer = await mount(render());
    expect(rowOrder(renderer)).toEqual(['heat', 'dune', 'alien']);
    const hairline = renderer.root.findAll((node) => node.props['data-list-hairline'] !== undefined);
    expect(hairline).toHaveLength(1);

    const circle = renderer.root.find(
      (node) => node.type === 'button' && node.props['aria-label'] === 'Check Heat',
    );
    await act(async () => circle.props.onClick());
    // The row is checked but still in place.
    const heat = renderer.root.find((node) => node.props['data-list-item'] === 'heat');
    expect(heat.props['data-done']).toBe('true');
    expect(rowOrder(renderer)).toEqual(['heat', 'dune', 'alien']);
    const fill = heat.findAll(
      (node) => node.type === 'span' && String(node.props.className).includes('scale-100'),
    );
    expect(fill).toHaveLength(1);
    expect(fill[0].props.className).toContain('duration-[var(--duration-fast)]');

    await act(async () => {
      await sleep(SETTLE_FILL_MS + SETTLE_HOLD_MS + 60);
    });
    expect(rowOrder(renderer)).toEqual(['dune', 'alien', 'heat']);
  });

  test('Remove calls out with the id, and the empty list says so', async () => {
    const removed: string[] = [];
    const renderer = await mount(
      <ListBody items={listItems} onAdd={() => {}} onToggle={() => {}} onRemove={(id) => removed.push(id)} />,
    );
    const remove = renderer.root.find(
      (node) => node.type === 'button' && node.props['aria-label'] === 'Remove Alien',
    );
    expect(remove.props.className).toContain('opacity-0');
    expect(remove.props.className).toContain('group-hover:opacity-100');
    await act(async () => remove.props.onClick());
    expect(removed).toEqual(['alien']);

    const html = renderToStaticMarkup(
      <ListBody items={[]} onAdd={() => {}} onToggle={() => {}} onRemove={() => {}} />,
    );
    expect(html).toContain(LIST_EMPTY_LINE);
  });

  test('Hide done appears past five done items', async () => {
    const many: ListItem[] = Array.from({ length: HIDE_DONE_ABOVE + 1 }, (_, index) => ({
      id: `d${index}`,
      text: `Done ${index}`,
      done: true,
      addedAt: NOW - index,
      doneAt: NOW - index,
    }));
    const renderer = await mount(
      <ListBody items={[...listItems, ...many]} onAdd={() => {}} onToggle={() => {}} onRemove={() => {}} />,
    );
    const hide = buttonNamed(renderer, 'Hide done');
    await act(async () => hide.props.onClick());
    expect(rowOrder(renderer)).toEqual(['heat', 'dune']);
    expect(markup(renderer)).toContain(`Show done (${HIDE_DONE_ABOVE + 2})`);
  });
});

// ---------------------------------------------------------------------------
// The practice body
// ---------------------------------------------------------------------------

const entries: MetricEntry[] = [185, 183.5, 181.9, 179.8].map((value, index) => ({
  _id: `e${index}`,
  at: NOW - (3 - index) * 14 * DAY,
  value,
  note: null,
}));
const metric = { name: 'Weight', unit: 'lb', target: 170, direction: 'down' as const };

describe('the practice body', () => {
  test('the trend puts one dot per log on a time axis with the target as a marker', () => {
    const trend = trendPoints(entries, 170, NOW, 240, 56);
    expect(trend.points).toHaveLength(4);
    expect(trend.points.map((point) => point.id)).toEqual(['e0', 'e1', 'e2', 'e3']);
    for (let index = 1; index < trend.points.length; index += 1) {
      expect(trend.points[index].x).toBeGreaterThan(trend.points[index - 1].x);
      expect(trend.points[index].y).toBeGreaterThan(trend.points[index - 1].y);
    }
    expect(trend.points[3].x).toBe(236);
    expect(trend.targetY).toBe(50);
    expect(trend.path.startsWith('M')).toBe(true);
    expect(trendPoints([], null, NOW)).toEqual({ points: [], path: '', targetY: null });
    expect(trendPoints([entries[0]], 170, NOW).path).toBe('');
  });

  test('the target line reads with the direction, and the input parses a number', () => {
    expect(targetLine(metric)).toBe('down to 170 lb');
    expect(targetLine({ name: 'Runs', unit: 'km', target: 10 })).toBe('10 km');
    expect(targetLine({ name: 'Runs', unit: 'km' })).toBeNull();
    expect(parseMetricInput(' 179,8 ')).toBe(179.8);
    expect(parseMetricInput('')).toBeNull();
    expect(parseMetricInput('ten')).toBeNull();
  });

  test('the value, the unit, the review line, and the dots render', () => {
    const html = renderToStaticMarkup(
      <PracticeBody metric={metric} entries={entries} nowMs={NOW} onLog={() => {}} />,
    );
    expect(html).toContain('data-practice-value');
    expect(html).toContain('179.8');
    expect(html).toContain('>lb<');
    expect(html).toContain('Down 5.2 lb over 6 weeks.');
    expect(html).toContain('9.8 lb to the target.');
    expect(html).toContain('data-trend-points="4"');
    expect(html).toContain('data-trend-target');
    expect(html).toContain('>Log<');
  });

  test('an empty practice reads as a dash and an invitation', () => {
    const html = renderToStaticMarkup(
      <PracticeBody metric={metric} entries={[]} nowMs={NOW} onLog={() => {}} />,
    );
    expect(html).toContain('>—<');
    expect(html).toContain('Log the first number to start the trend.');
    expect(html).toContain('data-trend-points="0"');
  });

  test('Log opens one field, Enter saves the value and the note', async () => {
    const logged: Array<[number, string | undefined]> = [];
    const renderer = await mount(
      <PracticeBody
        metric={metric}
        entries={entries}
        nowMs={NOW}
        onLog={(value, note) => logged.push([value, note])}
      />,
    );
    await act(async () => buttonNamed(renderer, 'Log').props.onClick());
    const value = renderer.root.find((node) => node.type === 'input' && node.props['aria-label'] === 'Value');
    const note = renderer.root.find((node) => node.type === 'input' && node.props['aria-label'] === 'Note');
    await act(async () => value.props.onKeyDown(keyEvent('Enter')));
    expect(logged).toEqual([]);
    await act(async () => value.props.onChange({ target: { value: '178.4' } }));
    await act(async () => note.props.onChange({ target: { value: 'after the run' } }));
    await act(async () => value.props.onKeyDown(keyEvent('Enter')));
    expect(logged).toEqual([[178.4, 'after the run']]);
  });

  test('a fresh log joins the server entries once', () => {
    const fresh: MetricEntry = { _id: 'new', at: NOW, value: 178, note: null };
    expect(mergeMetricEntries(entries, [fresh])).toHaveLength(5);
    expect(mergeMetricEntries([...entries, fresh], [fresh])).toHaveLength(5);
  });
});

// ---------------------------------------------------------------------------
// The project body
// ---------------------------------------------------------------------------

const milestones: Milestone[] = [
  { id: 'm2', title: 'Mail split view', done: true, doneAt: new Date(2026, 7, 12).getTime(), order: 1 },
  { id: 'm1', title: 'Sidebar and shell', done: true, doneAt: new Date(2026, 7, 1).getTime(), order: 0 },
  { id: 'm3', title: 'Calendar sync', done: false, order: 2 },
  { id: 'm4', title: 'TestFlight build', done: false, order: 3 },
];

describe('the project body', () => {
  test('the rail states are filled, ringed current, then hollow', () => {
    const rows = railStates(milestones);
    expect(rows.map((row) => row.milestone.id)).toEqual(['m1', 'm2', 'm3', 'm4']);
    expect(rows.map((row) => row.state)).toEqual(['done', 'done', 'current', 'open']);
    expect(milestoneLine(rows[1].milestone, 'done')).toBe('Done Aug 12');
    expect(milestoneLine(rows[2].milestone, 'current')).toBe('Next');
    expect(milestoneLine(rows[3].milestone, 'open')).toBeNull();
  });

  test('the rail renders each state and a click toggles by id', async () => {
    const toggled: string[] = [];
    const renderer = await mount(
      <MilestoneRail milestones={milestones} onToggle={(id) => toggled.push(id)} />,
    );
    const rows = renderer.root.findAll((node) => node.type === 'li' && node.props['data-milestone']);
    expect(rows.map((row) => row.props['data-milestone-state'])).toEqual(['done', 'done', 'current', 'open']);
    const lines = renderer.root.findAll((node) => node.props['data-rail-line'] !== undefined);
    expect(lines.map((line) => line.props['data-rail-line'])).toEqual(['filled', 'filled', 'open']);
    const circle = renderer.root.find(
      (node) => node.type === 'button' && node.props['aria-label'] === 'Complete Calendar sync',
    );
    expect(circle.props.className).toContain('border-2');
    await act(async () => circle.props.onClick());
    expect(toggled).toEqual(['m3']);
  });

  test('the editor text keeps ids on a reorder and drops them for new lines', () => {
    expect(milestonesToText(milestones)).toBe(
      'Sidebar and shell\nMail split view\nCalendar sync\nTestFlight build',
    );
    const rows = milestoneRowsFromText(
      'TestFlight build\n- Calendar sync\n\nApp Store listing\nmail split view',
      milestones,
    );
    expect(rows).toEqual([
      { id: 'm4', title: 'TestFlight build' },
      { id: 'm3', title: 'Calendar sync' },
      { title: 'App Store listing' },
      { id: 'm2', title: 'mail split view' },
    ]);
  });

  test('Enter in the editor saves the payload, Shift+Enter does not', async () => {
    const saved: unknown[] = [];
    const renderer = await mount(
      <MilestoneEditor milestones={milestones} onSave={(rows) => saved.push(rows)} onCancel={() => {}} />,
    );
    const area = renderer.root.findByType('textarea');
    await act(async () => area.props.onChange({ target: { value: 'Calendar sync\nSidebar and shell' } }));
    await act(async () => area.props.onKeyDown(keyEvent('Enter', { shiftKey: true })));
    expect(saved).toEqual([]);
    await act(async () => area.props.onKeyDown(keyEvent('Enter', { shiftKey: false })));
    expect(saved).toEqual([
      [
        { id: 'm3', title: 'Calendar sync' },
        { id: 'm1', title: 'Sidebar and shell' },
      ],
    ]);
  });

  test('the body opens the editor from Edit milestones and from the empty line', async () => {
    const renderer = await mount(
      <ProjectBody
        milestones={milestones}
        evidence={[]}
        nowMs={NOW}
        onToggle={() => {}}
        onSetMilestones={() => true}
      />,
    );
    await act(async () => buttonNamed(renderer, 'Edit milestones').props.onClick());
    expect(renderer.root.findAllByType('textarea')).toHaveLength(1);

    const empty = await mount(
      <ProjectBody
        milestones={[]}
        evidence={[]}
        nowMs={NOW}
        onToggle={() => {}}
        onSetMilestones={() => true}
      />,
    );
    await act(async () => buttonNamed(empty, 'Add the first milestone.').props.onClick());
    expect(empty.root.findAllByType('textarea')).toHaveLength(1);
  });

  test('the log sits in time order with a source word, and last touched reads above it', () => {
    const rows = projectLogRows(
      [
        {
          _id: 'a',
          title: 'Old commit',
          sourceKind: 'github_commit',
          occurredAt: NOW - 3 * DAY,
          trust: 'observed',
        },
        {
          _id: 'b',
          title: 'Merged PR',
          sourceKind: 'github_pull_request',
          occurredAt: NOW - DAY,
          trust: 'confirmed',
          url: 'https://x',
        },
      ],
      [{ kind: 'github_issue', id: '412', title: 'Track the build' }],
    );
    expect(rows.map((row) => [row.source, row.title])).toEqual([
      ['Pull request', 'Merged PR'],
      ['Commit', 'Old commit'],
      ['Issue', 'Track the build'],
    ]);
    expect(rows[2].at).toBeNull();
    expect(sourceWord('unknown_kind')).toBe('connected service');
    expect(agoLine(NOW - 30_000, NOW)).toBe('just now');
    expect(agoLine(NOW - 3 * 60 * 60_000, NOW)).toBe('3h ago');
    expect(agoLine(NOW - 2 * DAY, NOW)).toBe('2d ago');
    expect(agoLine(NOW - 30 * DAY, NOW)).toBe('Aug 4');

    const html = renderToStaticMarkup(
      <ProjectBody
        milestones={milestones}
        evidence={[]}
        lastUserTouchAt={NOW - 3 * 60 * 60_000}
        nowMs={NOW}
        onToggle={() => {}}
        onSetMilestones={() => true}
      />,
    );
    expect(html).toContain('Last touched 3h ago');
    expect(html).toContain('Nothing in the log yet.');
  });

  test('the optimistic milestone toggles lay over the server rows', () => {
    const shown = visibleMilestones(milestones, new Map([['m3', { done: true, at: NOW }]]));
    expect(shown.find((row) => row.id === 'm3')).toEqual({ ...milestones[2], done: true, doneAt: NOW });
    expect(visibleMilestones(undefined, new Map())).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Facts and plan affordances by shape
// ---------------------------------------------------------------------------

describe('the shape facts and the policy gates', () => {
  test('each shape supplies its three facts, and the guided shapes keep the default', () => {
    const list = shapeFacts('list', { listItems }, NOW);
    expect(list?.map((fact) => [fact.label, fact.value])).toEqual([
      ['Items', '3'],
      ['Done', '1'],
      ['Added', 'Aug 27'],
    ]);
    const practice = shapeFacts(
      'practice',
      { metric, metricSummary: { latest: 179.8, latestAt: NOW, count: 4, weeksWithEntry: 3 } },
      NOW,
    );
    expect(practice?.map((fact) => [fact.label, fact.value])).toEqual([
      ['Now', '179.8 lb'],
      ['Target', '170 lb'],
      ['Weeks logged', '3 of 12'],
    ]);
    const project = shapeFacts('project', { milestones, lastUserTouchAt: NOW - 2 * DAY }, NOW);
    expect(project?.map((fact) => [fact.label, fact.value])).toEqual([
      ['Milestones', '2 of 4 done'],
      ['Last touched', '2d ago'],
      ['Next', 'Calendar sync'],
    ]);
    for (const shape of ['quick', 'decision', 'monitor', 'recurring'] as const) {
      expect(shapeFacts(shape, {}, NOW)).toBeNull();
    }
  });

  test('plan affordances and the completion card follow the policy', () => {
    expect(WORK_SHAPES.filter((shape) => !shapeShowsPlan(shape))).toEqual([
      'list',
      'practice',
      'monitor',
      'recurring',
    ]);
    expect(WORK_SHAPES.filter((shape) => !shapeFinishes(shape))).toEqual(['list', 'practice', 'monitor']);
    expect(Object.keys(SHAPE_STATUS_LINE).sort()).toEqual(['decision', 'monitor', 'recurring']);
    for (const line of Object.values(SHAPE_STATUS_LINE)) expect(line).not.toMatch(/\bAI\b/);
  });

  test('WorkDetail gates the plan sections, the proof, and the completion card on the shape', () => {
    const source = read('components/albatross/WorkDetail.tsx');
    expect(source).toContain('{!showsPlan ? null : detail.execution.currentStep ? (');
    expect(source).toContain('{showsPlan && detail.execution.currentStep ? (');
    expect(source).toContain('{!showsPlan ? null : document ? (');
    expect(source).toContain('{showsPlan && !document && plan?.digitalActions?.length ? (');
    expect(source).toContain("{kind !== 'milestones' && detail.evidence?.length ? (");
    expect(source).toContain('{open && finishes ? (');
    expect(source).toContain('<ShapeBodySwap shape={shape}>');
    expect(source).toContain('<ShapePicker');
  });

  test('the harness is dev-only', () => {
    const source = read('app/dev/shape-preview/page.tsx');
    expect(source).toContain("if (process.env.NODE_ENV === 'production') notFound();");
  });
});
