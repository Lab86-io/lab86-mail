#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const versionPattern = /^\d+\.\d+\.\d+$/;

export function syncIOSVersion({
  version,
  configPath = 'apps/ios/Config/Base.xcconfig',
  read = readFileSync,
  write = writeFileSync,
} = {}) {
  if (!versionPattern.test(version ?? '')) {
    throw new Error(`Invalid iOS marketing version: ${version ?? ''}`);
  }

  const contents = read(configPath, 'utf8');
  const settingPattern = /^MARKETING_VERSION = .*$/gm;
  const settings = contents.match(settingPattern) ?? [];
  if (settings.length !== 1) {
    throw new Error(`Expected exactly one MARKETING_VERSION setting in ${configPath}.`);
  }

  const updated = contents.replace(settingPattern, `MARKETING_VERSION = ${version}`);
  write(configPath, updated);
  return version;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    syncIOSVersion({ version: process.argv[2] });
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
