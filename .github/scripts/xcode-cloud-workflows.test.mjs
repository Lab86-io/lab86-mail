import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const immutableUploadArtifact = 'actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02';
const immutableCheckout = 'actions/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5';

function workflow(name) {
  return readFileSync(new URL(`../workflows/${name}`, import.meta.url), 'utf8');
}

test('iOS auth dependency is pinned past the Clerk AuthView startup fix', () => {
  const project = readFileSync(new URL('../../apps/ios/project.yml', import.meta.url), 'utf8');
  const resolved = JSON.parse(
    readFileSync(
      new URL(
        '../../apps/ios/Lab86Mail.xcodeproj/project.xcworkspace/xcshareddata/swiftpm/Package.resolved',
        import.meta.url,
      ),
      'utf8',
    ),
  );
  const clerk = resolved.pins.find(({ identity }) => identity === 'clerk-ios');

  assert.match(project, /Clerk:\s+url: https:\/\/github\.com\/clerk\/clerk-ios\s+(?:#.*\s+)*from: 1\.3\.3/);
  assert.equal(clerk?.state.version, '1.3.3');
  assert.equal(clerk?.state.revision, '38a14dfb7f2e5be689975b0f3d6dfe347c425770');
});

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
  assert.match(contents, /curl --fail --location \\\s+--connect-timeout 30 \\\s+--max-time 1800/);
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
  assert.match(contents, /XCODE_CLOUD_TEMPLATE_WORKFLOW_ID: 304D20E5-2087-4E0D-8A6E-5E6025DEED36/);
  assert.match(contents, /XCODE_CLOUD_DIAGNOSTICS_DIR: \$\{\{ runner\.temp \}\}\/xcode-cloud-diagnostics/);
  assert.match(contents, /name: Preserve failed Xcode Cloud diagnostics\s+if: failure\(\)/);
  assert.match(contents, /path: \$\{\{ runner\.temp \}\}\/xcode-cloud-diagnostics/);
  assert.match(contents, /if-no-files-found: ignore/);
  assert.match(contents, /retention-days: 1/);
  assert.match(contents, /curl --fail --location \\\s+--connect-timeout 30 \\\s+--max-time 1800/);
  assert.match(
    contents,
    /name: Confirm production TestFlight processing and internal group assignment\s+env:\s+ASC_ISSUER_ID:/,
  );
  assert.equal(contents.split(immutableUploadArtifact).length - 1, 1);
});

test('TestFlight polling selects the newest matching upload deterministically', () => {
  const contents = readFileSync(new URL('./wait-for-testflight.mjs', import.meta.url), 'utf8');

  assert.match(contents, /sort: '-uploadedDate'/);
  assert.match(contents, /build = response\.data\[0\]/);
});
