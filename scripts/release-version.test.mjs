import assert from 'node:assert/strict';
import test from 'node:test';

import {
  compareVersions,
  detectBump,
  detectExplicitVersion,
  nextVersion,
  parseArguments,
  resolveVersion,
} from './release-version.mjs';

test('a batch that says nothing about itself is a patch', () => {
  assert.equal(detectBump('fix: tighten the sidebar scrub'), 'patch');
  assert.equal(resolveVersion({ current: '0.9.1', text: 'fix: something' }), '0.9.2');
});

test('honours the original bracket markers', () => {
  assert.equal(detectBump('feat: areas [MINOR]'), 'minor');
  assert.equal(detectBump('rewrite [MAJOR]'), 'major');
});

test('a Release-Bump trailer states the level outright', () => {
  assert.equal(detectBump('promote the fast lane batch\n\nRelease-Bump: minor'), 'minor');
  assert.equal(resolveVersion({ current: '0.9.1', text: 'x\n\nRelease-Bump: minor' }), '0.10.0');
});

test('a Release-As trailer states the version outright and outranks the level', () => {
  assert.equal(detectExplicitVersion('ship it\n\nRelease-As: 1.0.0'), '1.0.0');
  assert.equal(
    resolveVersion({ current: '0.9.1', text: 'ship it\n\nRelease-As: v1.0.0\nRelease-Bump: patch' }),
    '1.0.0',
  );
});

test('an explicit argument outranks anything written in the batch', () => {
  assert.equal(resolveVersion({ current: '0.9.1', text: 'Release-Bump: major', bump: 'minor' }), '0.10.0');
  assert.equal(resolveVersion({ current: '0.9.1', text: 'Release-As: 2.0.0', set: '1.0.0' }), '1.0.0');
});

test('refuses a version that does not advance the current one', () => {
  assert.throws(() => resolveVersion({ current: '0.9.1', set: '0.9.1' }), /does not advance/);
  assert.throws(() => resolveVersion({ current: '0.9.1', set: '0.9.0' }), /does not advance/);
});

test('refuses input that is not a version or a level', () => {
  assert.throws(() => resolveVersion({ current: '0.9.1', set: '1.0' }), /Not a release version/);
  assert.throws(() => resolveVersion({ current: '0.9.1', set: '01.2.3' }), /Not a release version/);
  assert.throws(() => resolveVersion({ current: '0.9.1', set: '' }), /Not a release version/);
  assert.throws(() => resolveVersion({ current: '0.9.1', bump: 'huge' }), /Not a bump level/);
});

test('refuses CLI options without values', () => {
  assert.throws(() => parseArguments(['node', 'release-version.mjs', '--set']), /Missing value for --set/);
});

test('refuses unknown CLI options', () => {
  assert.throws(
    () => parseArguments(['node', 'release-version.mjs', '--bumpp', 'minor']),
    /Unknown option: --bumpp/,
  );
});

test('bumps reset the lower components', () => {
  assert.equal(nextVersion('0.9.7', 'minor'), '0.10.0');
  assert.equal(nextVersion('0.9.7', 'major'), '1.0.0');
  assert.equal(nextVersion('0.9.7', 'patch'), '0.9.8');
});

test('compares versions numerically rather than as text', () => {
  assert.ok(compareVersions('0.10.0', '0.9.9') > 0);
  assert.equal(compareVersions('v1.2.3', '1.2.3'), 0);
});
