import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { ChartContainer, ChartStyle } from '../components/ui/chart';
import { CHART_THEMES, chartStyleCss, isSafeChartColor, isSafeChartKey } from '../lib/theme/chart-style';
import { buildChartPayload } from '../lib/tools/display';

const GOOD_KEYS = ['count', 'value', 'open_tasks', 'series-2', 'Q1', '2026'];
const BAD_KEYS = ['a}b', 'open tasks', '"x"', "x'", 'x;y', 'x:y', 'x{', '</style>', '', 'a'.repeat(129)];

const GOOD_COLORS = [
  '#fff',
  '#ffff',
  '#a1b2c3',
  '#A1B2C3D4',
  'rgb(1, 2, 3)',
  'rgba(1,2,3,0.5)',
  'rgb(1 2 3 / 50%)',
  'hsl(210deg 40% 50%)',
  'hsla(210, 40%, 50%, .5)',
  'oklch(0.7 0.1 200)',
  'oklch(70% 0.1 -20 / 0.8)',
  'var(--chart-1)',
  'var(--color-accent)',
  'var(--color-accent-2, var(--color-accent))',
  'hsl(var(--chart-1))',
  'oklch(var(--brand))',
  'oklch(from var(--color-accent) calc(l + 0.18) calc(c * 0.7) h)',
  'oklch(from var(--color-accent-2, var(--color-accent)) calc(l - 0.12) c h)',
  'oklch(from var(--color-accent) l c h / 0.5)',
  '  #fff  ',
];

const BAD_COLORS = [
  'red;} body{display:none',
  'red',
  'url(https://x)',
  'url(//evil.example/a.png)',
  'expression(alert(1))',
  'javascript:alert(1)',
  '"#fff"',
  '#ggg',
  '#12345',
  'rgb(1,2,3);',
  'rgb(1,2,3)}',
  'rgb(1,2,3) } body { color: red',
  'rgb()',
  'rgb(calc(1))',
  'var(--x);color:red',
  'var(--x) }',
  'var(x)',
  'var(--x, red)',
  'hsl(var(--x) / url(a))',
  'oklch(from url(a) l c h)',
  'oklch(from var(--x) calc(l + 1;) c h)',
  '</style><script>alert(1)</script>',
  `#${'f'.repeat(200)}`,
  '',
  '   ',
  123,
  undefined,
  null,
];

// The tool-ui chart falls back to these when the payload has no colors.
const TOOL_UI_DEFAULT_COLORS = [
  'var(--chart-1)',
  'var(--chart-2)',
  'var(--chart-3)',
  'var(--chart-4)',
  'var(--chart-5)',
];

function appPaletteColors() {
  const payload = buildChartPayload(
    {
      type: 'bar',
      xKey: 'day',
      series: [{ key: 'count', label: 'Messages' }],
      data: [{ day: 'Mon', count: 1 }],
    },
    'chart-palette',
  );
  return payload.colors ?? [];
}

const ADVERSARIAL_CONFIG = {
  count: { label: 'Count', color: '#123456' },
  'x} body{display:none} .y{': { label: 'Key attack', color: '#fff' },
  bad_color: { label: 'Color attack', color: 'red;} body{display:none' },
  url_color: { label: 'Url attack', color: 'url(https://x)' },
  closer: { label: 'Tag attack', color: '</style><script>alert(1)</script>' },
  themed: { label: 'Themed', theme: { light: 'var(--chart-2)', dark: 'expression(alert(1))' } },
};

describe('chart key check', () => {
  test('letters, digits, underscore, and hyphen pass', () => {
    for (const key of GOOD_KEYS) expect(isSafeChartKey(key)).toBe(true);
  });

  test('keys with braces, spaces, quotes, or semicolons fail', () => {
    for (const key of BAD_KEYS) expect(isSafeChartKey(key)).toBe(false);
    expect(isSafeChartKey(42)).toBe(false);
  });
});

