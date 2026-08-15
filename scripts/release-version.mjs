#!/usr/bin/env node
// Chooses the next release version and writes it to package.json.
//
// The bump is a judgement about what a batch of work actually did, so it is
// stated rather than inferred wherever possible. In descending precedence:
//
//   --set 1.2.3            an exact version, for a deliberate local release
//   --bump minor           an explicit level, for a deliberate local release
//   Release-As: 1.2.3      a trailer in the promotion commit or PR body
//   Release-Bump: minor    the same, as a level
//   [MAJOR] / [MINOR]      the original markers, still honoured
//   patch                  the default when a batch says nothing about itself
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const VERSION_PATTERN = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;
const CLI_OPTIONS = new Set(['--package', '--commits', '--prs', '--bump', '--set']);
export const BUMP_LEVELS = ['major', 'minor', 'patch'];

export function detectBump(text) {
  const trailer = /^\s*Release-Bump:\s*(\S+)\s*$/im.exec(text ?? '');
  if (trailer) return trailer[1].toLowerCase();
  if (/\[MAJOR\]/i.test(text ?? '')) return 'major';
  if (/\[MINOR\]/i.test(text ?? '')) return 'minor';
  return 'patch';
}

export function detectExplicitVersion(text) {
  const trailer = /^\s*Release-As:\s*v?(\d+\.\d+\.\d+)\s*$/im.exec(text ?? '');
  return trailer ? trailer[1] : null;
}

export function nextVersion(version, bump) {
  const [major = 0, minor = 0, patch = 0] = String(version)
    .replace(/^v/, '')
    .split('.')
    .map((part) => Number.parseInt(part, 10) || 0);
  if (bump === 'major') return `${major + 1}.0.0`;
  if (bump === 'minor') return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

export function resolveVersion({ current, text = '', bump = null, set = null }) {
  const explicit = set ?? detectExplicitVersion(text);
  if (explicit !== null) {
    if (!VERSION_PATTERN.test(explicit)) {
      throw new Error(`Not a release version: ${explicit}`);
    }
    // A stated version that would move backwards is a mistake worth stopping
    // for: App Store Connect will reject it and the tag would be wrong.
    if (compareVersions(explicit, current) <= 0) {
      throw new Error(`Requested version ${explicit} does not advance ${current}.`);
    }
    return explicit;
  }
  const level = bump ?? detectBump(text);
  if (!BUMP_LEVELS.includes(level)) {
    throw new Error(`Not a bump level: ${level}. Expected one of ${BUMP_LEVELS.join(', ')}.`);
  }
  return nextVersion(current, level);
}

export function parseArguments(argv) {
  const args = new Map();
  for (let i = 2; i < argv.length; i += 2) {
    const option = argv[i];
    const value = argv[i + 1];
    if (!CLI_OPTIONS.has(option)) {
      throw new Error(`Unknown option: ${option}.`);
    }
    if (value === undefined) {
      throw new Error(`Missing value for ${option}.`);
    }
    args.set(option, value);
  }
  return args;
}

export function compareVersions(left, right) {
  const parse = (value) =>
    String(value)
      .replace(/^v/, '')
      .split('.')
      .map((part) => Number.parseInt(part, 10) || 0);
  const [leftMajor, leftMinor, leftPatch] = parse(left);
  const [rightMajor, rightMinor, rightPatch] = parse(right);
  return leftMajor - rightMajor || leftMinor - rightMinor || leftPatch - rightPatch;
}

function readOptional(path) {
  if (!path) return '';
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
}

function readPrText(path) {
  if (!path) return '';
  try {
    const prs = JSON.parse(readFileSync(path, 'utf8'));
    return Array.isArray(prs) ? prs.map((pr) => `${pr.title || ''}\n${pr.body || ''}`).join('\n') : '';
  } catch {
    return '';
  }
}

function main(argv) {
  const args = parseArguments(argv);

  const pkgPath = args.get('--package') || 'package.json';
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  const version = resolveVersion({
    current: pkg.version || '0.8.0',
    text: `${readOptional(args.get('--commits'))}\n${readPrText(args.get('--prs'))}`,
    bump: args.get('--bump') ?? null,
    set: args.get('--set') ?? null,
  });

  pkg.version = version;
  writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
  process.stdout.write(version);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main(process.argv);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
