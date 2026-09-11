/**
 * Copies the runtime assets of the pinned @odoo/o-spreadsheet release into
 * public/vendor so the browser can load them without a bundler loader, and
 * derives the scoped Bootstrap utility subset the engine's templates rely on.
 *
 * Run after changing the pinned version:  bun scripts/sync-odoo-spreadsheet-assets.mjs
 * The test in tests/odoo-spreadsheet-assets.test.ts verifies the copies match
 * node_modules byte for byte, so a version bump cannot silently drift.
 */
import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import postcss from 'postcss';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(
  await readFile(resolve(root, 'node_modules/@odoo/o-spreadsheet/package.json'), 'utf8'),
);
const version = pkg.version;
const source = resolve(root, 'node_modules/@odoo/o-spreadsheet');
const target = resolve(root, 'public/vendor/o-spreadsheet', version);
const fontAwesomeTarget = resolve(root, 'public/vendor/font-awesome-4.7.0');
const owlVersion = '2.8.2';
const owlTarget = resolve(root, 'public/vendor/owl', owlVersion);
const sourcePins = {
  spreadsheet: { commit: 'e4992587245f832c0dbf361b1f23f14b74613d4e', repository: 'odoo/o-spreadsheet' },
  owl: { commit: '54129a5f8dfc1ce16c62ee2f216058c043043a6e', repository: 'odoo/owl' },
};

export const ODOO_SPREADSHEET_VENDOR_FILES = [
  'dist/o_spreadsheet.xml',
  'dist/o_spreadsheet.css',
  'LICENSE',
  'readme.md',
];

/** Tokens that may be Bootstrap utility class names, harvested from the engine. */
function harvestClassTokens(text) {
  const tokens = new Set();
  for (const match of text.matchAll(/[a-z][a-z0-9]*(?:-[a-z0-9]+)*/g)) tokens.add(match[0]);
  return tokens;
}

/**
 * Keep only Bootstrap rules whose every class is used by the engine, then scope
 * them under the Albatross frame so they never leak into the rest of the app.
 */
export function scopedBootstrapSubset(bootstrapCss, usedTokens, scope) {
  const bootstrap = postcss.parse(bootstrapCss);
  const output = postcss.root();
  const keepSelector = (selector) => {
    const classes = [...selector.matchAll(/\.([a-zA-Z][\w-]*)/g)].map((match) => match[1]);
    if (!classes.length) return false;
    return classes.every((name) => usedTokens.has(name));
  };
  const scopeSelector = (selector) => `${scope} ${selector.trim()}`;
  const visit = (node, container) => {
    if (node.type === 'rule') {
      if (node.selector === ':root' || node.selector === ':root, [data-bs-theme=light]') {
        const clone = node.clone({ selector: scope });
        container.append(clone);
        return;
      }
      const selectors = node.selectors.filter(keepSelector);
      if (!selectors.length) return;
      container.append(node.clone({ selectors: selectors.map(scopeSelector) }));
      return;
    }
    if (node.type === 'atrule' && node.name === 'media') {
      const clone = node.clone({ nodes: [] });
      for (const child of node.nodes || []) visit(child, clone);
      if (clone.nodes.length) container.append(clone);
    }
  };
  for (const node of bootstrap.nodes) visit(node, output);
  return output.toString();
}

