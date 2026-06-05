#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';

const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) {
  args.set(process.argv[i], process.argv[i + 1]);
}

const pkgPath = args.get('--package') || 'package.json';
const commitText = readOptional(args.get('--commits'));
const prText = readPrText(args.get('--prs'));
const bump = detectBump(`${commitText}\n${prText}`);
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
pkg.version = nextVersion(pkg.version || '0.8.0', bump);
writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
process.stdout.write(pkg.version);

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

function detectBump(text) {
  if (/\[MAJOR\]/i.test(text)) return 'major';
  if (/\[MINOR\]/i.test(text)) return 'minor';
  return 'patch';
}

function nextVersion(version, bump) {
  const [major = 0, minor = 0, patch = 0] = String(version)
    .replace(/^v/, '')
    .split('.')
    .map((part) => Number.parseInt(part, 10) || 0);
  if (bump === 'major') return `${major + 1}.0.0`;
  if (bump === 'minor') return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}
