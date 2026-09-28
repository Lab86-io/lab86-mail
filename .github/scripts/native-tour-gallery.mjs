#!/usr/bin/env node
// Builds one static gallery from the native screenshot tour. The iOS and
// macOS jobs each leave PNG files with JSON sidecars (TourRecord in
// apps/ios/Lab86MailTests/Tour/NativeTourSupport.swift). This script copies
// the images, writes manifest.json and index.html, and writes a short job
// summary.
//
// Usage: node native-tour-gallery.mjs <input directory> <output directory>
import { appendFile, copyFile, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const artifactName = 'native-tour';

/** Both jobs must leave images. A platform with none fails the gallery. */
export const expectedPlatforms = ['iOS', 'macOS'];

const platformOrder = expectedPlatforms;

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await walk(full)));
    else files.push(full);
  }
  return files;
}

/**
 * Reads every sidecar. A sidecar that does not parse, that has no `file` or
 * `platform`, or whose PNG is missing is a problem, not a silent omission:
 * the gallery lists it and the build fails.
 */
export async function collectRecords(inputDirectory) {
  const files = await walk(inputDirectory);
  const pngs = new Set(files.filter((file) => file.endsWith('.png')));
  const records = [];
  const problems = [];
  for (const file of files.filter((candidate) => candidate.endsWith('.json'))) {
    const name = path.relative(inputDirectory, file);
    let record;
    try {
      record = JSON.parse(await readFile(file, 'utf8'));
    } catch (error) {
      problems.push({ file: name, reason: `The JSON does not parse: ${error.message}` });
      continue;
    }
    if (typeof record?.file !== 'string' || typeof record?.platform !== 'string') {
      problems.push({ file: name, reason: 'The sidecar has no file or platform.' });
      continue;
    }
    const source = path.join(path.dirname(file), record.file);
    if (!pngs.has(source)) {
      problems.push({ file: name, reason: `The image ${record.file} is missing.` });
      continue;
    }
    records.push({ ...record, source });
  }
  problems.sort((a, b) => a.file.localeCompare(b.file));
  return { records, problems };
}

function platformRank(platform) {
  const index = platformOrder.indexOf(platform);
  return index === -1 ? platformOrder.length : index;
}

export function imagePath(record) {
  return `images/${record.platform.toLowerCase()}/${record.file}`;
}

/** Orders the images by platform, screen, and variant, and groups them by screen. */
export function buildManifest(records, meta = {}) {
  const images = [...records]
    .sort(
      (a, b) =>
        platformRank(a.platform) - platformRank(b.platform) ||
        (a.screenOrder ?? 0) - (b.screenOrder ?? 0) ||
        String(a.screen).localeCompare(String(b.screen)) ||
        (a.variantOrder ?? 0) - (b.variantOrder ?? 0),
    )
    .map(({ source: _source, ...record }) => ({
      ...record,
      path: imagePath(record),
      uncovered: record.uncovered ?? [],
      notes: record.notes ?? [],
    }));
  const screens = [];
  for (const image of images) {
    const key = `${image.platform}:${image.screen}`;
    let group = screens.find((candidate) => candidate.key === key);
    if (!group) {
      group = {
        key,
        platform: image.platform,
        screen: image.screen,
        title: image.screenTitle,
        section: image.section,
        images: [],
      };
      screens.push(group);
    }
    group.images.push(image);
  }
  const byPlatform = {};
  for (const image of images) byPlatform[image.platform] = (byPlatform[image.platform] ?? 0) + 1;
  return {
    generatedAt: meta.generatedAt ?? new Date().toISOString(),
    commit: meta.commit ?? null,
    runUrl: meta.runUrl ?? null,
    artifact: artifactName,
    counts: { total: images.length, byPlatform },
    warnings: {
      blank: images.filter((image) => image.blankWarning).map((image) => image.file),
      uncoveredImages: images.filter((image) => image.uncovered.length > 0).length,
      uncoveredRequests: images.reduce((sum, image) => sum + image.uncovered.length, 0),
      sidecarProblems: meta.problems ?? [],
      missingPlatforms: (meta.expectedPlatforms ?? expectedPlatforms).filter(
        (platform) => !byPlatform[platform],
      ),
    },
    screens: screens.map(({ key: _key, ...group }) => group),
    images,
  };
}

