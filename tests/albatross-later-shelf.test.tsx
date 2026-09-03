import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { act, create } from 'react-test-renderer';
import { LaterCard, laterCardLabel } from '../components/albatross/LaterCard';
import { LaterShelf, type LaterShelfItem, laterShelfStops } from '../components/albatross/LaterShelf';

const NOW = new Date(2026, 8, 3, 10, 0, 0, 0).getTime();
const day = (year: number, month: number, date: number) => new Date(year, month, date).getTime();

const rows: LaterShelfItem[] = [
  {
    _id: 'wedding',
    title: 'Book the wedding venue',
    rawText: '',
    horizon: { kind: 'someday' },
    updatedAt: 5,
  },
  {
    _id: 'passport',
    title: 'Renew passport',
    rawText: '',
    horizon: { kind: 'later', notBefore: day(2026, 10, 1), label: 'not before November' },
    updatedAt: 1,
  },
  {
    _id: 'dentist',
    title: 'Book the dentist',
    rawText: '',
    horizon: { kind: 'later', notBefore: day(2026, 9, 12), label: 'after the trip' },
    updatedAt: 2,
  },
  {
    _id: 'taxes',
    title: 'File the taxes',
    rawText: '',
    horizon: { kind: 'later', notBefore: day(2026, 10, 20) },
    updatedAt: 3,
  },
  { _id: 'garage', title: null, rawText: 'Clear the garage', horizon: { kind: 'later' }, updatedAt: 9 },
  { _id: 'awake', title: 'Reply to Sarah', rawText: '', horizon: null, updatedAt: 4 },
];

describe('the Later shelf', () => {
  test('stops sit in wake order, one month label per month, undated Work after them', () => {
    const stops = laterShelfStops(rows, NOW);
    expect(stops.map((stop) => stop.work._id)).toEqual(['dentist', 'passport', 'taxes', 'garage', 'wedding']);
    expect(stops.map((stop) => stop.monthLabel)).toEqual(['Oct', 'Nov', null, null, null]);
    expect(stops.map((stop) => stop.someday)).toEqual([false, false, false, true, true]);
    expect(stops.map((stop) => stop.firstSomeday)).toEqual([false, false, false, true, false]);
  });

  test('a month in another year carries the year', () => {
    const stops = laterShelfStops(
      [
        {
          _id: 'x',
          title: 'x',
          rawText: '',
          horizon: { kind: 'later', notBefore: day(2027, 0, 4) },
          updatedAt: 1,
        },
      ],
      NOW,
    );
    expect(stops[0].monthLabel).toBe('Jan 2027');
  });

  test('renders the copy: wake lines, the user words, the Someday word, and no awake Work', () => {
    const html = renderToStaticMarkup(<LaterShelf items={rows} nowMs={NOW} onOpen={() => {}} />);
    expect(html).toContain('aria-label="Later"');
    expect(html).toContain('Back on Oct 12');
    expect(html).toContain('Back on Nov 1');
    expect(html).toContain('after the trip');
    expect(html).toContain('not before November');
    expect(html).toContain('>Someday<');
    expect(html).toContain('Clear the garage');
    expect(html).not.toContain('Reply to Sarah');
    expect(html.indexOf('Book the dentist')).toBeLessThan(html.indexOf('Renew passport'));
    expect(html.indexOf('File the taxes')).toBeLessThan(html.indexOf('Clear the garage'));
  });

  test('renders nothing when nothing sleeps', () => {
    const html = renderToStaticMarkup(<LaterShelf items={[rows[5]]} nowMs={NOW} onOpen={() => {}} />);
    expect(html).toBe('');
  });

  test('a card opens its Work on click', async () => {
    const opened: string[] = [];
    let renderer!: ReturnType<typeof create>;
    await act(async () => {
      renderer = create(<LaterShelf items={rows} nowMs={NOW} onOpen={(id) => opened.push(id)} />);
    });
    const card = renderer.root.findAll(
      (node) => node.type === 'button' && node.props['data-later-card'] === 'passport',
    )[0];
    await act(async () => card.props.onClick());
    expect(opened).toEqual(['passport']);
  });

  test('the user words do not repeat the wake line', () => {
    expect(
      laterCardLabel(
        { _id: 'a', title: 'a', rawText: '', horizon: { kind: 'later', label: 'after the trip' } },
        'After the trip',
      ),
    ).toBeNull();
    expect(
      laterCardLabel(
        {
          _id: 'a',
          title: 'a',
          rawText: '',
          horizon: { kind: 'later', notBefore: 1, label: 'after the trip' },
        },
        'Back on Oct 12',
      ),
    ).toBe('after the trip');
  });

  test('a card with no words shows only the wake line', () => {
    const html = renderToStaticMarkup(<LaterCard work={rows[3]} nowMs={NOW} onOpen={() => {}} />);
    expect(html).toContain('File the taxes');
    expect(html).toContain('Back on Nov 20');
    expect(html).not.toContain('italic');
  });
});
