import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const immutableUploadArtifact = 'actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02';
const immutableCheckout = 'actions/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5';

function workflow(name) {
  return readFileSync(new URL(`../workflows/${name}`, import.meta.url), 'utf8');
}

test('staging preserves diagnostics and signed IPA with immutable upload actions', () => {
  const contents = workflow('xcode-cloud-staging.yml');

  assert.match(contents, /runs-on: blacksmith-6vcpu-macos-latest/);
  assert.match(contents, new RegExp(immutableCheckout));
  assert.match(contents, /node --test \.github\/scripts\/app-store-connect\.test\.mjs/);
  assert.match(contents, /XCODE_CLOUD_DIAGNOSTICS_DIR: \$\{\{ runner\.temp \}\}\/xcode-cloud-diagnostics/);
  assert.match(contents, /name: Preserve failed Xcode Cloud diagnostics\s+if: failure\(\)/);
  assert.match(contents, /path: \$\{\{ runner\.temp \}\}\/xcode-cloud-diagnostics/);
  assert.match(contents, /if-no-files-found: ignore/);
  assert.match(contents, /retention-days: 1/);
  assert.match(contents, /name: Preserve signed staging IPA for physical acceptance/);
  assert.match(
    contents,
    /name: Confirm TestFlight processing and internal group assignment\s+env:\s+ASC_ISSUER_ID:/,
  );
  assert.equal(contents.split(immutableUploadArtifact).length - 1, 2);
});

test('production preserves diagnostics with an immutable upload action', () => {
  const contents = workflow('xcode-cloud-production.yml');

  assert.match(contents, /runs-on: blacksmith-6vcpu-macos-latest/);
  assert.match(contents, new RegExp(immutableCheckout));
  assert.match(contents, /node --test \.github\/scripts\/app-store-connect\.test\.mjs/);
  assert.match(contents, /XCODE_CLOUD_DIAGNOSTICS_DIR: \$\{\{ runner\.temp \}\}\/xcode-cloud-diagnostics/);
  assert.match(contents, /name: Preserve failed Xcode Cloud diagnostics\s+if: failure\(\)/);
  assert.match(contents, /path: \$\{\{ runner\.temp \}\}\/xcode-cloud-diagnostics/);
  assert.match(contents, /if-no-files-found: ignore/);
  assert.match(contents, /retention-days: 1/);
  assert.match(
    contents,
    /name: Confirm production TestFlight processing and internal group assignment\s+env:\s+ASC_ISSUER_ID:/,
  );
  assert.equal(contents.split(immutableUploadArtifact).length - 1, 1);
});
