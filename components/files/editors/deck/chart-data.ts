/**
 * Chart data as editable text: one line per category, values separated by
 * commas. "Q1, 180" for one series; "Q1, 180, 120" for two. Pure and
 * round-trip safe, so the inspector can show and read back the same text.
 */
import type { DeckChartElement } from '@/lib/documents/model';

export type ChartRows = Pick<DeckChartElement, 'categories' | 'series'>;

/** The element's data as text lines. */
export function formatChartRows(chart: ChartRows): string {
  return chart.categories
    .map((category, index) =>
      [category, ...chart.series.map((series) => series.values[index] ?? 0)].join(', '),
    )
    .join('\n');
}

/**
 * Parse text lines back into categories and series. Series names come from
 * the element; extra columns get a numbered name; missing cells read as 0.
 */
export function parseChartRows(text: string, seriesNames: string[]): { rows: ChartRows } | { error: string } {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (!lines.length) return { error: 'Add at least one line: label, value.' };
  if (lines.length > 60) return { error: 'A chart holds at most 60 categories.' };
  const categories: string[] = [];
  const columns: number[][] = [];
  for (const [lineIndex, line] of lines.entries()) {
    const cells = line.split(',').map((cell) => cell.trim());
    const label = cells.shift() ?? '';
    if (!label) return { error: `Line ${lineIndex + 1} needs a label before the first comma.` };
    if (!cells.length) return { error: `Line ${lineIndex + 1} needs a value after the label.` };
    const values = cells.map((cell) => {
      const cleaned = cell.replace(/[^0-9.+-]/g, '');
      return cleaned ? Number(cleaned) : Number.NaN;
    });
    const bad = values.findIndex((value) => !Number.isFinite(value));
    if (bad >= 0) return { error: `Line ${lineIndex + 1}: "${cells[bad]}" is not a number.` };
    if (values.length > 12) return { error: 'A chart holds at most 12 series.' };
    categories.push(label.slice(0, 120));
    for (const [column, value] of values.entries()) {
      columns[column] ??= [];
      columns[column][lineIndex] = value;
    }
  }
  const series = columns.map((values, index) => ({
    name: seriesNames[index] ?? `Series ${index + 1}`,
    values: categories.map((_, row) => values[row] ?? 0),
  }));
  return { rows: { categories, series } };
}
