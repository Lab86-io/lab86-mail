import { createPrivateKey, sign } from 'node:crypto';

const requiredEnvironment = [
  'ASC_ISSUER_ID',
  'ASC_KEY_ID',
  'ASC_PRIVATE_KEY',
  'APP_STORE_APP_ID',
  'TESTFLIGHT_GROUP_ID',
  'BUILD_NUMBER',
];

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

async function appStoreConnect(path, options = {}) {
  const response = await fetch(`https://api.appstoreconnect.apple.com${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${createToken()}`,
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });
  const text = await response.text();
  const body = text ? JSON.parse(text) : {};
  if (!response.ok) {
    throw new Error(`App Store Connect request failed (${response.status}): ${JSON.stringify(body)}`);
  }
  return body;
}

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const deadline = Date.now() + 30 * 60 * 1000;
let build;

while (Date.now() < deadline) {
  const query = new URLSearchParams({
    'filter[app]': process.env.APP_STORE_APP_ID,
    'filter[version]': process.env.BUILD_NUMBER,
    limit: '10',
  });
  const response = await appStoreConnect(`/v1/builds?${query}`);
  build = response.data[0];

  if (!build) {
    console.log(`Waiting for TestFlight to register build ${process.env.BUILD_NUMBER}...`);
  } else {
    const state = build.attributes.processingState;
    console.log(`TestFlight build ${process.env.BUILD_NUMBER}: ${state}`);
    if (state === 'VALID') break;
    if (state === 'INVALID' || state === 'FAILED') {
      throw new Error(`TestFlight processing ended in state ${state}.`);
    }
  }
  await sleep(30_000);
}

if (!build || build.attributes.processingState !== 'VALID') {
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
