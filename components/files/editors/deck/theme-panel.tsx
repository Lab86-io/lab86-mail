'use client';

import { DECK_THEMES } from '@/lib/documents/deck-fixtures';
import { DECK_FONTS, deckThemesEqual } from '@/lib/documents/deck-versions';
import type { DeckTheme } from '@/lib/documents/model';
import { slideColor } from '../deck-model';
import { ColorField, InspectorSection, SelectField } from './fields';

/**
 * Deck-wide design: a built-in palette, or the six colors and three font
 * slots one at a time. Every change goes through `onApply` with a whole
 * theme, so the editor keeps one code path and one undo step.
 */

const COLOR_ROWS: { key: keyof DeckTheme['colors']; label: string }[] = [
  { key: 'background', label: 'Background' },
  { key: 'surface', label: 'Surface' },
  { key: 'ink', label: 'Ink' },
  { key: 'muted', label: 'Muted' },
  { key: 'accent', label: 'Accent' },
  { key: 'accentInk', label: 'On accent' },
];

const FONT_SLOTS: { key: 'display' | 'body' | 'mono'; label: string }[] = [
  { key: 'display', label: 'Display' },
  { key: 'body', label: 'Body' },
  { key: 'mono', label: 'Mono' },
];

const FONT_OPTIONS = Object.keys(DECK_FONTS).map((family) => ({ value: family, label: family }));

export function themeWithFont(
  theme: DeckTheme,
  slot: 'display' | 'body' | 'mono',
  family: string,
): DeckTheme {
  const known = DECK_FONTS[family];
  const font = known ? { family, exportFamily: known.exportFamily, fallback: known.fallback } : { family };
  return { ...theme, name: 'Custom', fonts: { ...theme.fonts, [slot]: font } };
}

export function themeWithColor(theme: DeckTheme, key: keyof DeckTheme['colors'], value: string): DeckTheme {
  return { ...theme, name: 'Custom', colors: { ...theme.colors, [key]: value } };
}

export function ThemePanel({
  theme,
  readOnly = false,
  onApply,
}: {
  theme: DeckTheme;
  readOnly?: boolean;
  onApply: (theme: DeckTheme) => void;
}) {
  return (
    <InspectorSection title="Deck theme">
      <p className="deck-inspector-note">Applies to every slide. Slide edits stay.</p>
      <fieldset className="deck-theme-presets">
        <legend className="sr-only">Built-in themes</legend>
        {Object.entries(DECK_THEMES).map(([key, preset]) => {
          const active = deckThemesEqual(theme, preset);
          return (
            <button
              key={key}
              type="button"
              className="deck-theme-preset"
              aria-pressed={active}
              disabled={readOnly}
              onClick={() => onApply(preset)}
            >
              <span className="deck-theme-swatches" aria-hidden="true">
                <span style={{ background: slideColor(preset.colors.background, '#FFFFFF') }} />
                <span style={{ background: slideColor(preset.colors.ink, '#000000') }} />
                <span style={{ background: slideColor(preset.colors.accent, '#000000') }} />
              </span>
              <span className="deck-theme-preset-name">{preset.name}</span>
              <span className="deck-theme-preset-fonts">
                {preset.fonts.display.family} and {preset.fonts.body.family}
              </span>
            </button>
          );
        })}
      </fieldset>
      <div className="deck-inspector-group">
        {COLOR_ROWS.map((row) => (
          <ColorField
            key={row.key}
            label={row.label}
            value={theme.colors[row.key]}
            fallback={theme.colors[row.key]}
            disabled={readOnly}
            onChange={(value) => {
              if (value) onApply(themeWithColor(theme, row.key, value));
            }}
          />
        ))}
      </div>
      <div className="deck-inspector-group">
        {FONT_SLOTS.map((slot) => (
          <SelectField
            key={slot.key}
            label={slot.label}
            value={theme.fonts[slot.key]?.family ?? theme.fonts.body.family}
            options={FONT_OPTIONS}
            disabled={readOnly}
            onChange={(family) => onApply(themeWithFont(theme, slot.key, family))}
          />
        ))}
      </div>
    </InspectorSection>
  );
}
