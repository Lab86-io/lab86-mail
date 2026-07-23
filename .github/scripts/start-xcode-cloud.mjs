import { createPrivateKey, sign } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export function selectWorkflowID(workflows, workflowName) {
  const workflow = workflows.find(({ attributes }) => attributes.name === workflowName);
  if (!workflow) {
    throw new Error(`Xcode Cloud workflow "${workflowName}" was not found.`);
  }
  return workflow.id;
}

export function selectBranchRefID(references, branchName) {
  const branch = references.find(
    ({ attributes }) =>
      attributes.name === branchName || attributes.canonicalName === `refs/heads/${branchName}`,
  );
  if (!branch) {
    throw new Error(`Xcode Cloud branch "${branchName}" was not found.`);
  }
  return branch.id;
}

export function createBuildRunPayload(workflowID, branchRefID) {
  return {
    data: {
      type: 'ciBuildRuns',
      attributes: {},
      relationships: {
        workflow: {
          data: {
            type: 'ciWorkflows',
            id: workflowID,
          },
        },
        sourceBranchOrTag: {
          data: {
            type: 'scmGitReferences',
            id: branchRefID,
          },
        },
      },
    },
  };
}

export async function main() {
  const requiredEnvironment = ['ASC_ISSUER_ID', 'ASC_KEY_ID', 'ASC_PRIVATE_KEY'];
  for (const name of requiredEnvironment) {
    if (!process.env[name]) {
      throw new Error(`Missing required environment variable: ${name}`);
    }
  }

  const encodeJSON = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');

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

  const privateKey = process.env.ASC_PRIVATE_KEY.replaceAll('\\n', '\n').trim();
  const signature = sign('sha256', Buffer.from(unsignedToken), {
    key: createPrivateKey(`${privateKey}\n`),
    dsaEncoding: 'ieee-p1363',
  }).toString('base64url');
  const token = `${unsignedToken}.${signature}`;

  async function appStoreConnect(path) {
    const response = await fetch(`https://api.appstoreconnect.apple.com${path}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const responseBody = await response.text();
    if (!response.ok) {
      throw new Error(`App Store Connect request failed (${response.status}): ${responseBody}`);
    }
    return JSON.parse(responseBody);
  }

  let workflowID = process.env.XCODE_CLOUD_WORKFLOW_ID;
  let branchRefID = process.env.XCODE_CLOUD_BRANCH_REF_ID;

  if (!workflowID || !branchRefID) {
    for (const name of ['APP_STORE_APP_ID', 'XCODE_CLOUD_WORKFLOW_NAME', 'XCODE_CLOUD_BRANCH_NAME']) {
      if (!process.env[name]) {
        throw new Error(
          `Missing ${name}; provide discovery names or explicit XCODE_CLOUD_WORKFLOW_ID and XCODE_CLOUD_BRANCH_REF_ID.`,
        );
      }
    }

    const product = await appStoreConnect(`/v1/apps/${process.env.APP_STORE_APP_ID}/ciProduct`);
    const workflows = await appStoreConnect(`/v1/ciProducts/${product.data.id}/workflows?limit=200`);
    workflowID = selectWorkflowID(workflows.data, process.env.XCODE_CLOUD_WORKFLOW_NAME);

    const repository = await appStoreConnect(`/v1/ciWorkflows/${workflowID}/repository`);
    const references = await appStoreConnect(
      `/v1/scmRepositories/${repository.data.id}/gitReferences?limit=200`,
    );
    branchRefID = selectBranchRefID(references.data, process.env.XCODE_CLOUD_BRANCH_NAME);
  }

  const response = await fetch('https://api.appstoreconnect.apple.com/v1/ciBuildRuns', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(createBuildRunPayload(workflowID, branchRefID)),
  });

  const responseBody = await response.text();
  if (!response.ok) {
    throw new Error(`App Store Connect rejected the Xcode Cloud build (${response.status}): ${responseBody}`);
  }

  const buildRun = JSON.parse(responseBody).data;
  console.log(
    `Started Xcode Cloud build #${buildRun.attributes.number} (${buildRun.id}) on ${
      process.env.XCODE_CLOUD_BRANCH_NAME || 'the configured branch'
    }.`,
  );

  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      `build_run_id=${buildRun.id}\nbuild_number=${buildRun.attributes.number}\n`,
    );
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
