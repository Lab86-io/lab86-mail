import { createPrivateKey, sign } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import { AppStoreConnectRequestError, requestAppStoreConnect } from './app-store-connect.mjs';
import {
  findAppStoreExport,
  findArchiveAction,
  findFailedAction,
  findTestFlightAction,
} from './xcode-cloud-artifacts.mjs';
import { preserveLogBundles } from './xcode-cloud-diagnostics.mjs';

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
  return requestAppStoreConnect(path, {
    getToken: createToken,
  });
}

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

const buildRunID = process.env.XCODE_CLOUD_BUILD_RUN_ID;
const deadline = Date.now() + 45 * 60 * 1000;
let run;
let actions = [];
let previousStatus = '';

while (Date.now() < deadline) {
  try {
    [run, { data: actions }] = await Promise.all([
      appStoreConnect(`/v1/ciBuildRuns/${buildRunID}`),
      appStoreConnect(`/v1/ciBuildRuns/${buildRunID}/actions`),
    ]);
  } catch (error) {
    if (!(error instanceof AppStoreConnectRequestError) || !error.recoverable) throw error;
    console.warn(`Transient App Store Connect polling failure: ${error.message}`);
    await sleep(20_000);
    continue;
  }

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
  const failedAction = findFailedAction(actions);
  if (failedAction) {
    try {
      const failedArtifacts = await appStoreConnect(`/v1/ciBuildActions/${failedAction.id}/artifacts`);
      await preserveLogBundles(failedArtifacts.data, {
        diagnosticsDirectory: process.env.XCODE_CLOUD_DIAGNOSTICS_DIR,
      });
    } catch (error) {
      console.warn(
        `Could not preserve diagnostics for failed Xcode Cloud action: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
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
  await preserveLogBundles(artifacts.data, {
    diagnosticsDirectory: process.env.XCODE_CLOUD_DIAGNOSTICS_DIR,
  });
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
