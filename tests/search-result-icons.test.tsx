import { describe, expect, test } from 'bun:test';
import { forwardRef, useImperativeHandle } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { SearchResultIcon, searchResultIcon } from '../components/palette/SearchResultIcon';
import { RAIL_SURFACE_ICONS } from '../components/shell/navigation-icons';
import { FileTextIcon } from '../components/ui/file-text';
import { FolderIcon } from '../components/ui/folder';
import { HistoryIcon } from '../components/ui/history';
import { LayoutGridIcon } from '../components/ui/layout-grid';
import { RowIcon } from '../components/ui/row-icon';
import { SettingsIcon } from '../components/ui/settings';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe('search result icons', () => {
  test('primary destinations reuse the exact rail components', () => {
    for (const view of ['today', 'albatrosses', 'mail', 'calendar', 'files'] as const) {
      expect(searchResultIcon({ kind: 'page', view })).toBe(RAIL_SURFACE_ICONS[view]);
      const search = renderToStaticMarkup(
        <SearchResultIcon target={{ kind: 'page', view }} active={false} />,
      );
      const rail = renderToStaticMarkup(<RowIcon icon={RAIL_SURFACE_ICONS[view]} size={16} />);
      expect(search.match(/<svg[\s\S]*<\/svg>/)?.[0]).toBe(rail.match(/<svg[\s\S]*<\/svg>/)?.[0]);
      expect(search).toContain('width="16"');
    }
  });

  test('other destinations and content use the matching animated glyph', () => {
    expect(searchResultIcon({ kind: 'page', view: 'areas' })).toBe(FolderIcon);
    expect(searchResultIcon({ kind: 'page', view: 'activity' })).toBe(HistoryIcon);
    expect(searchResultIcon({ kind: 'page', view: 'tasks' })).toBe(LayoutGridIcon);
    expect(searchResultIcon({ kind: 'settings' })).toBe(SettingsIcon);
    expect(searchResultIcon({ kind: 'mail', account: 'a', threadId: 't' })).toBe(RAIL_SURFACE_ICONS.mail);
    expect(
      searchResultIcon({
        kind: 'calendar',
        event: { accountId: 'a', calendarId: 'c', eventId: 'e', startIso: '2026-09-08' },
      }),
    ).toBe(RAIL_SURFACE_ICONS.calendar);
    expect(searchResultIcon({ kind: 'document', documentId: 'd' })).toBe(FileTextIcon);
    expect(searchResultIcon({ kind: 'google', connectionId: 'c', fileId: 'f', mimeType: 'text/plain' })).toBe(
      FileTextIcon,
    );
    expect(searchResultIcon({ kind: 'external', url: 'https://example.com' })).toBe(FileTextIcon);
  });
});

test('row animations follow keyboard selection, whole-row hover, and clean up listeners', async () => {
  const calls: string[] = [];
  const FakeIcon = forwardRef<{ startAnimation: () => void; stopAnimation: () => void }>((_, ref) => {
    useImperativeHandle(ref, () => ({
      startAnimation: () => {
        calls.push('start');
      },
      stopAnimation: () => {
        calls.push('stop');
      },
    }));
    return null;
  });
  const row = new EventTarget();
  const host = {
    closest: (selector: string) => {
      expect(selector).toContain('[data-icon-row]');
      return row;
    },
  };
  let renderer!: ReactTestRenderer;
  try {
    await act(async () => {
      renderer = create(<RowIcon icon={FakeIcon} active={false} />, { createNodeMock: () => host });
    });
    calls.length = 0;
    row.dispatchEvent(new Event('mouseenter'));
    row.dispatchEvent(new Event('mouseleave'));
    expect(calls).toEqual(['start', 'stop']);

    calls.length = 0;
    await act(async () => renderer.update(<RowIcon icon={FakeIcon} active />));
    expect(calls).toEqual(['start']);
    row.dispatchEvent(new Event('mouseleave'));
    expect(calls).toEqual(['start']);

    await act(async () => renderer.update(<RowIcon icon={FakeIcon} active={false} />));
    expect(calls).toEqual(['start', 'stop']);
    calls.length = 0;
    row.dispatchEvent(new Event('mouseenter'));
    expect(calls).toEqual(['start']);
  } finally {
    await act(async () => renderer?.unmount());
  }
  calls.length = 0;
  row.dispatchEvent(new Event('mouseenter'));
  row.dispatchEvent(new Event('mouseleave'));
  expect(calls).toEqual([]);
});
