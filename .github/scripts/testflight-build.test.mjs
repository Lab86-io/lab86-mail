import assert from 'node:assert/strict';
import test from 'node:test';
import { describeBuild, selectVerifiedBuild } from './testflight-build.mjs';

function build(id, number, { uploaded, preRelease = 'pre-1', state = 'VALID' } = {}) {
  return {
    type: 'builds',
    id,
    attributes: { version: String(number), uploadedDate: uploaded, processingState: state },
    relationships: { preReleaseVersion: { data: { type: 'preReleaseVersions', id: preRelease } } },
  };
}

const included = [
  { type: 'preReleaseVersions', id: 'pre-1', attributes: { version: '0.13.0' } },
  { type: 'preReleaseVersions', id: 'pre-0', attributes: { version: '0.12.2' } },
];
const runCreatedAt = '2026-09-03T03:14:00Z';

test('describes a build with its marketing version and upload time', () => {
  const described = describeBuild(build('b1', 183, { uploaded: '2026-09-03T03:20:00Z' }), included);
  assert.equal(described.number, '183');
  assert.equal(described.marketingVersion, '0.13.0');
  assert.equal(described.uploadedAt.toISOString(), '2026-09-03T03:20:00.000Z');
});

test('accepts the build Xcode Cloud uploaded for this very run', () => {
  const { build: chosen, reason } = selectVerifiedBuild({
    builds: [build('b1', 183, { uploaded: '2026-09-03T03:20:00Z' })],
    included,
    buildNumber: '183',
    marketingVersion: '0.13.0',
    notBefore: runCreatedAt,
  });
  assert.equal(chosen.id, 'b1');
  assert.equal(reason, null);
});

test('rejects a build that predates this run even when the number matches', () => {
  const { build: chosen, reason } = selectVerifiedBuild({
    builds: [build('old', 90, { uploaded: '2026-07-27T23:10:00Z' })],
    included,
    buildNumber: '90',
    marketingVersion: '0.13.0',
    notBefore: runCreatedAt,
  });
  assert.equal(chosen, null);
  assert.match(reason, /before this run's Xcode Cloud build was created/);
});

test('rejects a build carrying a different marketing version', () => {
  const { build: chosen, reason } = selectVerifiedBuild({
    builds: [build('b2', 183, { uploaded: '2026-09-03T03:20:00Z', preRelease: 'pre-0' })],
    included,
    buildNumber: '183',
    marketingVersion: '0.13.0',
    notBefore: runCreatedAt,
  });
  assert.equal(chosen, null);
  assert.match(reason, /carries marketing version 0\.12\.2, not 0\.13\.0/);
});

test('reports nothing to decide while TestFlight has not registered the build', () => {
  const { build: chosen, reason } = selectVerifiedBuild({
    builds: [build('other', 182, { uploaded: '2026-09-03T03:10:00Z' })],
    included,
    buildNumber: '183',
    marketingVersion: '0.13.0',
    notBefore: runCreatedAt,
  });
  assert.equal(chosen, null);
  assert.equal(reason, null);
});

test('refuses to run without the provenance inputs', () => {
  assert.throws(
    () =>
      selectVerifiedBuild({ builds: [], buildNumber: '1', marketingVersion: '', notBefore: runCreatedAt }),
    /marketing version/,
  );
  assert.throws(
    () => selectVerifiedBuild({ builds: [], buildNumber: '1', marketingVersion: '1.0.0', notBefore: 'soon' }),
    /not-before/,
  );
});
