import { createPrivateKey, sign } from "node:crypto";

const requiredEnvironment = [
  "ASC_ISSUER_ID",
  "ASC_KEY_ID",
  "ASC_PRIVATE_KEY",
  "XCODE_CLOUD_WORKFLOW_ID",
  "XCODE_CLOUD_BRANCH_REF_ID",
];

for (const name of requiredEnvironment) {
  if (!process.env[name]) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
}

const encodeJSON = (value) =>
  Buffer.from(JSON.stringify(value)).toString("base64url");

const now = Math.floor(Date.now() / 1000);
const unsignedToken = [
  encodeJSON({ alg: "ES256", kid: process.env.ASC_KEY_ID, typ: "JWT" }),
  encodeJSON({
    iss: process.env.ASC_ISSUER_ID,
    iat: now - 10,
    exp: now + 600,
    aud: "appstoreconnect-v1",
  }),
].join(".");

const privateKey = process.env.ASC_PRIVATE_KEY.replaceAll("\\n", "\n").trim();
const signature = sign("sha256", Buffer.from(unsignedToken), {
  key: createPrivateKey(`${privateKey}\n`),
  dsaEncoding: "ieee-p1363",
}).toString("base64url");
const token = `${unsignedToken}.${signature}`;

const response = await fetch(
  "https://api.appstoreconnect.apple.com/v1/ciBuildRuns",
  {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      data: {
        type: "ciBuildRuns",
        attributes: {},
        relationships: {
          workflow: {
            data: {
              type: "ciWorkflows",
              id: process.env.XCODE_CLOUD_WORKFLOW_ID,
            },
          },
          sourceBranchOrTag: {
            data: {
              type: "scmGitReferences",
              id: process.env.XCODE_CLOUD_BRANCH_REF_ID,
            },
          },
        },
      },
    }),
  },
);

const responseBody = await response.text();
if (!response.ok) {
  throw new Error(
    `App Store Connect rejected the Xcode Cloud build (${response.status}): ${responseBody}`,
  );
}

const buildRun = JSON.parse(responseBody).data;
console.log(
  `Started Xcode Cloud build #${buildRun.attributes.number} (${buildRun.id}) on staging.`,
);
