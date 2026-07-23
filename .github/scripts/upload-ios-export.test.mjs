import assert from 'node:assert/strict';
import test from 'node:test';

import { classifyUploadResult, uploadIOSExport } from './upload-ios-export.mjs';

const baseEnvironment = {
  ASC_ISSUER_ID: 'issuer',
  ASC_KEY_ID: 'key',
  ASC_PRIVATE_KEY: 'private-key',
  BUILD_NUMBER: '40',
  IPA_PATH: '/tmp/Albatross.ipa',
  RUNNER_TEMP: '/tmp/runner',
};

test('accepts an exact duplicate when Xcode Cloud already uploaded the same build', () => {
  const output = [
    'ENTITY_ERROR.ATTRIBUTE.INVALID.DUPLICATE',
    'The bundle version must be higher than the previously uploaded version: ‘40’.',
    'previousBundleVersion : 40',
  ].join('\n');

  assert.equal(classifyUploadResult({ status: 1, output, buildNumber: '40' }), 'already-uploaded');
});

test('rejects a duplicate response for a different build number', () => {
  const output = [
    'ENTITY_ERROR.ATTRIBUTE.INVALID.DUPLICATE',
    'The bundle version must be higher than the previously uploaded version: ‘39’.',
    'previousBundleVersion : 39',
  ].join('\n');

  assert.equal(classifyUploadResult({ status: 1, output, buildNumber: '40' }), 'failed');
});

test('rejects unrelated upload failures', () => {
  assert.equal(
    classifyUploadResult({ status: 1, output: 'Authentication failed', buildNumber: '40' }),
    'failed',
  );
});

test('uploads with the protected key directory and removes the temporary key', () => {
  const calls = [];
  const output = [];
  const result = uploadIOSExport({
    env: baseEnvironment,
    makeDirectory: (...arguments_) => calls.push(['mkdir', ...arguments_]),
    write: (...arguments_) => calls.push(['write', ...arguments_]),
    chmod: (...arguments_) => calls.push(['chmod', ...arguments_]),
    remove: (...arguments_) => calls.push(['remove', ...arguments_]),
    run: (...arguments_) => {
      calls.push(['run', ...arguments_]);
      return { status: 0, stdout: '{"success":true}\n', stderr: '' };
    },
    stdout: { write: (value) => output.push(value) },
    stderr: { write: (value) => output.push(value) },
  });

  assert.equal(result, 'uploaded');
  assert.equal(calls[0][0], 'mkdir');
  assert.equal(calls[1][0], 'write');
  assert.equal(calls[2][0], 'chmod');
  assert.equal(calls[3][0], 'run');
  assert.equal(calls[3][1], 'xcrun');
  assert.deepEqual(calls[3][2].slice(0, 2), ['altool', '--upload-app']);
  assert.equal(calls[3][3].env.API_PRIVATE_KEYS_DIR, '/tmp/runner/app-store-connect-private-keys');
  assert.equal(calls.at(-1)[0], 'remove');
  assert.deepEqual(output, ['{"success":true}\n']);
});

test('an exact duplicate still continues and cleans up the private key', () => {
  const removed = [];
  const messages = [];
  const result = uploadIOSExport({
    env: baseEnvironment,
    makeDirectory: () => {},
    write: () => {},
    chmod: () => {},
    remove: (path) => removed.push(path),
    run: () => ({
      status: 1,
      stdout: '',
      stderr: ['ENTITY_ERROR.ATTRIBUTE.INVALID.DUPLICATE', 'previousBundleVersion : 40'].join('\n'),
    }),
    stdout: { write: (value) => messages.push(value) },
    stderr: { write: (value) => messages.push(value) },
  });

  assert.equal(result, 'already-uploaded');
  assert.equal(removed.length, 1);
  assert.match(messages.join(''), /already accepted build 40/);
});
