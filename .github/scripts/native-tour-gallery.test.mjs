import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  artifactName,
  buildGallery,
  buildManifest,
  collectRecords,
  escapeHTML,
  renderGallery,
  summaryMarkdown,
} from './native-tour-gallery.mjs';

function record(overrides) {
  return {
    file: 'ios-mail-list-iphone-light.png',
    platform: 'iOS',
    screen: 'mail-list',
    screenTitle: 'Mail list',
    section: 'Mail',
    screenOrder: 4,
    variant: 'iphone-light',
    variantOrder: 0,
    device: 'iPhone',
    sizeClass: 'compact width',
    orientation: 'portrait',
    appearance: 'light',
    textSize: 'default',
    width: 402,
    height: 874,
    scale: 2,
    captureMethod: 'drawHierarchy',
    distinctBytes: 180,
    blankWarning: false,
    notes: [],
    requests: [],
    uncovered: [],
    ...overrides,
  };
}

async function writeTour(directory, records) {
  await mkdir(directory, { recursive: true });
  for (const entry of records) {
    await writeFile(path.join(directory, entry.file), 'png');
    await writeFile(path.join(directory, entry.file.replace(/\.png$/, '.json')), JSON.stringify(entry));
  }
}

test('orders images by platform, screen, and variant, and groups them by screen', () => {
  const manifest = buildManifest(
    [
      record({ file: 'macos-mac-today-light.png', platform: 'macOS', screen: 'mac-today', screenOrder: 0 }),
      record({ file: 'ios-mail-list-iphone-dark.png', variant: 'iphone-dark', variantOrder: 1 }),
      record({
        file: 'ios-today-brief-iphone-light.png',
        screen: 'today-brief',
        screenTitle: 'Today',
        screenOrder: 1,
      }),
      record({}),
    ],
    { generatedAt: '2026-09-28T00:00:00.000Z', commit: 'abc123' },
  );
  assert.deepEqual(
    manifest.images.map((image) => image.file),
    [
      'ios-today-brief-iphone-light.png',
      'ios-mail-list-iphone-light.png',
      'ios-mail-list-iphone-dark.png',
      'macos-mac-today-light.png',
    ],
  );
  assert.deepEqual(
    manifest.screens.map((group) => `${group.platform}:${group.screen}:${group.images.length}`),
    ['iOS:today-brief:1', 'iOS:mail-list:2', 'macOS:mac-today:1'],
  );
  assert.equal(manifest.images[3].path, 'images/macos/macos-mac-today-light.png');
  assert.deepEqual(manifest.counts, { total: 4, byPlatform: { iOS: 3, macOS: 1 } });
  assert.equal(manifest.artifact, artifactName);
  assert.equal(manifest.images[0].source, undefined);
});

test('counts blank frames and requests that no fixture covered', () => {
  const manifest = buildManifest([
    record({ blankWarning: true }),
    record({ file: 'b.png', uncovered: ['POST /api/tools/list_drafts', 'GET /api/prefs'] }),
  ]);
  assert.deepEqual(manifest.warnings, {
    blank: ['ios-mail-list-iphone-light.png'],
    uncoveredImages: 1,
    uncoveredRequests: 2,
  });
  const summary = summaryMarkdown(manifest);
  assert.match(summary, /Images: 2 \(iOS 2\)/);
  assert.match(summary, /Artifact: `native-tour`/);
  assert.match(summary, /Blank frames: 1 \(ios-mail-list-iphone-light.png\)/);
  assert.match(summary, /Requests with no fixture: 2 in 1 images/);
  assert.doesNotMatch(summary, /made no images/);
});

test('says so when the iOS tour made no images', () => {
  const summary = summaryMarkdown(buildManifest([record({ platform: 'macOS', file: 'm.png' })]));
  assert.match(summary, /The iOS tour made no images/);
});

test('renders captions, badges, and escaped text into the gallery', () => {
  const manifest = buildManifest([
    record({
      screenTitle: 'Mail <list>',
      captureMethod: 'layer.render',
      textSize: 'AX3 (accessibility extra large)',
      uncovered: ['GET /api/prefs'],
      notes: ['Drawn with layer.render.'],
    }),
  ]);
  const html = renderGallery(manifest);
  assert.match(html, /<h2>Mail &lt;list&gt;<\/h2>/);
  assert.match(html, /iPhone · compact width · portrait/);
  assert.match(html, /light · AX3 \(accessibility extra large\)/);
  assert.match(html, /class="badge">layer\.render/);
  assert.match(html, /1 unstubbed/);
  assert.match(html, /<li>Drawn with layer\.render\.<\/li>/);
  assert.match(html, /src="images\/ios\/ios-mail-list-iphone-light\.png"/);
  assert.equal(escapeHTML(`a"b'c&`), 'a&quot;b&#39;c&amp;');
});

test('collects only sidecars with an image and writes the gallery files', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'native-tour-'));
  try {
    const input = path.join(root, 'input');
    await writeTour(path.join(input, 'native-tour-ios-sha', 'ios'), [record({})]);
    await writeTour(path.join(input, 'native-tour-macos-sha', 'macos'), [
      record({ file: 'macos-mac-today-dark.png', platform: 'macOS', screen: 'mac-today' }),
    ]);
    await writeFile(
      path.join(input, 'native-tour-ios-sha', 'ios', 'orphan.json'),
      JSON.stringify(record({ file: 'x.png' })),
    );
    await writeFile(path.join(input, 'native-tour-ios-sha', 'ios', 'broken.json'), '{');

    const records = await collectRecords(input);
    assert.equal(records.length, 2);

    const output = path.join(root, 'output');
    const manifest = await buildGallery(input, output, { commit: 'abc' });
    assert.equal(manifest.counts.total, 2);
    const written = JSON.parse(await readFile(path.join(output, 'manifest.json'), 'utf8'));
    assert.equal(written.images.length, 2);
    assert.match(await readFile(path.join(output, 'index.html'), 'utf8'), /2 images \(iOS 1, macOS 1\)/);
    assert.ok((await stat(path.join(output, 'images', 'ios', 'ios-mail-list-iphone-light.png'))).isFile());
    assert.ok((await stat(path.join(output, 'images', 'macos', 'macos-mac-today-dark.png'))).isFile());
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
