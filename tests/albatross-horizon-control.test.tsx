import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import {
  HORIZON_PLACEHOLDER,
  HorizonControl,
  horizonDraftFromText,
  horizonFromDateInput,
  horizonToCommit,
  resolvedHorizonLine,
} from '../components/albatross/HorizonControl';
import type { WorkHorizon } from '../lib/albatross/horizon';

const NOW = new Date(2026, 8, 3, 10, 0, 0, 0).getTime();
const day = (year: number, month: number, date: number) => new Date(year, month, date).getTime();

const keyEvent = (key: string) => ({ key, preventDefault() {}, stopPropagation() {} });

function segment(renderer: ReactTestRenderer, label: string): ReactTestInstance {
  return renderer.root.findAll(
    (node) => node.type === 'button' && 'aria-pressed' in node.props && node.children.join('') === label,
  )[0];
}

function field(renderer: ReactTestRenderer): ReactTestInstance {
  return renderer.root.find(
    (node) => node.type === 'input' && node.props['aria-label'] === 'When does this come back?',
  );
}

function text(renderer: ReactTestRenderer): string {
  return JSON.stringify(renderer.toJSON());
}

async function mount(value: WorkHorizon | null, onChange: (next: WorkHorizon | null) => void) {
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(<HorizonControl value={value} nowMs={NOW} onChange={onChange} />);
  });
  return renderer;
}

describe('the horizon draft', () => {
  test('finds the parsed phrase inside the text for the underline', () => {
    const draft = horizonDraftFromText('Renew it, not before November', NOW);
    expect(draft.horizon).toEqual({
      kind: 'later',
      notBefore: day(2026, 10, 1),
      label: 'not before november',
    });
    expect(draft.phrase).toEqual([10, 29]);
  });

  test('plain words carry no phrase', () => {
    expect(horizonDraftFromText('when the garage is empty', NOW)).toEqual({ horizon: null, phrase: null });
  });

  test('the resolved line needs a date, or Someday', () => {
    expect(resolvedHorizonLine({ kind: 'later', notBefore: day(2026, 10, 1) }, NOW)).toBe('Back on Nov 1');
    expect(resolvedHorizonLine({ kind: 'now', by: day(2026, 8, 4) }, NOW)).toBe('By tomorrow');
    expect(resolvedHorizonLine({ kind: 'someday' }, NOW)).toBe('Someday');
    expect(resolvedHorizonLine({ kind: 'later', label: 'after the wedding' }, NOW)).toBeNull();
    expect(resolvedHorizonLine(null, NOW)).toBeNull();
  });

  test('Enter saves the parse, then the words, then nothing', () => {
    const parsed: WorkHorizon = { kind: 'later', notBefore: 5, label: 'in two weeks' };
    expect(horizonToCommit('in two weeks', parsed)).toBe(parsed);
    expect(horizonToCommit('  after  the wedding ', null)).toEqual({
      kind: 'later',
      label: 'after the wedding',
    });
    expect(horizonToCommit('   ', null)).toBeNull();
  });

  test('the date input becomes local midnight and keeps the words', () => {
    expect(horizonFromDateInput('2026-11-01', ' after the trip ')).toEqual({
      kind: 'later',
      notBefore: day(2026, 10, 1),
      label: 'after the trip',
    });
    expect(horizonFromDateInput('2026-11-01')).toEqual({ kind: 'later', notBefore: day(2026, 10, 1) });
    expect(horizonFromDateInput('')).toBeNull();
    expect(horizonFromDateInput('soon')).toBeNull();
  });
});

