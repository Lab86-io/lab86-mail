import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { WAKE_NUDGE_MAX, type WakeNotification, WakeNudge, wakeNudges } from '../components/shell/WakeNudge';
import type { WorkHorizon } from '../lib/albatross/horizon';
import { wakeLine } from '../lib/albatross/horizon';

const NOW = new Date(2026, 8, 3, 10, 0, 0, 0).getTime();

const wake = (over: Partial<WakeNotification>): WakeNotification => ({
  _id: over._id || 'n1',
  type: 'work_wake',
  title: over.title ?? wakeLine('Passport renewal'),
  body: 'Open it when you have time. Albatross did not move it.',
  status: over.status ?? 'delivered',
  entityKind: 'work',
  entityId: over.entityId ?? 'passport',
  createdAt: over.createdAt ?? 100,
  ...over,
});

describe('which wakes show', () => {
  test('only unread work_wake rows, newest first, at most three', () => {
    const rows = [
      wake({ _id: 'old', createdAt: 1 }),
      wake({ _id: 'acted', status: 'acted' }),
      wake({ _id: 'update', type: 'work_update' }),
      wake({ _id: 'no-entity', entityId: '' }),
      wake({ _id: 'b', createdAt: 20 }),
      wake({ _id: 'c', createdAt: 30, status: 'queued' }),
      wake({ _id: 'd', createdAt: 40 }),
    ];
    expect(wakeNudges(rows).map((row) => row._id)).toEqual(['d', 'c', 'b']);
    expect(WAKE_NUDGE_MAX).toBe(3);
  });
});

describe('the wake nudge', () => {
  const noop = () => {};

  test('renders the wake line with Open and Later, and nothing for other rows', () => {
    const html = renderToStaticMarkup(
      <WakeNudge notifications={[wake({})]} nowMs={NOW} onOpen={noop} onLater={noop} onDismiss={noop} />,
    );
    expect(html).toContain('Passport renewal is back. Ready when you are.');
    expect(html).toContain('>Open<');
    expect(html).toContain('>Later<');
    expect(html).toContain('aria-label="Close"');
    expect(html).not.toContain('Ready when you are.</p><p');

    const silent = renderToStaticMarkup(
      <WakeNudge
        notifications={[wake({ type: 'work_update' })]}
        nowMs={NOW}
        onOpen={noop}
        onLater={noop}
        onDismiss={noop}
      />,
    );
    expect(silent).toBe('');
  });

  test('Open and Close hand back the row', async () => {
    const opened: string[] = [];
    const dismissed: string[] = [];
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        <WakeNudge
          notifications={[
            wake({ _id: 'a', createdAt: 1 }),
            wake({ _id: 'b', createdAt: 2, entityId: 'taxes' }),
          ]}
          nowMs={NOW}
          onOpen={(row) => opened.push(row._id)}
          onLater={noop}
          onDismiss={(row) => dismissed.push(row._id)}
        />,
      );
    });
    const sections = renderer.root.findAll(
      (node) => node.type === 'section' && typeof node.props['data-wake-nudge'] === 'string',
    );
    expect(sections.map((node) => node.props['data-wake-nudge'])).toEqual(['taxes', 'passport']);

    const open = renderer.root.findAll((node) => node.type === 'button' && node.children.join('') === 'Open');
    await act(async () => open[0].props.onClick());
    expect(opened).toEqual(['b']);

    const close = renderer.root.findAll(
      (node) => node.type === 'button' && node.props['aria-label'] === 'Close',
    );
    await act(async () => close[1].props.onClick());
    expect(dismissed).toEqual(['a']);
  });

  test('Later opens the horizon control in place and hands back the new horizon', async () => {
    const later: Array<[string, WorkHorizon | null]> = [];
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        <WakeNudge
          notifications={[wake({})]}
          nowMs={NOW}
          onOpen={noop}
          onLater={(row, horizon) => later.push([row._id, horizon])}
          onDismiss={noop}
        />,
      );
    });
    const laterButton = renderer.root.find(
      (node) => node.type === 'button' && node.children.join('') === 'Later',
    );
    await act(async () => laterButton.props.onClick());

    const field = renderer.root.find(
      (node) => node.type === 'input' && node.props['aria-label'] === 'When does this come back?',
    );
    await act(async () => field.props.onChange({ target: { value: 'in two weeks' } }));
    await act(async () => field.props.onKeyDown({ key: 'Enter', preventDefault() {}, stopPropagation() {} }));

    expect(later).toHaveLength(1);
    expect(later[0][0]).toBe('n1');
    expect(later[0][1]).toMatchObject({ kind: 'later', label: 'in two weeks' });
    expect(typeof later[0][1]?.notBefore).toBe('number');
  });
});
