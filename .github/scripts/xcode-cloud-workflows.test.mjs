import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { selectGitRefID } from './start-xcode-cloud.mjs';

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

test('staging no longer runs on a push to staging', () => {
  // Tier 2 replaced what it was for. It stays runnable by hand, so the machinery
  // and its scripts keep their coverage, but a push must not start it.
  const contents = workflow('xcode-cloud-staging.yml');

  assert.doesNotMatch(contents, /^on:\s*\n\s+push:/m);
  assert.match(contents, /^on:\s*\n\s+workflow_dispatch:/m);
});

test('staging builds iOS 27 in the production Xcode Cloud environment', () => {
  const contents = workflow('xcode-cloud-staging.yml');
  const project = readFileSync(new URL('../../apps/ios/project.yml', import.meta.url), 'utf8');

  assert.match(contents, /runs-on: blacksmith-6vcpu-macos-latest/);
  assert.match(contents, /name: Build iOS 27 in Xcode Cloud and distribute to TestFlight/);
  assert.match(contents, /if: github\.ref == 'refs\/heads\/staging'/);
  assert.match(contents, /XCODE_CLOUD_WORKFLOW_NAME: Production App Store/);
  assert.match(contents, /XCODE_CLOUD_BRANCH_NAME: staging/);
  assert.match(contents, /XCODE_CLOUD_GIT_REF_NAME: refs\/heads\/staging/);
  assert.match(contents, /XCODE_CLOUD_EXPECTED_XCODE_VERSION: "27\.0"/);
  assert.doesNotMatch(contents, /xcodebuild/);
  assert.match(project, /deploymentTarget:\s+iOS: "27\.0"/);
  assert.match(project, /xcodeVersion: "27\.0"/);
  assert.match(contents, new RegExp(immutableCheckout));
  assert.match(contents, /node --test \.github\/scripts\/app-store-connect\.test\.mjs/);
  assert.match(contents, /node --test \.github\/scripts\/upload-ios-export\.test\.mjs/);
  assert.match(contents, /BUILD_NUMBER: \$\{\{ steps\.start\.outputs\.build_number \}\}/);
  assert.match(contents, /XCODE_CLOUD_EXPECTED_COMMIT_SHA: \$\{\{ github\.sha \}\}/);
  assert.match(contents, /IPA_PATH="\$ipa_path" node \.github\/scripts\/upload-ios-export\.mjs/);
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
  const deployContents = workflow('deploy-production.yml');

  assert.match(contents, /runs-on: blacksmith-6vcpu-macos-latest/);
  assert.match(contents, new RegExp(immutableCheckout));
  assert.match(contents, /- name: Check out release automation\s+uses: actions\/checkout@/);
  assert.match(
    contents,
    /- name: Check out the production commit(?:(?!\n\s+- name: )[\s\S])*?\n\s+path: release-source\s+ref: \$\{\{ steps\.release\.outputs\.sha \}\}/,
  );
  assert.match(contents, /actions: read/);
  assert.match(contents, /actions\/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093/);
  assert.match(contents, /name: production-release-\$\{\{ steps\.deploy\.outputs\.run_id \}\}/);
  assert.match(contents, /XCODE_CLOUD_GIT_REF_NAME: refs\/heads\/main/);
  assert.match(contents, /XCODE_CLOUD_EXPECTED_COMMIT_SHA: \$\{\{ steps\.verify\.outputs\.build_sha \}\}/);
  assert.match(contents, /XCODE_CLOUD_EXPECTED_XCODE_VERSION: "27\.0"/);
  assert.match(
    readFileSync(new URL('./start-xcode-cloud.mjs', import.meta.url), 'utf8'),
    /manualTagStartCondition/,
  );
  assert.match(
    readFileSync(new URL('./start-xcode-cloud.mjs', import.meta.url), 'utf8'),
    /manualBranchStartCondition/,
  );
  assert.match(contents, /git -C "\$release_repo" merge-base --is-ancestor "\$release_sha" origin\/main/);
  assert.match(
    contents,
    /test "\$\(git rev-parse HEAD:apps\/ios\)" = "\$\(git -C "\$release_repo" rev-parse "\$\{release_sha\}:apps\/ios"\)"/,
  );
  assert.doesNotMatch(contents, /\$\{\{\s*github\.event\.workflow_run\.head_sha/);
  assert.match(deployContents, /name: Record immutable production release identity/);
  assert.match(deployContents, /release_sha="\$\(git rev-parse HEAD\)"/);
  assert.match(deployContents, /name: production-release-\$\{\{ github\.run_id \}\}/);
  assert.match(deployContents, new RegExp(immutableUploadArtifact));
  assert.match(contents, /node --test \.github\/scripts\/app-store-connect\.test\.mjs/);
  assert.match(contents, /node --test \.github\/scripts\/upload-ios-export\.test\.mjs/);
  assert.match(contents, /BUILD_NUMBER: \$\{\{ steps\.start\.outputs\.build_number \}\}/);
  assert.match(contents, /IPA_PATH="\$ipa_path" node \.github\/scripts\/upload-ios-export\.mjs/);
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

test('Xcode Cloud resolves immutable branch and tag references', () => {
  const references = [
    { id: 'branch-main', attributes: { name: 'main', canonicalName: 'refs/heads/main' } },
    { id: 'tag-release', attributes: { name: 'v0.9.0', canonicalName: 'refs/tags/v0.9.0' } },
  ];

  assert.equal(selectGitRefID(references, 'main'), 'branch-main');
  assert.equal(selectGitRefID(references, 'v0.9.0'), 'tag-release');
  assert.throws(() => selectGitRefID(references, 'v9.9.9'), /git reference "v9\.9\.9" was not found/);
});

test('TestFlight polling selects the newest matching upload deterministically', () => {
  const contents = readFileSync(new URL('./wait-for-testflight.mjs', import.meta.url), 'utf8');

  assert.match(contents, /sort: '-uploadedDate'/);
  assert.match(contents, /build = response\.data\[0\]/);
});