describe('chart color check', () => {
  test('plain color values pass', () => {
    for (const color of GOOD_COLORS)
      expect({ color, safe: isSafeChartColor(color) }).toEqual({ color, safe: true });
  });

  test('every color the app itself gives a chart passes', () => {
    const colors = [...appPaletteColors(), ...TOOL_UI_DEFAULT_COLORS];
    expect(colors.length).toBeGreaterThan(TOOL_UI_DEFAULT_COLORS.length);
    for (const color of colors)
      expect({ color, safe: isSafeChartColor(color) }).toEqual({ color, safe: true });
  });

  test('injection, url(), expression(), script, and named colors fail', () => {
    for (const color of BAD_COLORS)
      expect({ color, safe: isSafeChartColor(color) }).toEqual({ color, safe: false });
  });
});

describe('chart style CSS', () => {
  test('writes one block for each theme with the safe entries', () => {
    const css = chartStyleCss('chart-abc', {
      count: { color: '#123456' },
      themed: { theme: { light: 'var(--chart-1)', dark: 'var(--chart-2)' } },
    });
    expect(css).toBe(
      [
        '[data-chart=chart-abc] {',
        '  --color-count: #123456;',
        '  --color-themed: var(--chart-1);',
        '}',
        '.dark [data-chart=chart-abc] {',
        '  --color-count: #123456;',
        '  --color-themed: var(--chart-2);',
        '}',
      ].join('\n'),
    );
  });

  test('drops unsafe keys and colors from model input', () => {
    const css = chartStyleCss('chart-abc', ADVERSARIAL_CONFIG) ?? '';
    const blocks = Object.keys(CHART_THEMES).length;

    expect(css).toContain('--color-count: #123456;');
    expect(css).toContain('--color-themed: var(--chart-2);');
    // Only the builder's own braces and semicolons stay.
    expect(css.split('}').length - 1).toBe(blocks);
    expect(css.split('{').length - 1).toBe(blocks);
    expect(css.split(';').length - 1).toBe(css.split('\n  --color-').length - 1);
    for (const fragment of ['body', 'display', 'url(', 'expression', '<', 'bad_color', 'closer', 'x}']) {
      expect(css).not.toContain(fragment);
    }
  });

  test('returns null when no safe entry is left or the chart id is unsafe', () => {
    expect(chartStyleCss('chart-abc', { a: { color: 'red' }, 'b c': { color: '#fff' } })).toBeNull();
    expect(chartStyleCss('chart-abc', { a: {} })).toBeNull();
    expect(chartStyleCss('chart] body{', { a: { color: '#fff' } })).toBeNull();
  });
});

describe('ChartStyle rendering', () => {
  test('the style element holds no brace or tag from model input', () => {
    const html = renderToStaticMarkup(<ChartStyle id="chart-test" config={ADVERSARIAL_CONFIG} />);
    const css = html.replace(/^<style>/, '').replace(/<\/style>$/, '');

    expect(html.startsWith('<style>')).toBe(true);
    expect(css.split('}').length - 1).toBe(Object.keys(CHART_THEMES).length);
    expect(css).not.toContain('<');
    expect(css).not.toContain('display:none');
  });

  test('renders nothing when every entry is unsafe', () => {
    expect(renderToStaticMarkup(<ChartStyle id="chart-test" config={{ a: { color: 'red;}' } }} />)).toBe('');
  });

  test('the container keeps only safe characters in the chart id', () => {
    const html = renderToStaticMarkup(
      <ChartContainer id="x] body{display:none" config={{ count: { label: 'Count', color: '#123456' } }}>
        <div />
      </ChartContainer>,
    );

    expect(html).toContain('data-chart="chart-xbodydisplaynone"');
    expect(html).toContain('[data-chart=chart-xbodydisplaynone] {');
    expect(html).not.toContain('display:none');
  });
});