describe('the horizon control', () => {
  test('shows the saved value on the track and hides the field for Now', () => {
    const html = renderToStaticMarkup(<HorizonControl value={null} nowMs={NOW} onChange={() => {}} />);
    expect(html).toContain('aria-label="Horizon"');
    expect(html).toContain('>Now<');
    expect(html).toContain('>Later<');
    expect(html).toContain('>Someday<');
    expect(html).not.toContain(HORIZON_PLACEHOLDER);
  });

  test('a saved Later shows the field, the words, and the resolved line', () => {
    const html = renderToStaticMarkup(
      <HorizonControl
        value={{ kind: 'later', notBefore: day(2026, 10, 1), label: 'not before November' }}
        nowMs={NOW}
        onChange={() => {}}
      />,
    );
    expect(html).toContain('value="not before November"');
    expect(html).toContain('Back on Nov 1');
    expect(html).not.toContain('Pick a date');
  });

  test('Now and Someday save at once', async () => {
    const saved: Array<WorkHorizon | null> = [];
    const renderer = await mount({ kind: 'someday' }, (next) => saved.push(next));
    await act(async () => segment(renderer, 'Now').props.onClick());
    expect(saved).toEqual([null]);
    await act(async () => segment(renderer, 'Someday').props.onClick());
    expect(saved).toEqual([null, { kind: 'someday' }]);
  });

  test('Later opens the field, underlines the phrase, resolves the date, and Enter saves', async () => {
    const saved: Array<WorkHorizon | null> = [];
    const renderer = await mount(null, (next) => saved.push(next));
    expect(renderer.root.findAllByType('input')).toHaveLength(0);

    await act(async () => segment(renderer, 'Later').props.onClick());
    expect(saved).toEqual([]);
    expect(field(renderer).props.placeholder).toBe(HORIZON_PLACEHOLDER);
    expect(text(renderer)).toContain('Pick a date');

    await act(async () => field(renderer).props.onChange({ target: { value: 'Not before November' } }));
    const underlined = renderer.root.findAll(
      (node) => node.type === 'span' && String(node.props.className).includes('underline'),
    );
    expect(underlined).toHaveLength(1);
    expect(underlined[0].children.join('')).toBe('Not before November');
    expect(text(renderer)).toContain('Back on Nov 1');
    expect(text(renderer)).not.toContain('Pick a date');

    await act(async () => field(renderer).props.onKeyDown(keyEvent('Enter')));
    expect(saved).toEqual([{ kind: 'later', notBefore: day(2026, 10, 1), label: 'not before november' }]);
  });

  test('words without a date save as a label, so the Work sleeps with a reason', async () => {
    const saved: Array<WorkHorizon | null> = [];
    const renderer = await mount(null, (next) => saved.push(next));
    await act(async () => segment(renderer, 'Later').props.onClick());
    await act(async () => field(renderer).props.onChange({ target: { value: 'after the wedding' } }));
    expect(text(renderer)).toContain('Pick a date');
    await act(async () => field(renderer).props.onKeyDown(keyEvent('Enter')));
    expect(saved).toEqual([{ kind: 'later', label: 'after the wedding' }]);
  });

  test('Pick a date swaps in the date input, and a date saves at once', async () => {
    const saved: Array<WorkHorizon | null> = [];
    const renderer = await mount(null, (next) => saved.push(next));
    await act(async () => segment(renderer, 'Later').props.onClick());
    await act(async () => field(renderer).props.onChange({ target: { value: 'after the trip' } }));
    const pick = renderer.root.find(
      (node) => node.type === 'button' && node.children.join('') === 'Pick a date',
    );
    await act(async () => pick.props.onClick());
    const date = renderer.root.find((node) => node.type === 'input' && node.props.type === 'date');
    expect(date.props.min).toBe('2026-09-03');
    await act(async () => date.props.onChange({ target: { value: '2026-10-12' } }));
    expect(saved).toEqual([{ kind: 'later', notBefore: day(2026, 9, 12), label: 'after the trip' }]);
  });

  test('Escape returns to the saved value without a save', async () => {
    const saved: Array<WorkHorizon | null> = [];
    let cancelled = 0;
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        <HorizonControl
          value={null}
          nowMs={NOW}
          onChange={(next) => saved.push(next)}
          onCancel={() => {
            cancelled += 1;
          }}
        />,
      );
    });
    await act(async () => segment(renderer, 'Later').props.onClick());
    await act(async () => field(renderer).props.onChange({ target: { value: 'in two weeks' } }));
    await act(async () => field(renderer).props.onKeyDown(keyEvent('Escape')));
    expect(saved).toEqual([]);
    expect(cancelled).toBe(1);
    expect(renderer.root.findAllByType('input')).toHaveLength(0);
    expect(segment(renderer, 'Now').props['aria-pressed']).toBe(true);
  });

  test('saving dims the resolved line and an error reads as one sentence', () => {
    const html = renderToStaticMarkup(
      <HorizonControl
        value={{ kind: 'later', notBefore: day(2026, 10, 1) }}
        nowMs={NOW}
        onChange={() => {}}
        saving
        error="Could not save the horizon. Try again."
      />,
    );
    expect(html).toContain('opacity-55');
    expect(html).toContain('Could not save the horizon. Try again.');
  });
});
