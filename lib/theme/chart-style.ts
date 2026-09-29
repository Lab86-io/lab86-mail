/**
 * Safe CSS for chart series colors (CASA S12).
 *
 * The chart tool takes its series keys and colors from the model. ChartStyle writes each pair into a
 * <style> element as `--color-<key>: <color>;`. A key or a color with `;`, `}`, or `<` could add its
 * own CSS rules or close the style element. These checks let through only plain names and plain
 * color values. The chart draws its SVG marks from the color props, not from these variables, so a
 * dropped entry does not break the chart.
 */

const MAX_KEY_LENGTH = 128;
const MAX_COLOR_LENGTH = 160;

const NAME = '--[A-Za-z0-9_-]+';
// var(--name) or var(--name, var(--name)).
const VAR = `var\\(\\s*${NAME}\\s*(?:,\\s*var\\(\\s*${NAME}\\s*\\)\\s*)?\\)`;
const COLOR_FUNCTION = '(?:rgba?|hsla?|oklch)';
const NUMBER = '-?(?:\\d+(?:\\.\\d+)?|\\.\\d+)';
// One channel of a relative color: a channel name, a number, or calc() of those.
const CHANNEL = `(?:[lch]|alpha|${NUMBER}(?:%|deg)?|calc\\([lch\\d.\\s+*/-]+\\))`;

const KEY_PATTERN = /^[A-Za-z0-9_-]+$/;
const HEX_PATTERN = /^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
// rgb(1 2 3 / 50%), hsl(210deg, 40%, 50%), oklch(0.7 0.1 200): numbers only.
const NUMERIC_FUNCTION_PATTERN = new RegExp(`^${COLOR_FUNCTION}\\((?=[^)]*\\d)(?:[\\d.\\s,/%+-]|deg)+\\)$`);
const VAR_PATTERN = new RegExp(`^${VAR}$`);
// hsl(var(--chart-1)) and oklch(var(--name)).
const FUNCTION_OF_VAR_PATTERN = new RegExp(`^${COLOR_FUNCTION}\\(\\s*${VAR}\\s*\\)$`);
// The app palette: oklch(from var(--color-accent) calc(l + 0.18) calc(c * 0.7) h).
const RELATIVE_PATTERN = new RegExp(
  `^oklch\\(\\s*from\\s+${VAR}(?:\\s+${CHANNEL}){3}(?:\\s*/\\s*${CHANNEL})?\\s*\\)$`,
);

/** A key is safe in a CSS custom property name and in a selector: letters, digits, `_`, and `-`. */
export function isSafeChartKey(key: unknown): key is string {
  return typeof key === 'string' && key.length <= MAX_KEY_LENGTH && KEY_PATTERN.test(key);
}

/** A color is safe as a CSS value: hex, a numeric color function, or a var() of a plain name. */
export function isSafeChartColor(color: unknown): color is string {
  if (typeof color !== 'string') return false;
  const value = color.trim();
  if (!value || value.length > MAX_COLOR_LENGTH) return false;
  return (
    HEX_PATTERN.test(value) ||
    NUMERIC_FUNCTION_PATTERN.test(value) ||
    VAR_PATTERN.test(value) ||
    FUNCTION_OF_VAR_PATTERN.test(value) ||
    RELATIVE_PATTERN.test(value)
  );
}

export type ChartStyleConfig = Record<
  string,
  { color?: string; theme?: Readonly<Record<string, string | undefined>> }
>;

/** Theme name to the selector prefix for that theme. */
export const CHART_THEMES: Readonly<Record<string, string>> = { light: '', dark: '.dark' };

/**
 * Builds the CSS text for a chart. It drops each entry with an unsafe key or color, and returns null
 * when no safe entry is left.
 */
export function chartStyleCss(
  chartId: string,
  config: ChartStyleConfig,
  themes: Readonly<Record<string, string>> = CHART_THEMES,
): string | null {
  if (!isSafeChartKey(chartId)) return null;
  const entries = Object.entries(config).filter(([key]) => isSafeChartKey(key));
  const blocks: string[] = [];
  for (const [theme, prefix] of Object.entries(themes)) {
    const lines: string[] = [];
    for (const [key, item] of entries) {
      const color = item.theme?.[theme] ?? item.color;
      if (isSafeChartColor(color)) lines.push(`  --color-${key}: ${color.trim()};`);
    }
    if (lines.length)
      blocks.push(`${prefix ? `${prefix} ` : ''}[data-chart=${chartId}] {\n${lines.join('\n')}\n}`);
  }
  return blocks.length ? blocks.join('\n') : null;
}
