import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const requiredEnvironment = [
  'ASC_ISSUER_ID',
  'ASC_KEY_ID',
  'ASC_PRIVATE_KEY',
  'BUILD_NUMBER',
  'IPA_PATH',
  'RUNNER_TEMP',
];

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function classifyUploadResult({ status, output, buildNumber }) {
  if (status === 0) {
    return 'uploaded';
  }

  const escapedBuildNumber = escapeRegExp(buildNumber);
  const isDuplicate = /ENTITY_ERROR\.ATTRIBUTE\.INVALID\.DUPLICATE/.test(output);
  const namesSamePreviousVersion = new RegExp(
    String.raw`(?:previousBundleVersion\s*[:=]\s*["'‘’]?|bundle version must be higher than the previously uploaded version:\s*["'‘’]?)${escapedBuildNumber}(?:\b|["'‘’])`,
    'i',
  ).test(output);

  return isDuplicate && namesSamePreviousVersion ? 'already-uploaded' : 'failed';
}

export function uploadIOSExport({
  env = process.env,
  run = spawnSync,
  write = writeFileSync,
  makeDirectory = mkdirSync,
  chmod = chmodSync,
  remove = unlinkSync,
  stdout = process.stdout,
  stderr = process.stderr,
} = {}) {
  for (const name of requiredEnvironment) {
    if (!env[name]) {
      throw new Error(`Missing required environment variable: ${name}`);
    }
  }

  const privateKeysDirectory = join(env.RUNNER_TEMP, 'app-store-connect-private-keys');
  const privateKeyPath = join(privateKeysDirectory, `AuthKey_${env.ASC_KEY_ID}.p8`);
  makeDirectory(privateKeysDirectory, { recursive: true });
  write(privateKeyPath, `${env.ASC_PRIVATE_KEY.replace(/\s+$/, '')}\n`, { mode: 0o600 });
  chmod(privateKeyPath, 0o600);

  try {
    const result = run(
      'xcrun',
      [
        'altool',
        '--upload-app',
        '--type',
        'ios',
        '--file',
        env.IPA_PATH,
        '--apiKey',
        env.ASC_KEY_ID,
        '--apiIssuer',
        env.ASC_ISSUER_ID,
        '--output-format',
        'json',
      ],
      {
        encoding: 'utf8',
        env: { ...env, API_PRIVATE_KEYS_DIR: privateKeysDirectory },
        maxBuffer: 10 * 1024 * 1024,
      },
    );

    if (result.stdout) stdout.write(result.stdout);
    if (result.stderr) stderr.write(result.stderr);
    if (result.error) throw result.error;

    const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
    const classification = classifyUploadResult({
      status: result.status,
      output,
      buildNumber: env.BUILD_NUMBER,
    });
    if (classification === 'already-uploaded') {
      stdout.write(
        `App Store Connect already accepted build ${env.BUILD_NUMBER}; continuing to TestFlight verification.\n`,
      );
      return classification;
    }
    if (classification === 'failed') {
      throw new Error(`App Store Connect upload failed with exit code ${result.status ?? 'unknown'}.`);
    }
    return classification;
  } finally {
    try {
      remove(privateKeyPath);
    } catch {
      // The hosted runner is ephemeral; failure to remove an absent key is harmless.
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    uploadIOSExport();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