async function main() {
  await mkdir(resolve(target, 'dist'), { recursive: true });
  await mkdir(resolve(owlTarget, 'dist'), { recursive: true });
  await mkdir(resolve(fontAwesomeTarget, 'css'), { recursive: true });
  await mkdir(resolve(fontAwesomeTarget, 'fonts'), { recursive: true });
  for (const relative of ODOO_SPREADSHEET_VENDOR_FILES) {
    await copyFile(resolve(source, relative), resolve(target, relative));
  }
  const copyright = await fetchCopyright();
  if (copyright) await writeFile(resolve(target, 'COPYRIGHT'), copyright);
  await copyFile(
    resolve(root, 'node_modules/font-awesome/css/font-awesome.css'),
    resolve(fontAwesomeTarget, 'css/font-awesome.css'),
  );
  await copyFile(
    resolve(root, 'node_modules/font-awesome/fonts/fontawesome-webfont.woff2'),
    resolve(fontAwesomeTarget, 'fonts/fontawesome-webfont.woff2'),
  );
  await copyFile(
    resolve(root, 'node_modules/font-awesome/fonts/fontawesome-webfont.woff'),
    resolve(fontAwesomeTarget, 'fonts/fontawesome-webfont.woff'),
  );
  await copyFile(
    resolve(root, 'node_modules/font-awesome/README.md'),
    resolve(fontAwesomeTarget, 'README.md'),
  );
  const fontLicenseFile = resolve(fontAwesomeTarget, 'LICENSES.txt');
  try {
    await readFile(fontLicenseFile);
  } catch {
    const response = await fetch('https://openfontlicense.org/documents/OFL.txt');
    if (!response.ok) throw new Error('Could not obtain the official Open Font License text.');
    const template = await response.text();
    const start = template.indexOf('SIL OPEN FONT LICENSE Version 1.1');
    if (start < 0) throw new Error('Unexpected Open Font License text.');
    const svg = await readFile(
      resolve(root, 'node_modules/font-awesome/fonts/fontawesome-webfont.svg'),
      'utf8',
    );
    const copyright = svg.match(/Copyright Dave Gandy[^\n]+/)?.[0];
    if (!copyright) throw new Error('Font Awesome copyright notice is missing.');
    const bootstrapLicense = await readFile(resolve(root, 'node_modules/bootstrap/LICENSE'), 'utf8');
    const mitStart = bootstrapLicense.indexOf('Permission is hereby granted');
    if (mitStart < 0) throw new Error('MIT license text is missing.');
    await writeFile(
      fontLicenseFile,
      `Font Awesome 4.7.0\n${copyright}\n\nFont software: SIL Open Font License 1.1.\nCSS: MIT License.\nOriginal license declaration: README.md, https://fontawesome.io/license/\nThe font and CSS files are unmodified.\n\n${template.slice(start)}\n\nMIT License (CSS)\n\n${copyright}\n\n${bootstrapLicense.slice(mitStart)}`,
    );
  }
  const templates = await readFile(resolve(source, 'dist/o_spreadsheet.xml'), 'utf8');
  const engine = await readFile(resolve(source, 'dist/o_spreadsheet.esm.js'), 'utf8');
  if (version !== '19.0.50')
    throw new Error('Update and verify the pinned corresponding source before changing the engine release.');
  const owlPackage = JSON.parse(await readFile(resolve(root, 'node_modules/@odoo/owl/package.json'), 'utf8'));
  if (owlPackage.version !== owlVersion) throw new Error('Owl runtime/source pin mismatch.');
  if (engine.split('from "@odoo/owl"').length !== 2) throw new Error('Expected exactly one Owl ESM import.');
  await writeFile(
    resolve(target, 'dist/o_spreadsheet.esm.js'),
    engine.replace('from "@odoo/owl"', `from "/vendor/owl/${owlVersion}/dist/owl.es.js"`),
  );
  for (const path of ['dist/owl.es.js', 'LICENSE', 'README.md'])
    await copyFile(resolve(root, 'node_modules/@odoo/owl', path), resolve(owlTarget, path));
  await copyFile(resolve(root, 'node_modules/bootstrap/LICENSE'), resolve(target, 'BOOTSTRAP-LICENSE'));
  const sources = {};
  for (const [name, pin] of Object.entries(sourcePins)) {
    const location = resolve(name === 'spreadsheet' ? target : owlTarget, 'source.tar.gz');
    let bytes;
    try {
      bytes = await readFile(location);
    } catch {
      const response = await fetch(`https://codeload.github.com/${pin.repository}/tar.gz/${pin.commit}`);
      if (!response.ok) throw new Error(`Could not obtain pinned ${name} source: ${response.status}`);
      bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length > 60 * 1024 * 1024) throw new Error('Unexpected source archive size.');
      await writeFile(location, bytes);
    }
    sources[name] = {
      ...pin,
      archive: name === 'spreadsheet' ? 'source.tar.gz' : `/vendor/owl/${owlVersion}/source.tar.gz`,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    };
  }
  const used = harvestClassTokens(`${templates}\n${engine}`);
  const bootstrap = await readFile(resolve(root, 'node_modules/bootstrap/dist/css/bootstrap.css'), 'utf8');
  const bootstrapVersion = JSON.parse(
    await readFile(resolve(root, 'node_modules/bootstrap/package.json'), 'utf8'),
  ).version;
  const subset = scopedBootstrapSubset(bootstrap, used, '.albatross-sheet-frame');
  await writeFile(
    resolve(target, 'dist/bootstrap-subset.css'),
    `/* Derived from Bootstrap ${bootstrapVersion} (MIT). Only the utility rules used by o-spreadsheet ${version}, scoped to .albatross-sheet-frame. Generated by scripts/sync-odoo-spreadsheet-assets.mjs; do not edit. */\n${subset}`,
  );
  const manifest = {
    package: pkg.name,
    version,
    license: pkg.license,
    repository: pkg.repository?.url,
    tarball: `https://registry.npmjs.org/@odoo/o-spreadsheet/-/o-spreadsheet-${version}.tgz`,
    bootstrapVersion,
    owlVersion,
    sources,
    modifications: [
      'The engine ESM Owl import is rewritten to the pinned same-origin vendor URL; no engine logic changes.',
    ],
    files: Object.fromEntries(
      await Promise.all(
        [
          ...ODOO_SPREADSHEET_VENDOR_FILES,
          'dist/bootstrap-subset.css',
          'dist/o_spreadsheet.esm.js',
          'BOOTSTRAP-LICENSE',
          'source.tar.gz',
        ].map(async (relative) => [
          relative,
          createHash('sha256')
            .update(await readFile(resolve(target, relative)))
            .digest('hex'),
        ]),
      ),
    ),
  };
  await writeFile(resolve(target, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`Synced @odoo/o-spreadsheet ${version} assets into ${target}`);
}

async function fetchCopyright() {
  const local = resolve(root, 'public/vendor/o-spreadsheet', version, 'COPYRIGHT');
  try {
    return await readFile(local, 'utf8');
  } catch {}
  try {
    const response = await fetch(
      `https://raw.githubusercontent.com/odoo/o-spreadsheet/${version.split('.').slice(0, 2).join('.')}/COPYRIGHT`,
    );
    return response.ok ? await response.text() : null;
  } catch {
    return null;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
