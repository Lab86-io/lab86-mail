import { createPrivateKey, sign } from 'node:crypto';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import {
  findAppStoreExport,
  findArchiveAction,
  findLogBundles,
  findTestFlightAction,
} from './xcode-cloud-artifacts.mjs';

const requiredEnvironment = ['ASC_ISSUER_ID', 'ASC_KEY_ID', 'ASC_PRIVATE_KEY', 'XCODE_CLOUD_BUILD_RUN_ID'];

for (const name of requiredEnvironment) {
  if (!process.env[name]) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
}

const encodeJSON = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');

const privateKey = process.env.ASC_PRIVATE_KEY.replaceAll('\\n', '\n').trim();

function createToken() {
  const now = Math.floor(Date.now() / 1000);
  const unsignedToken = [
    encodeJSON({ alg: 'ES256', kid: process.env.ASC_KEY_ID, typ: 'JWT' }),
    encodeJSON({
      iss: process.env.ASC_ISSUER_ID,
      iat: now - 10,
      exp: now + 600,
      aud: 'appstoreconnect-v1',
    }),
  ].join('.');
  const signature = sign('sha256', Buffer.from(unsignedToken), {
    key: createPrivateKey(`${privateKey}\n`),
    dsaEncoding: 'ieee-p1363',
  }).toString('base64url');
  return `${unsignedToken}.${signature}`;
}

async function appStoreConnect(path) {
  const response = await fetch(`https://api.appstoreconnect.apple.com${path}`, {
    headers: { Authorization: `Bearer ${createToken()}` },
  });
  const body = await response.json();
  if (!response.ok) {
    throw new Error(`App Store Connect request failed (${response.status}): ${JSON.stringify(body)}`);
  }
  return body;
}

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function preserveLogBundles(artifacts) {
  const diagnosticsDirectory = process.env.XCODE_CLOUD_DIAGNOSTICS_DIR;
  if (!diagnosticsDirectory) return;

  const logBundles = findLogBundles(artifacts);
  if (logBundles.length === 0) {
    console.warn('Xcode Cloud returned no downloadable log bundle for the failed archive.');
    return;
  }

  mkdirSync(diagnosticsDirectory, { recursive: true });
  for (const { attributes } of logBundles) {
    try {
      const response = await fetch(attributes.downloadUrl);
      if (!response.ok) {
        console.warn(
          `Could not download Xcode Cloud log bundle ${attributes.fileName} (${response.status}).`,
        );
        continue;
      }
      const fileName = basename(attributes.fileName || 'xcode-cloud.logbundle.zip');
      writeFileSync(join(diagnosticsDirectory, fileName), Buffer.from(await response.arrayBuffer()));
      console.log(`Preserved Xcode Cloud diagnostic log bundle: ${fileName}`);
    } catch (error) {
      console.warn(
        `Could not preserve Xcode Cloud log bundle ${attributes.fileName}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}

const buildRunID = process.env.XCODE_CLOUD_BUILD_RUN_ID;
const deadline = Date.now() + 45 * 60 * 1000;
let run;
let actions = [];
let previousStatus = '';

while (Date.now() < deadline) {
  [run, { data: actions }] = await Promise.all([
    appStoreConnect(`/v1/ciBuildRuns/${buildRunID}`),
    appStoreConnect(`/v1/ciBuildRuns/${buildRunID}/actions`),
  ]);

  const actionStatus = actions
    .map(
      ({ attributes }) =>
        `${attributes.name}: ${attributes.executionProgress}/${attributes.completionStatus ?? 'pending'}`,
    )
    .join(', ');
  const status = `${run.data.attributes.executionProgress}/${run.data.attributes.completionStatus ?? 'pending'}; ${actionStatus}`;
  if (status !== previousStatus) {
    console.log(`Xcode Cloud build #${run.data.attributes.number}: ${status}`);
    previousStatus = status;
  }

  if (run.data.attributes.executionProgress === 'COMPLETE') break;
  await sleep(20_000);
}

if (!run || run.data.attributes.executionProgress !== 'COMPLETE') {
  throw new Error('Timed out waiting for Xcode Cloud to finish.');
}

const testFlightAction = findTestFlightAction(actions);
const testFlightSucceeded = testFlightAction?.attributes.completionStatus === 'SUCCEEDED';
const archiveAction = findArchiveAction(actions);
if (!archiveAction) {
  throw new Error('Xcode Cloud did not return an archive action.');
}

const artifacts = await appStoreConnect(`/v1/ciBuildActions/${archiveAction.id}/artifacts`);
const appStoreExport = findAppStoreExport(artifacts.data);

if (testFlightSucceeded) {
  if (!appStoreExport) {
    throw new Error('Xcode Cloud distributed to TestFlight without a reviewable App Store export.');
  }
  console.log('Xcode Cloud distributed the build to TestFlight directly.');
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      `needs_upload=false\nartifact_url=${appStoreExport.attributes.downloadUrl}\n`,
    );
  }
  process.exit(0);
}

if (!appStoreExport) {
  await preserveLogBundles(artifacts.data);
  const issues = await appStoreConnect(`/v1/ciBuildActions/${archiveAction.id}/issues`);
  const messages = issues.data.map(({ attributes }) => attributes.message);
  throw new Error(`Xcode Cloud did not produce an App Store export. ${messages.join('; ')}`);
}

console.log(
  "Xcode Cloud produced a signed App Store export; GitHub will upload it because Apple's Xcode Cloud TestFlight handoff did not complete.",
);
if (process.env.GITHUB_OUTPUT) {
  appendFileSync(
    process.env.GITHUB_OUTPUT,
    `needs_upload=true\nartifact_url=${appStoreExport.attributes.downloadUrl}\n`,
  );
}
