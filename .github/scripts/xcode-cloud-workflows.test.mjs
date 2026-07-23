import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const immutableUploadArtifact = 'actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02';

function workflow(name) {
  return readFileSync(new URL(`../workflows/${name}`, import.meta.url), 'utf8');
}

test('staging preserves diagnostics and signed IPA with immutable upload actions', () => {
  const contents = workflow('xcode-cloud-staging.yml');

  assert.match(contents, /XCODE_CLOUD_DIAGNOSTICS_DIR: \$\{\{ runner\.temp \}\}\/xcode-cloud-diagnostics/);
  assert.match(contents, /name: Preserve failed Xcode Cloud diagnostics\s+if: failure\(\)/);
  assert.match(contents, /path: \$\{\{ runner\.temp \}\}\/xcode-cloud-diagnostics/);
  assert.match(contents, /if-no-files-found: ignore/);
  assert.match(contents, /retention-days: 1/);
  assert.match(contents, /name: Preserve signed staging IPA for physical acceptance/);
  assert.equal(contents.split(immutableUploadArtifact).length - 1, 2);
});

test('production preserves diagnostics with an immutable upload action', () => {
  const contents = workflow('xcode-cloud-production.yml');

  assert.match(contents, /XCODE_CLOUD_DIAGNOSTICS_DIR: \$\{\{ runner\.temp \}\}\/xcode-cloud-diagnostics/);
  assert.match(contents, /name: Preserve failed Xcode Cloud diagnostics\s+if: failure\(\)/);
  assert.match(contents, /path: \$\{\{ runner\.temp \}\}\/xcode-cloud-diagnostics/);
  assert.match(contents, /if-no-files-found: ignore/);
  assert.match(contents, /retention-days: 1/);
  assert.equal(contents.split(immutableUploadArtifact).length - 1, 1);
});
