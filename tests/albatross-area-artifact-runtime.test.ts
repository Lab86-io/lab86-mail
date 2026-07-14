import { describe, expect, test } from 'bun:test';
import {
  AREA_ARTIFACT_MESSAGE_SOURCE,
  AREA_ARTIFACT_RUNTIME_JS,
  injectAreaArtifactRuntime,
  parseAreaArtifactMessage,
} from '../lib/albatross/area-artifact-runtime';

const areaId = 'area_123';

describe('Area artifact runtime injection', () => {
  test('injects once before body close and passes empty input through', () => {
    const once = injectAreaArtifactRuntime('<!doctype html><html><body>Area</body></html>');
    const twice = injectAreaArtifactRuntime(once);
    expect(once.indexOf('lab86-area-runtime-js')).toBeGreaterThan(-1);
    expect(once.indexOf('lab86-area-runtime-js')).toBeLessThan(once.indexOf('</body>'));
    expect(twice.match(/id="lab86-area-runtime-js"/g)).toHaveLength(1);
    expect(injectAreaArtifactRuntime('')).toBe('');
  });

  test('owns capture form input and live theme behavior without app API access', () => {
    expect(AREA_ARTIFACT_RUNTIME_JS).toContain("closest('[data-area-capture]')");
    expect(AREA_ARTIFACT_RUNTIME_JS).toContain("querySelector('[data-capture-input]')");
    expect(AREA_ARTIFACT_RUNTIME_JS).toContain("source:'lab86-area-artifact'");
    expect(AREA_ARTIFACT_RUNTIME_JS).toContain("d.type==='theme'");
    expect(AREA_ARTIFACT_RUNTIME_JS).not.toContain('fetch(');
    expect(AREA_ARTIFACT_RUNTIME_JS).not.toContain('localStorage');
  });
});

describe('Area artifact host allowlist', () => {
  test('accepts each declared read/navigation action', () => {
    expect(
      parseAreaArtifactMessage(
        { source: AREA_ARTIFACT_MESSAGE_SOURCE, action: 'open_work', payload: { workId: 'work_1' } },
        areaId,
      ),
    ).toEqual({ action: 'open_work', payload: { workId: 'work_1' } });
    expect(
      parseAreaArtifactMessage(
        {
          source: AREA_ARTIFACT_MESSAGE_SOURCE,
          action: 'open_thread',
          payload: { accountId: 'acct', threadId: 'thread' },
        },
        areaId,
      ),
    ).toEqual({ action: 'open_thread', payload: { accountId: 'acct', threadId: 'thread' } });
    expect(
      parseAreaArtifactMessage(
        {
          source: AREA_ARTIFACT_MESSAGE_SOURCE,
          action: 'open_event',
          payload: { accountId: 'acct', eventId: 'event' },
        },
        areaId,
      ),
    ).toEqual({ action: 'open_event', payload: { accountId: 'acct', eventId: 'event' } });
    expect(
      parseAreaArtifactMessage(
        { source: AREA_ARTIFACT_MESSAGE_SOURCE, action: 'open_thread', payload: { accountId: 'acct' } },
        areaId,
      ),
    ).toBeNull();
    expect(
      parseAreaArtifactMessage(
        { source: AREA_ARTIFACT_MESSAGE_SOURCE, action: 'open_event', payload: { eventId: 'event' } },
        areaId,
      ),
    ).toBeNull();
    expect(
      parseAreaArtifactMessage(
        {
          source: AREA_ARTIFACT_MESSAGE_SOURCE,
          action: 'open_work',
          payload: { workId: 'x'.repeat(201) },
        },
        areaId,
      ),
    ).toBeNull();
    expect(
      parseAreaArtifactMessage({ source: AREA_ARTIFACT_MESSAGE_SOURCE, action: 'open_tasks' }, areaId),
    ).toEqual({ action: 'open_tasks', payload: {} });
  });

  test('accepts area-scoped discuss/capture and rejects cross-area or malformed messages', () => {
    expect(
      parseAreaArtifactMessage(
        { source: AREA_ARTIFACT_MESSAGE_SOURCE, action: 'discuss_area', payload: { areaId } },
        areaId,
      ),
    ).toEqual({ action: 'discuss_area', payload: { areaId } });
    expect(
      parseAreaArtifactMessage(
        {
          source: AREA_ARTIFACT_MESSAGE_SOURCE,
          action: 'capture_intent',
          payload: { areaId, text: 'Plan the launch' },
        },
        areaId,
      ),
    ).toEqual({ action: 'capture_intent', payload: { areaId, text: 'Plan the launch' } });

    for (const bad of [
      null,
      { source: 'wrong', action: 'open_tasks' },
      { source: AREA_ARTIFACT_MESSAGE_SOURCE, action: 'archive_thread', payload: {} },
      { source: AREA_ARTIFACT_MESSAGE_SOURCE, action: 'open_work', payload: { workId: '' } },
      { source: AREA_ARTIFACT_MESSAGE_SOURCE, action: 'discuss_area', payload: { areaId: 'other' } },
      {
        source: AREA_ARTIFACT_MESSAGE_SOURCE,
        action: 'capture_intent',
        payload: { areaId, text: 'x'.repeat(2_001) },
      },
    ]) {
      expect(parseAreaArtifactMessage(bad, areaId)).toBeNull();
    }
  });
});
