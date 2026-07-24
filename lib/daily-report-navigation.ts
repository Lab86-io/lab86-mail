import { safeExternalUrl } from './shared/url';

type DailyReportNavigationPayload = Record<string, unknown>;

export type DailyReportNavigationResult =
  | { ok: true }
  | { ok: false; error: 'missing workId' | 'missing url' | 'invalid or unsupported url' };

export function handleDailyReportNavigationAction(
  action: 'open_work' | 'open_url',
  payload: DailyReportNavigationPayload,
  navigation: {
    setSelectedAreaId: (value: string) => void;
    setSelectedWorkId: (value: string) => void;
    setPrimaryView: (value: 'areas') => void;
    openExternal: (url: string, target: '_blank', features: 'noopener,noreferrer') => void;
  },
): DailyReportNavigationResult {
  if (action === 'open_work') {
    const workId = stringPayload(payload.workId);
    if (!workId) return { ok: false, error: 'missing workId' };
    const areaId = stringPayload(payload.areaId);
    if (areaId) navigation.setSelectedAreaId(areaId);
    navigation.setSelectedWorkId(workId);
    navigation.setPrimaryView('areas');
    return { ok: true };
  }

  const value = stringPayload(payload.url);
  if (!value) return { ok: false, error: 'missing url' };
  const url = safeExternalUrl(value);
  if (!url) return { ok: false, error: 'invalid or unsupported url' };
  navigation.openExternal(url, '_blank', 'noopener,noreferrer');
  return { ok: true };
}

function stringPayload(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}
