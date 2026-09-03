import {
  AppStoreConnectRequestError,
  createAppStoreConnectToken,
  requestAppStoreConnect,
} from './app-store-connect.mjs';
import { selectVerifiedBuild } from './testflight-build.mjs';

const requiredEnvironment = [
  'ASC_ISSUER_ID',
  'ASC_KEY_ID',
  'ASC_PRIVATE_KEY',
  'APP_STORE_APP_ID',
  'TESTFLIGHT_GROUP_ID',
  'BUILD_NUMBER',
  // Provenance: the build must be this release's, not merely this number's.
  'EXPECTED_MARKETING_VERSION',
  'BUILD_NOT_BEFORE',
];

for (const name of requiredEnvironment) {
  if (!process.env[name]) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
}

function createToken() {
  return createAppStoreConnectToken({
    issuerID: process.env.ASC_ISSUER_ID,
    keyID: process.env.ASC_KEY_ID,
    privateKey: process.env.ASC_PRIVATE_KEY,
  });
}

async function appStoreConnect(path, options = {}) {
  return requestAppStoreConnect(path, {
    getToken: createToken,
    options,
    maxAttempts: options.method === 'POST' ? 1 : 4,
  });
}

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const deadline = Date.now() + 30 * 60 * 1000;
let build;

while (Date.now() < deadline) {
  const query = new URLSearchParams({
    'filter[app]': process.env.APP_STORE_APP_ID,
    'filter[version]': process.env.BUILD_NUMBER,
    include: 'preReleaseVersion',
    sort: '-uploadedDate',
    limit: '10',
  });
  let response;
  try {
    response = await appStoreConnect(`/v1/builds?${query}`);
  } catch (error) {
    if (!(error instanceof AppStoreConnectRequestError) || !error.recoverable) throw error;
    console.warn(`Transient TestFlight polling failure: ${error.message}`);
    await sleep(30_000);
    continue;
  }
  const verified = selectVerifiedBuild({
    builds: response.data,
    included: response.included,
    buildNumber: process.env.BUILD_NUMBER,
    marketingVersion: process.env.EXPECTED_MARKETING_VERSION,
    notBefore: process.env.BUILD_NOT_BEFORE,
  });
  if (verified.reason) {
    // The number exists but it is not our build: a duplicate-upload rejection
    // earlier in the run was masking a release that never shipped.
    throw new Error(
      `TestFlight holds a build ${process.env.BUILD_NUMBER} that is not this release's: ${verified.reason}.`,
    );
  }
  build = verified.build;

  if (!build) {
    console.log(`Waiting for TestFlight to register build ${process.env.BUILD_NUMBER}...`);
  } else {
    const state = build.processingState;
    console.log(
      `TestFlight build ${process.env.BUILD_NUMBER} (${build.marketingVersion}, uploaded ${build.uploadedAt.toISOString()}): ${state}`,
    );
    if (state === 'VALID') break;
    if (state === 'INVALID' || state === 'FAILED') {
      throw new Error(`TestFlight processing ended in state ${state}.`);
    }
  }
  await sleep(30_000);
}

if (!build || build.processingState !== 'VALID') {
  throw new Error('Timed out waiting for TestFlight processing.');
}

await appStoreConnect(`/v1/betaGroups/${process.env.TESTFLIGHT_GROUP_ID}/relationships/builds`, {
  method: 'POST',
  body: JSON.stringify({
    data: [{ type: 'builds', id: build.id }],
  }),
});

console.log(
  `TestFlight build ${process.env.BUILD_NUMBER} is valid and assigned to the internal testing group.`,
);
