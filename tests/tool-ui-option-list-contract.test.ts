import { describe, expect, test } from 'bun:test';
import { safeParseSerializableOptionList } from '../components/tool-ui/option-list/schema';

describe('Tool UI OptionList questionnaire contract', () => {
  test('supports a compact option list without nested actions', () => {
    expect(
      safeParseSerializableOptionList({
        id: 'question-one',
        options: [{ id: 'yes', label: 'Yes' }],
        selectionMode: 'single',
        density: 'compact',
        hideActions: true,
      }),
    ).toMatchObject({ density: 'compact', hideActions: true });
  });
});
