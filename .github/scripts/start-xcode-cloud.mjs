import { appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createAppStoreConnectToken, requestAppStoreConnect } from './app-store-connect.mjs';

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

function relationshipID(workflow, name, type) {
  const linked = workflow.data?.relationships?.[name]?.data;
  if (linked?.id) return linked.id;
  const included = workflow.included?.find((resource) => resource.type === type);
  if (included?.id) return included.id;
  throw new Error(`Xcode Cloud template workflow is missing its ${name} relationship.`);
}

export function createProductionWorkflowPayload(template, workflowName, branchName) {
  const attributes = template.data?.attributes ?? {};
  const requiredAttributes = ['actions', 'clean', 'containerFilePath', 'description', 'isEnabled', 'name'];
  for (const name of requiredAttributes) {
    if (attributes[name] === undefined || attributes[name] === null) {
      throw new Error(`Xcode Cloud template workflow is missing required attribute ${name}.`);
    }
  }

  let hasArchive = false;
  const actions = attributes.actions.map((action) => {
    if (action.actionType !== 'ARCHIVE') return action;
    hasArchive = true;
    return {
      ...action,
      buildDistributionAudience: 'APP_STORE_ELIGIBLE',
    };
  });
  if (!hasArchive) {
    throw new Error('Xcode Cloud template workflow does not contain an archive action.');
  }

  return {
    data: {
      type: 'ciWorkflows',
      attributes: {
        actions,
        clean: attributes.clean,
        containerFilePath: attributes.containerFilePath,
        description: 'Production App Store archive created by the release pipeline.',
        isEnabled: true,
        name: workflowName,
        manualBranchStartCondition: {
          source: {
            isAllMatch: false,
            patterns: [{ isPrefix: false, pattern: branchName }],
          },
        },
      },
      relationships: {
        product: {
          data: { type: 'ciProducts', id: relationshipID(template, 'product', 'ciProducts') },
        },
        repository: {
          data: {
            type: 'scmRepositories',
            id: relationshipID(template, 'repository', 'scmRepositories'),
          },
        },
        xcodeVersion: {
          data: {
            type: 'ciXcodeVersions',
            id: relationshipID(template, 'xcodeVersion', 'ciXcodeVersions'),
          },
        },
        macOsVersion: {
          data: {
            type: 'ciMacOsVersions',
            id: relationshipID(template, 'macOsVersion', 'ciMacOsVersions'),
          },
        },
      },
    },
  };
}

export function hasExplicitBuildTarget(workflowID, branchRefID) {
  if (Boolean(workflowID) !== Boolean(branchRefID)) {
    throw new Error('XCODE_CLOUD_WORKFLOW_ID and XCODE_CLOUD_BRANCH_REF_ID must be provided together.');
  }
  return Boolean(workflowID && branchRefID);
}

function appStoreConnectPath(url) {
  const parsed = new URL(url, 'https://api.appstoreconnect.apple.com');
  if (parsed.origin !== 'https://api.appstoreconnect.apple.com') {
    throw new Error(`App Store Connect pagination returned an unexpected origin: ${parsed.origin}`);
  }
  return `${parsed.pathname}${parsed.search}`;
}

export async function collectAppStoreConnectPages(initialPath, appStoreConnect) {
  const data = [];
  const seen = new Set();
  let path = appStoreConnectPath(initialPath);

  while (path) {
    if (seen.has(path)) {
      throw new Error(`App Store Connect pagination repeated a page: ${path}`);
    }
    seen.add(path);
    const response = await appStoreConnect(path);
    data.push(...(response.data ?? []));
    path = response.links?.next ? appStoreConnectPath(response.links.next) : '';
  }

  return data;
}

export async function main() {
  const requiredEnvironment = ['ASC_ISSUER_ID', 'ASC_KEY_ID', 'ASC_PRIVATE_KEY'];
  for (const name of requiredEnvironment) {
    if (!process.env[name]) {
      throw new Error(`Missing required environment variable: ${name}`);
    }
  }

  const getToken = () =>
    createAppStoreConnectToken({
      issuerID: process.env.ASC_ISSUER_ID,
      keyID: process.env.ASC_KEY_ID,
      privateKey: process.env.ASC_PRIVATE_KEY,
    });

  async function appStoreConnect(path, options = {}) {
    return requestAppStoreConnect(path, {
      getToken,
      options,
      maxAttempts: options.method === 'POST' ? 1 : 4,
    });
  }

  let workflowID = process.env.XCODE_CLOUD_WORKFLOW_ID;
  let branchRefID = process.env.XCODE_CLOUD_BRANCH_REF_ID;

  if (!hasExplicitBuildTarget(workflowID, branchRefID)) {
    for (const name of ['APP_STORE_APP_ID', 'XCODE_CLOUD_WORKFLOW_NAME', 'XCODE_CLOUD_BRANCH_NAME']) {
      if (!process.env[name]) {
        throw new Error(
          `Missing ${name}; provide discovery names or explicit XCODE_CLOUD_WORKFLOW_ID and XCODE_CLOUD_BRANCH_REF_ID.`,
        );
      }
    }

    const product = await appStoreConnect(`/v1/apps/${process.env.APP_STORE_APP_ID}/ciProduct`);
    const workflows = await collectAppStoreConnectPages(
      `/v1/ciProducts/${product.data.id}/workflows?limit=200`,
      appStoreConnect,
    );
    const workflow = workflows.find(
      ({ attributes }) => attributes.name === process.env.XCODE_CLOUD_WORKFLOW_NAME,
    );
    if (workflow) {
      workflowID = workflow.id;
    } else {
      if (!process.env.XCODE_CLOUD_TEMPLATE_WORKFLOW_ID) {
        workflowID = selectWorkflowID(workflows, process.env.XCODE_CLOUD_WORKFLOW_NAME);
      }
      const template = await appStoreConnect(
        `/v1/ciWorkflows/${process.env.XCODE_CLOUD_TEMPLATE_WORKFLOW_ID}` +
          '?include=product,repository,xcodeVersion,macOsVersion',
      );
      const created = await appStoreConnect('/v1/ciWorkflows', {
        method: 'POST',
        body: JSON.stringify(
          createProductionWorkflowPayload(
            template,
            process.env.XCODE_CLOUD_WORKFLOW_NAME,
            process.env.XCODE_CLOUD_BRANCH_NAME,
          ),
        ),
      });
      workflowID = created.data.id;
      console.log(`Created Xcode Cloud workflow "${process.env.XCODE_CLOUD_WORKFLOW_NAME}" (${workflowID}).`);
    }

    const repository = await appStoreConnect(`/v1/ciWorkflows/${workflowID}/repository`);
    const references = await collectAppStoreConnectPages(
      `/v1/scmRepositories/${repository.data.id}/gitReferences?limit=200`,
      appStoreConnect,
    );
    branchRefID = selectBranchRefID(references, process.env.XCODE_CLOUD_BRANCH_NAME);
  }

  const response = await appStoreConnect('/v1/ciBuildRuns', {
    method: 'POST',
    body: JSON.stringify(createBuildRunPayload(workflowID, branchRefID)),
  });

  const buildRun = response.data;
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
