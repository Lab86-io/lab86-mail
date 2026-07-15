import { describe, expect, test } from 'bun:test';
import {
  BRIEF_ARTIFACT_READY_RUNTIME_JS,
  injectBriefArtifactReadyRuntime,
  isBriefArtifactReadyMessage,
} from '@/lib/albatross/artifact-ready';

describe('brief artifact first-paint handshake', () => {
  test('waits for the host theme and fonts before announcing readiness', () => {
    expect(BRIEF_ARTIFACT_READY_RUNTIME_JS).toContain("d.type!=='theme'");
    expect(BRIEF_ARTIFACT_READY_RUNTIME_JS).toContain('document.fonts.ready');
    expect(BRIEF_ARTIFACT_READY_RUNTIME_JS).toContain("type:'ready'");
  });

  test('injects idempotently before the body closes', () => {
    const once = injectBriefArtifactReadyRuntime('<html><body>Brief</body></html>');
    const twice = injectBriefArtifactReadyRuntime(once);
    expect(once.indexOf('lab86-brief-ready-js')).toBeLessThan(once.indexOf('</body>'));
    expect(twice.match(/id="lab86-brief-ready-js"/g)).toHaveLength(1);
  });

  test('accepts only the readiness message contract', () => {
    expect(isBriefArtifactReadyMessage({ source: 'lab86-brief-artifact', type: 'ready' })).toBe(true);
    expect(isBriefArtifactReadyMessage({ source: 'lab86-host', type: 'ready' })).toBe(false);
  });
});