export function escapeHTML(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function anchor(group) {
  return `${group.platform}-${group.screen}`.toLowerCase().replace(/[^a-z0-9-]+/g, '-');
}

function caption(image) {
  const device = [image.device, image.sizeClass, image.orientation].filter(Boolean).join(' · ');
  const look = [image.appearance, image.textSize === 'default' ? 'default text' : image.textSize]
    .filter(Boolean)
    .join(' · ');
  const badges = [];
  if (image.blankWarning) badges.push('<span class="badge warn">Blank frame?</span>');
  if (image.captureMethod === 'layer.render') badges.push('<span class="badge">layer.render</span>');
  if (image.uncovered.length > 0) {
    const list = escapeHTML(image.uncovered.join('\n'));
    badges.push(`<span class="badge" title="${list}">${image.uncovered.length} unstubbed</span>`);
  }
  return `<figcaption>
        <span class="device">${escapeHTML(device)}</span>
        <span class="look">${escapeHTML(look)} · ${escapeHTML(`${image.width}×${image.height} pt`)}</span>
        ${badges.length > 0 ? `<span class="badges">${badges.join(' ')}</span>` : ''}
      </figcaption>`;
}

export function renderGallery(manifest) {
  const nav = manifest.screens
    .map(
      (group) =>
        `<a href="#${anchor(group)}"><span>${escapeHTML(group.platform)}</span> ${escapeHTML(group.title)}</a>`,
    )
    .join('\n      ');
  const sections = manifest.screens
    .map((group) => {
      const figures = group.images
        .map(
          (image) => `<figure>
      <a href="${escapeHTML(image.path)}"><img loading="lazy" src="${escapeHTML(image.path)}" alt="${escapeHTML(
        `${group.title}, ${image.device}, ${image.orientation}, ${image.appearance}`,
      )}"></a>
      ${caption(image)}
    </figure>`,
        )
        .join('\n    ');
      const notes = [...new Set(group.images.flatMap((image) => image.notes))]
        .map((note) => `<li>${escapeHTML(note)}</li>`)
        .join('');
      return `<section id="${anchor(group)}">
    <header>
      <p class="kicker">${escapeHTML(group.platform)} · ${escapeHTML(group.section)}</p>
      <h2>${escapeHTML(group.title)}</h2>
      <p class="id">${escapeHTML(group.screen)}</p>
      ${notes ? `<ul class="notes">${notes}</ul>` : ''}
    </header>
    <div class="grid">
    ${figures}
    </div>
  </section>`;
    })
    .join('\n  ');
  const platformCounts = Object.entries(manifest.counts.byPlatform)
    .map(([platform, count]) => `${escapeHTML(platform)} ${count}`)
    .join(', ');
  const commit = manifest.commit ? ` · commit <code>${escapeHTML(manifest.commit.slice(0, 12))}</code>` : '';
  const run = manifest.runUrl ? ` · <a href="${escapeHTML(manifest.runUrl)}">CI run</a>` : '';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Albatross native screenshot tour</title>
<style>
  :root { color-scheme: light dark; --paper: #f6f4ef; --ink: #1d1f22; --muted: #6b6f76; --card: #ffffff; --line: #e2ded5; --warn: #b3261e; }
  @media (prefers-color-scheme: dark) { :root { --paper: #141517; --ink: #ececec; --muted: #9a9ea6; --card: #1d1f22; --line: #2d3035; --warn: #ff8a80; } }
  * { box-sizing: border-box; }
  body { margin: 0; font: 15px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; background: var(--paper); color: var(--ink); }
  a { color: inherit; }
  .top { padding: 32px clamp(16px, 4vw, 48px) 16px; border-bottom: 1px solid var(--line); }
  .top h1 { margin: 0 0 6px; font: 600 28px/1.2 ui-serif, Georgia, serif; }
  .top p { margin: 0; color: var(--muted); }
  nav { display: flex; flex-wrap: wrap; gap: 6px; padding: 12px clamp(16px, 4vw, 48px); border-bottom: 1px solid var(--line); position: sticky; top: 0; background: var(--paper); z-index: 1; }
  nav a { text-decoration: none; font-size: 13px; padding: 4px 10px; border: 1px solid var(--line); border-radius: 999px; background: var(--card); }
  nav a span { color: var(--muted); }
  section { padding: 28px clamp(16px, 4vw, 48px) 8px; border-bottom: 1px solid var(--line); scroll-margin-top: 64px; }
  section header h2 { margin: 2px 0; font: 600 21px/1.25 ui-serif, Georgia, serif; }
  .kicker, .id { margin: 0; color: var(--muted); font-size: 12px; letter-spacing: 0.02em; }
  .notes { margin: 8px 0 0; padding-left: 18px; color: var(--muted); font-size: 13px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(230px, 1fr)); gap: 18px; margin: 18px 0 20px; align-items: start; }
  figure { margin: 0; background: var(--card); border: 1px solid var(--line); border-radius: 12px; overflow: hidden; }
  figure img { display: block; width: 100%; height: auto; background: repeating-conic-gradient(var(--line) 0% 25%, transparent 0% 50%) 50% / 16px 16px; }
  figcaption { display: grid; gap: 2px; padding: 8px 10px 10px; font-size: 12px; }
  .device { font-weight: 600; }
  .look { color: var(--muted); }
  .badges { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 4px; }
  .badge { font-size: 11px; padding: 1px 7px; border-radius: 999px; border: 1px solid var(--line); color: var(--muted); }
  .badge.warn { color: var(--warn); border-color: var(--warn); }
  .problems { margin: 8px 0 0; padding-left: 18px; color: var(--warn); }
</style>
</head>
<body>
<div class="top">
  <h1>Albatross native screenshot tour</h1>
  <p>${manifest.counts.total} images (${platformCounts})${commit}${run} · generated ${escapeHTML(manifest.generatedAt)}</p>
  <p>Blank frames: ${manifest.warnings.blank.length} · requests with no fixture: ${manifest.warnings.uncoveredRequests}</p>
  ${problemsHTML(manifest)}
</div>
<nav>
      ${nav}
</nav>
<main>
  ${sections}
</main>
</body>
</html>
`;
}

function problemsHTML(manifest) {
  const { sidecarProblems, missingPlatforms } = manifest.warnings;
  const items = [
    ...missingPlatforms.map((platform) => `No ${escapeHTML(platform)} images.`),
    ...sidecarProblems.map(
      (problem) => `<code>${escapeHTML(problem.file)}</code>: ${escapeHTML(problem.reason)}`,
    ),
  ];
  if (items.length === 0) return '';
  return `<ul class="problems">${items.map((item) => `<li>${item}</li>`).join('')}</ul>`;
}

/** Why the gallery must fail. An empty list means the gallery is complete. */
export function validationErrors(manifest) {
  return [
    ...manifest.warnings.missingPlatforms.map((platform) => `The ${platform} tour made no images.`),
    ...manifest.warnings.sidecarProblems.map((problem) => `${problem.file}: ${problem.reason}`),
  ];
}

export function summaryMarkdown(manifest) {
  const platforms = Object.entries(manifest.counts.byPlatform)
    .map(([platform, count]) => `${platform} ${count}`)
    .join(', ');
  const lines = [
    '### Native screenshot tour',
    '',
    `- Images: ${manifest.counts.total}${platforms ? ` (${platforms})` : ''}`,
    `- Artifact: \`${manifest.artifact}\` (open \`index.html\`)`,
    `- Blank frames: ${manifest.warnings.blank.length}${
      manifest.warnings.blank.length > 0 ? ` (${manifest.warnings.blank.join(', ')})` : ''
    }`,
    `- Requests with no fixture: ${manifest.warnings.uncoveredRequests} in ${manifest.warnings.uncoveredImages} images`,
  ];
  for (const platform of manifest.warnings.missingPlatforms) {
    lines.push(`- **The ${platform} tour made no images.**`);
  }
  const problems = manifest.warnings.sidecarProblems;
  if (problems.length > 0) {
    lines.push(`- **Sidecar problems: ${problems.length}**`);
    for (const problem of problems) lines.push(`  - \`${problem.file}\`: ${problem.reason}`);
  }
  return `${lines.join('\n')}\n`;
}

export async function buildGallery(inputDirectory, outputDirectory, meta = {}) {
  const { records, problems } = await collectRecords(inputDirectory);
  const manifest = buildManifest(records, { ...meta, problems });
  for (const record of records) {
    const target = path.join(outputDirectory, imagePath(record));
    await mkdir(path.dirname(target), { recursive: true });
    await copyFile(record.source, target);
  }
  await mkdir(outputDirectory, { recursive: true });
  await writeFile(path.join(outputDirectory, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  await writeFile(path.join(outputDirectory, 'index.html'), renderGallery(manifest));
  return manifest;
}

async function main([inputDirectory, outputDirectory]) {
  if (!inputDirectory || !outputDirectory) {
    console.error('Usage: node native-tour-gallery.mjs <input directory> <output directory>');
    process.exit(2);
  }
  const server = process.env.GITHUB_SERVER_URL;
  const repository = process.env.GITHUB_REPOSITORY;
  const runID = process.env.GITHUB_RUN_ID;
  const manifest = await buildGallery(inputDirectory, outputDirectory, {
    commit: process.env.TOUR_COMMIT ?? process.env.GITHUB_SHA ?? null,
    runUrl: server && repository && runID ? `${server}/${repository}/actions/runs/${runID}` : null,
  });
  const summary = summaryMarkdown(manifest);
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, summary);
  console.log(summary);
  // The gallery is already written, so the upload keeps the partial evidence.
  const errors = validationErrors(manifest);
  if (errors.length > 0) {
    for (const error of errors) console.error(error);
    process.exit(1);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main(process.argv.slice(2));
}
