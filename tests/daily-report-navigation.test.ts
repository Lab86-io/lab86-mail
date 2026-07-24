import { describe, expect, test } from 'bun:test';
import { handleDailyReportNavigationAction } from '../lib/daily-report-navigation';
import { safeExternalUrl } from '../lib/shared/url';

function harness() {
  const selectedAreas: string[] = [];
  const selectedWork: string[] = [];
  const primaryViews: string[] = [];
  const opened: Array<[string, string, string]> = [];
  return {
    selectedAreas,
    selectedWork,
    primaryViews,
    opened,
    navigation: {
      setSelectedAreaId: (value: string) => selectedAreas.push(value),
      setSelectedWorkId: (value: string) => selectedWork.push(value),
      setPrimaryView: (value: 'areas') => primaryViews.push(value),
      openExternal: (url: string, target: '_blank', features: 'noopener,noreferrer') =>
        opened.push([url, target, features]),
    },
  };
}

describe('Daily Report navigation actions', () => {
  test('open_work validates its id and opens the selected area and work surface', () => {
    const target = harness();

    expect(
      handleDailyReportNavigationAction(
        'open_work',
        { areaId: ' area-1 ', workId: ' work-1 ' },
        target.navigation,
      ),
    ).toEqual({ ok: true });
    expect(target.selectedAreas).toEqual(['area-1']);
    expect(target.selectedWork).toEqual(['work-1']);
    expect(target.primaryViews).toEqual(['areas']);

    expect(handleDailyReportNavigationAction('open_work', { workId: ' ' }, target.navigation)).toEqual({
      ok: false,
      error: 'missing workId',
    });
    expect(target.selectedWork).toEqual(['work-1']);
  });

  test('open_url opens only HTTPS URLs with a host', () => {
    const target = harness();

    expect(
      handleDailyReportNavigationAction(
        'open_url',
        { url: ' https://example.com/path?q=brief ' },
        target.navigation,
      ),
    ).toEqual({ ok: true });
    expect(target.opened).toEqual([['https://example.com/path?q=brief', '_blank', 'noopener,noreferrer']]);

    for (const payload of [
      {},
      { url: '' },
      { url: 'not a url' },
      { url: 'http://example.com' },
      { url: 'javascript:alert(1)' },
    ]) {
      expect(handleDailyReportNavigationAction('open_url', payload, target.navigation).ok).toBeFalse();
    }
    expect(target.opened).toHaveLength(1);
  });

  test('the shared URL gate rejects missing hosts and non-HTTPS protocols', () => {
    expect(safeExternalUrl('https://lab86.io/brief')).toBe('https://lab86.io/brief');
    expect(safeExternalUrl('https:///')).toBeNull();
    expect(safeExternalUrl('http://lab86.io/brief')).toBeNull();
    expect(safeExternalUrl('mailto:jakob@lab86.io')).toBeNull();
  });
});
