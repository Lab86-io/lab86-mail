import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { JSDOM } from 'jsdom';
import { renderToStaticMarkup } from 'react-dom/server';
import { withReportArtifactRuntime } from '../components/report/DailyReport';
import { AssistantLauncher, RailPrimaryActions } from '../components/shell/ShellActions';
import { SidebarProvider } from '../components/ui/sidebar';

/*
 * The floating "Ask Albatross" launcher on a phone: no key hints on a touch
 * screen, and room at the end of each page's scroll area so the launcher
 * never covers its last rows.
 */

const ROOT = path.join(import.meta.dir, '..');
const read = (rel: string) => readFileSync(path.join(ROOT, rel), 'utf8');
const css = read('components/shell/assistant-workspace.css');

/** The body of the first `@media <query> { ... }` block in the stylesheet. */
function mediaBlock(query: string) {
  const start = css.indexOf(`@media ${query} {`);
  if (start < 0) return '';
  let depth = 0;
  for (let index = css.indexOf('{', start); index < css.length; index++) {
    if (css[index] === '{') depth++;
    else if (css[index] === '}' && --depth === 0) return css.slice(start, index + 1);
  }
  return '';
}

describe('key hints on a touch screen', () => {
  test('the launcher and the rail search mark their key hints', () => {
    const launcher = new JSDOM(
      renderToStaticMarkup(<AssistantLauncher placement="corner" shortcut="Ctrl K" onOpen={() => {}} />),
    ).window.document;
    expect(launcher.querySelector('kbd')?.className.split(' ')).toContain('shell-key-hint');

    const rail = new JSDOM(
      renderToStaticMarkup(
        <SidebarProvider>
          <RailPrimaryActions searchShortcut="Ctrl F" onSearch={() => {}} />
        </SidebarProvider>,
      ),
    ).window.document;
    const hint = rail.querySelector('kbd')?.parentElement;
    expect(hint?.className.split(' ')).toContain('shell-key-hint');
  });

  test('a coarse pointer hides the hints and closes the gap in the launcher', () => {
    const coarse = mediaBlock('(pointer: coarse)');
    expect(coarse).toMatch(/\.shell-key-hint\s*\{\s*display:\s*none;/);
    expect(coarse).toMatch(/\.assistant-launcher\s*\{\s*grid-template-columns:\s*minmax\(0, 1fr\);/);
    // The override comes after the launcher's own grid, so it wins.
    expect(css.indexOf('@media (pointer: coarse)')).toBeGreaterThan(css.indexOf('.assistant-launcher {'));
  });
});

describe('room for the launcher at the end of a page', () => {
  test('the clearance covers the launcher: 24px up, 44px tall, with room to spare', () => {
    const value = Number(css.match(/--assistant-launcher-clearance:\s*(\d+)px/)?.[1]);
    expect(value).toBeGreaterThanOrEqual(24 + 44);
    expect(css).toMatch(
      /\.assistant-launcher-clearance\s*\{\s*padding-bottom:\s*var\(--assistant-launcher-clearance\);/,
    );
  });

  test('Today, Mail, and Albatrosses end their scroll areas with the clearance', () => {
    expect(read('components/report/brief-canvas/BriefCanvas.tsx')).toContain(
      "'scrollable assistant-launcher-clearance h-full overflow-y-auto",
    );
    expect(read('components/report/DailyReport.tsx')).toContain(
      "'scrollable assistant-launcher-clearance px-5 pt-5'",
    );
    expect(read('components/inbox/Inbox.tsx')).toMatch(
      /data-mail-results\s+className="scrollable assistant-launcher-clearance /,
    );
    expect(read('components/albatross/AlbatrossesSurface.tsx')).toContain(
      'className="assistant-launcher-clearance min-h-0 flex-1 overflow-y-auto',
    );
  });

  test('an older HTML edition that fills the pane leaves the room inside its own frame', () => {
    const edition =
      '<!doctype html><html><head><style>html,body{margin:0;padding:0}</style></head><body><p>Brief</p></body></html>';
    const framed = withReportArtifactRuntime(edition, null, { launcherClearance: true });
    const style = framed.indexOf('id="lab86-launcher-clearance"');
    expect(style).toBeGreaterThan(framed.indexOf('html,body{margin:0;padding:0}'));
    expect(style).toBeLessThan(framed.toLowerCase().lastIndexOf('</body>'));
    expect(framed).toContain('html:root{padding-bottom:88px}');
    // A frame that grows with the page scroll leaves the room to the page.
    expect(withReportArtifactRuntime(edition, null)).not.toContain('lab86-launcher-clearance');
    expect(withReportArtifactRuntime(edition, null, { launcherClearance: false })).not.toContain(
      'lab86-launcher-clearance',
    );
  });

  test('the frame clearance matches the page clearance', () => {
    const page = Number(css.match(/--assistant-launcher-clearance:\s*(\d+)px/)?.[1]);
    const framed = withReportArtifactRuntime('<html><body></body></html>', null, { launcherClearance: true });
    expect(framed).toContain(`padding-bottom:${page}px`);
  });
});
