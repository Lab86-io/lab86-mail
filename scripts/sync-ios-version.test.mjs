import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { syncIOSVersion } from './sync-ios-version.mjs';

test('syncs the iOS marketing version to the release version', () => {
  let written;
  const version = syncIOSVersion({
    version: '0.8.49',
    read: () => 'MARKETING_VERSION = 0.1.0\nCURRENT_PROJECT_VERSION = 1\n',
    write: (path, contents) => {
      written = { path, contents };
    },
  });

  assert.equal(version, '0.8.49');
  assert.deepEqual(written, {
    path: 'apps/ios/Config/Base.xcconfig',
    contents: 'MARKETING_VERSION = 0.8.49\nCURRENT_PROJECT_VERSION = 1\n',
  });
});

test('rejects a version App Store Connect cannot use', () => {
  assert.throws(
    () => syncIOSVersion({ version: '0.8.49-beta', read: () => '', write: () => {} }),
    /Invalid iOS marketing version/,
  );
});

test('fails closed when the Xcode setting is missing or duplicated', () => {
  assert.throws(
    () => syncIOSVersion({ version: '0.8.49', read: () => '', write: () => {} }),
    /exactly one MARKETING_VERSION/,
  );
  assert.throws(
    () =>
      syncIOSVersion({
        version: '0.8.49',
        read: () => 'MARKETING_VERSION = 0.1.0\nMARKETING_VERSION = 0.2.0\n',
        write: () => {},
      }),
    /exactly one MARKETING_VERSION/,
  );
});

test('production releases commit the same version to web and iOS', () => {
  const workflow = readFileSync(
    new URL('../.github/workflows/deploy-production.yml', import.meta.url),
    'utf8',
  );

  assert.match(workflow, /node scripts\/sync-ios-version\.mjs "\$version"/);
  assert.match(workflow, /git add package\.json apps\/ios\/Config\/Base\.xcconfig/);
});
