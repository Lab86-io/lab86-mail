import { appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  AppStoreConnectRequestError,
  createAppStoreConnectToken,
  requestAppStoreConnect,
} from './app-store-connect.mjs';

export function selectWorkflowID(workflows, workflowName) {
  const workflow = workflows.find(({ attributes }) => attributes.name === workflowName);
  if (!workflow) {
    throw new Error(`Xcode Cloud workflow "${workflowName}" was not found.`);
  }
  return workflow.id;
}

export function selectGitReference(references, refName) {
  const reference = references.find(
    ({ attributes }) =>
      attributes.name === refName ||
      attributes.canonicalName === `refs/heads/${refName}` ||
      attributes.canonicalName === `refs/tags/${refName}`,
  );
  if (!reference) {
    throw new Error(`Xcode Cloud git reference "${refName}" was not found.`);
  }
  return reference;
}

export function selectGitRefID(references, refName) {
  return selectGitReference(references, refName).id;
}

export const selectBranchRefID = selectGitRefID;

function tagPatternMatches(pattern, tagName) {
  if (!pattern || typeof pattern.pattern !== 'string') return false;
  return pattern.isPrefix ? tagName.startsWith(pattern.pattern) : tagName === pattern.pattern;
}

export function manualTagConditionAllows(condition, tagName) {
  const patterns = condition?.source?.patterns;
  if (!Array.isArray(patterns) || patterns.length === 0) return false;
  const matches = patterns.map((pattern) => tagPatternMatches(pattern, tagName));
  return condition.source.isAllMatch ? matches.every(Boolean) : matches.some(Boolean);
}

export function createManualTagConditionUpdatePayload(workflowID, condition, tagName) {
  const existingPatterns = Array.isArray(condition?.source?.patterns)
    ? condition.source.patterns.filter((pattern) => pattern && typeof pattern.pattern === 'string')
    : [];
  const patterns = existingPatterns.some((pattern) => !pattern.isPrefix && pattern.pattern === tagName)
    ? existingPatterns
    : [...existingPatterns, { isPrefix: false, pattern: tagName }];

  return {
    data: {
      type: 'ciWorkflows',
      id: workflowID,
      attributes: {
        manualTagStartCondition: {
          source: {
            isAllMatch: false,
            patterns,
          },
        },
      },
    },
  };
}

export async function startBuildRunWithConditionPropagation(
  startBuildRun,
  {
    attempts = 4,
    delayMilliseconds = 3_000,
    sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  } = {},
) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await startBuildRun();
    } catch (error) {
      const conditionIsPropagating =
        error instanceof AppStoreConnectRequestError &&
        error.status === 409 &&
        error.message.includes('not associated with the workflow');
      if (!conditionIsPropagating || attempt === attempts) throw error;
      await sleep(delayMilliseconds);
    }
  }
  throw new Error('Xcode Cloud build start exhausted its retry budget.');
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
    for (const name of ['APP_STORE_APP_ID', 'XCODE_CLOUD_WORKFLOW_NAME']) {
      if (!process.env[name]) {
        throw new Error(
          `Missing ${name}; provide discovery names or explicit XCODE_CLOUD_WORKFLOW_ID and XCODE_CLOUD_BRANCH_REF_ID.`,
        );
      }
    }
    const gitRefName = process.env.XCODE_CLOUD_GIT_REF_NAME || process.env.XCODE_CLOUD_BRANCH_NAME;
    if (!gitRefName) {
      throw new Error(
        'Missing XCODE_CLOUD_GIT_REF_NAME or XCODE_CLOUD_BRANCH_NAME; provide the exact source ref to build.',
      );
    }

    const product = await appStoreConnect(`/v1/apps/${process.env.APP_STORE_APP_ID}/ciProduct`);
    const workflows = await collectAppStoreConnectPages(
      `/v1/ciProducts/${product.data.id}/workflows?limit=200`,
      appStoreConnect,
    );
    let workflow = workflows.find(
      ({ attributes }) => attributes.name === process.env.XCODE_CLOUD_WORKFLOW_NAME,
    );
    if (workflow) {
      workflowID = workflow.id;
    } else {
      if (!process.env.XCODE_CLOUD_TEMPLATE_WORKFLOW_ID) {
        throw new Error(
          `Xcode Cloud workflow "${process.env.XCODE_CLOUD_WORKFLOW_NAME}" was not found and no template workflow is configured.`,
        );
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
            process.env.XCODE_CLOUD_BRANCH_NAME || gitRefName,
          ),
        ),
      });
      workflowID = created.data.id;
      workflow = created.data;
      console.log(`Created Xcode Cloud workflow "${process.env.XCODE_CLOUD_WORKFLOW_NAME}" (${workflowID}).`);
    }

    const repository = await appStoreConnect(`/v1/ciWorkflows/${workflowID}/repository`);
    const references = await collectAppStoreConnectPages(
      `/v1/scmRepositories/${repository.data.id}/gitReferences?limit=200`,
      appStoreConnect,
    );
    const gitReference = selectGitReference(references, gitRefName);
    branchRefID = gitReference.id;

    if (
      gitReference.attributes?.canonicalName?.startsWith('refs/tags/') &&
      !manualTagConditionAllows(workflow.attributes?.manualTagStartCondition, gitRefName)
    ) {
      const updated = await appStoreConnect(`/v1/ciWorkflows/${workflowID}`, {
        method: 'PATCH',
        body: JSON.stringify(
          createManualTagConditionUpdatePayload(
            workflowID,
            workflow.attributes?.manualTagStartCondition,
            gitRefName,
          ),
        ),
      });
      workflow = updated.data;
      console.log(
        `Associated release tag "${gitRefName}" with Xcode Cloud workflow "${process.env.XCODE_CLOUD_WORKFLOW_NAME}".`,
      );
    }
  }

  const response = await startBuildRunWithConditionPropagation(() =>
    appStoreConnect('/v1/ciBuildRuns', {
      method: 'POST',
      body: JSON.stringify(createBuildRunPayload(workflowID, branchRefID)),
    }),
  );

  const buildRun = response.data;
  console.log(
    `Started Xcode Cloud build #${buildRun.attributes.number} (${buildRun.id}) on ${
      process.env.XCODE_CLOUD_GIT_REF_NAME ||
      process.env.XCODE_CLOUD_BRANCH_NAME ||
      'the configured git reference'
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
