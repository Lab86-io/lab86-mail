import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { TOOL_UI_RENDERED_TOOLS, ToolUiDisplayPart } from '../components/ai-elements/tool-ui-part';
import { toolActivityLine } from '../lib/albatross/teach-ui';
import { fileToolNavigationPath } from '../lib/documents/deep-link';

describe('document edit result UI', () => {
  test('review and applied states stay distinct in cards and activity', () => {
    expect(TOOL_UI_RENDERED_TOOLS.has('document_edit')).toBe(true);
    const output = {
      ok: true,
      openPath: '/?view=files&document=one',
      revision: 4,
      summary: 'Clarify the plan',
    };
    const proposed = renderToStaticMarkup(
      <ToolUiDisplayPart toolName="document_edit" output={{ ...output, status: 'proposed' }} />,
    );
    expect(proposed).toContain('Review the suggestion');
    expect(proposed).not.toContain('Saved revision');
    expect(proposed).toContain('Clarify the plan');
    const applied = renderToStaticMarkup(
      <ToolUiDisplayPart toolName="document_edit" output={{ ...output, status: 'applied' }} />,
    );
    expect(applied).toContain('Saved revision 4');
    expect(
      JSON.stringify(
        toolActivityLine('document_edit', {}, 'output-available', { ...output, status: 'proposed' }),
      ),
    ).toContain('not yet applied');
    expect(
      JSON.stringify(
        toolActivityLine('document_edit', {}, 'output-available', { ok: false, status: 'conflict' }),
      ),
    ).not.toContain('Saved a new');
  });
  test('file links retain the shell only for same-origin Files destinations', () => {
    expect(fileToolNavigationPath('/?view=files&document=one', 'https://albatross.test/?view=chat')).toBe(
      '/?view=files&document=one',
    );
    expect(fileToolNavigationPath('/?view=files&office=two', 'https://albatross.test/')).toBe(
      '/?view=files&office=two',
    );
    expect(fileToolNavigationPath('https://evil.test/?view=files', 'https://albatross.test/')).toBeNull();
    expect(fileToolNavigationPath('/settings', 'https://albatross.test/')).toBeNull();
    expect(fileToolNavigationPath('/?view=files', 'https://albatross.test/settings')).toBeNull();
  });
});
