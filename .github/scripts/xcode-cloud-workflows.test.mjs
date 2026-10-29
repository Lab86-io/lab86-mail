import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { buildRunCreatedAt, selectGitRefID } from './start-xcode-cloud.mjs';

const immutableUploadArtifact = 'actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02';
const immutableCheckout = 'actions/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5';

function workflow(name) {
  return readFileSync(new URL(`../workflows/${name}`, import.meta.url), 'utf8');
}

// Runs native-acceptance.sh with a stub xcodebuild and returns the argument
// list of each xcodebuild call.
function nativeAcceptanceCalls(platform) {
  const root = mkdtempSync(path.join(tmpdir(), 'native-acceptance-'));
  try {
    const stub = path.join(root, 'xcodebuild');
    const log = path.join(root, 'calls.log');
    writeFileSync(stub, '#!/bin/bash\n{ printf \'%s\\037\' "$@"; printf \'\\n\'; } >> "$XCODEBUILD_CALLS"\n');
    chmodSync(stub, 0o755);
    execFileSync('bash', [fileURLToPath(new URL('./native-acceptance.sh', import.meta.url)), platform], {
      cwd: root,
      env: { ...process.env, PATH: `${root}:${process.env.PATH}`, RUNNER_TEMP: root, XCODEBUILD_CALLS: log },
      stdio: 'pipe',
    });
    return readFileSync(log, 'utf8')
      .trimEnd()
      .split('\n')
      .map((line) => line.split('\x1f').slice(0, -1));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function argument(call, flag) {
  return call[call.indexOf(flag) + 1];
}

test('native app and test targets link the generated client runtime explicitly', () => {
  const project = readFileSync(new URL('../../apps/ios/project.yml', import.meta.url), 'utf8');
  const manifest = readFileSync(
    new URL('../../apps/ios/Packages/MobileAPI/Package.swift', import.meta.url),
    'utf8',
  );
  assert.match(
    project,
    /OpenAPIRuntime:\s+url: https:\/\/github.com\/apple\/swift-openapi-runtime\s+exactVersion: 1\.12\.0/,
  );
  assert.match(manifest, /swift-openapi-runtime",\s+exact: "1\.12\.0"/);
  for (const name of ['Lab86Mail', 'Lab86MailMac', 'Lab86MailTests', 'Lab86MailMacTests']) {
    const target = project.match(
      new RegExp(`^  ${name}:\\n([\\s\\S]*?)(?=^  [A-Za-z].*:|(?![\\s\\S]))`, 'm'),
    )?.[1];
    assert.match(target || '', /package: OpenAPIRuntime\s+product: OpenAPIRuntime/);
  }
});

test('native acceptance builds both native targets without signing or distributing', () => {
  const contents = workflow('native-acceptance.yml');
  const script = readFileSync(new URL('./native-acceptance.sh', import.meta.url), 'utf8');
  assert.match(contents, /platform: \[ios, macos, release\]/);
  assert.match(contents, /runs-on: xcode-27/);
  assert.match(contents, /contents: read/);
  assert.match(script, /-only-testing:Lab86MailTests/);
  assert.match(script, /generic\/platform=iOS/);
  assert.match(script, /generic\/platform=macOS' build-for-testing/);
  assert.match(script, /CODE_SIGNING_ALLOWED=NO/);
  assert.match(script, /ENABLE_DEBUG_DYLIB=NO/);
  assert.doesNotMatch(contents + script, /ASC_PRIVATE_KEY|upload-ios-export|start-xcode-cloud/);
});

test('the release job builds both apps in Release, as Xcode Cloud archives them', () => {
  // Optimizer crashes show only in Release (the v0.16.45 archive), so the
  // release job must build both apps that way and nothing else.
  const calls = nativeAcceptanceCalls('release');
  assert.deepEqual(
    calls.map((call) => [argument(call, '-scheme'), argument(call, '-destination'), call.at(-1)]),
    [
      ['Lab86Mail', 'generic/platform=iOS', 'build'],
      ['Lab86MailMac', 'generic/platform=macOS', 'build'],
    ],
  );
  for (const call of calls) {
    assert.equal(argument(call, '-configuration'), 'Release');
    assert.ok(call.includes('CODE_SIGNING_ALLOWED=NO'));
  }
  // The other jobs keep Debug.
  for (const call of nativeAcceptanceCalls('macos')) {
    assert.equal(argument(call, '-configuration'), 'Debug');
  }
});

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
  assert.match(contents, /XCODE_CLOUD_GIT_REF_NAME: \$\{\{ steps\.release\.outputs\.git_ref \}\}/);
  assert.match(contents, /XCODE_CLOUD_EXPECTED_COMMIT_SHA: \$\{\{ steps\.release\.outputs\.sha \}\}/);
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

test('TestFlight polling selects the newest matching upload and proves its provenance', () => {
  const contents = readFileSync(new URL('./wait-for-testflight.mjs', import.meta.url), 'utf8');

  assert.match(contents, /sort: '-uploadedDate'/);
  assert.match(contents, /include: 'preReleaseVersion'/);
  // The build number alone cannot distinguish this run's upload from a
  // phantom release; the verified selection carries marketing version and
  // upload time.
  assert.match(contents, /selectVerifiedBuild\(\{/);
  assert.match(contents, /marketingVersion: process\.env\.EXPECTED_MARKETING_VERSION/);
  assert.match(contents, /notBefore: process\.env\.BUILD_NOT_BEFORE/);
});

test('the TestFlight floor is the build run creation date, else the time the build was requested', () => {
  const requestedAt = '2026-09-03T04:46:00.000Z';
  assert.equal(
    buildRunCreatedAt({ attributes: { createdDate: '2026-09-03T04:46:31.394Z' } }, requestedAt),
    '2026-09-03T04:46:31.394Z',
  );
  // App Store Connect omitted the date on the resolved run in the v0.14.0
  // release, which reached the TestFlight step as the string "undefined".
  assert.equal(buildRunCreatedAt({ attributes: { number: 196 } }, requestedAt), requestedAt);
  assert.equal(buildRunCreatedAt({ attributes: { createdDate: 'undefined' } }, requestedAt), requestedAt);
  assert.equal(buildRunCreatedAt(undefined, requestedAt), requestedAt);
});
