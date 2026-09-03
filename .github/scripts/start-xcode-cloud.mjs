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
  const canonicalNames = refName.startsWith('refs/')
    ? [refName]
    : [`refs/heads/${refName}`, `refs/tags/${refName}`];
  const matchingReferences = references.filter(({ attributes }) =>
    canonicalNames.includes(attributes.canonicalName),
  );
  if (matchingReferences.length > 1) {
    throw new Error(
      `Xcode Cloud git reference "${refName}" is ambiguous; provide its canonical refs/heads or refs/tags name.`,
    );
  }
  const [reference] = matchingReferences;
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

function manualSourceConditionAllows(condition, sourceName) {
  const patterns = condition?.source?.patterns;
  if (!Array.isArray(patterns) || patterns.length === 0) return false;
  const matches = patterns.map((pattern) => tagPatternMatches(pattern, sourceName));
  return condition.source.isAllMatch ? matches.every(Boolean) : matches.some(Boolean);
}

export function manualBranchConditionAllows(condition, branchName) {
  return manualSourceConditionAllows(condition, branchName);
}

export function manualTagConditionAllows(condition, tagName) {
  return manualSourceConditionAllows(condition, tagName);
}

function createManualSourceConditionUpdatePayload(workflowID, conditionAttribute, condition, sourceName) {
  if (condition?.source?.isAllMatch === true) {
    throw new Error(
      `Cannot add "${sourceName}" to ${conditionAttribute} without changing its existing all-match semantics.`,
    );
  }
  const existingPatterns = Array.isArray(condition?.source?.patterns)
    ? condition.source.patterns.filter((pattern) => pattern && typeof pattern.pattern === 'string')
    : [];
  const patterns = existingPatterns.some((pattern) => !pattern.isPrefix && pattern.pattern === sourceName)
    ? existingPatterns
    : [...existingPatterns, { isPrefix: false, pattern: sourceName }];

  return {
    data: {
      type: 'ciWorkflows',
      id: workflowID,
      attributes: {
        [conditionAttribute]: {
          source: {
            isAllMatch: false,
            patterns,
          },
        },
      },
    },
  };
}

export function createManualBranchConditionUpdatePayload(workflowID, condition, branchName) {
  return createManualSourceConditionUpdatePayload(
    workflowID,
    'manualBranchStartCondition',
    condition,
    branchName,
  );
}

export function createManualTagConditionUpdatePayload(workflowID, condition, tagName) {
  return createManualSourceConditionUpdatePayload(workflowID, 'manualTagStartCondition', condition, tagName);
}

export async function startBuildRunWithConditionPropagation(
  startBuildRun,
  {
    attempts = 4,
    delayMilliseconds = 3_000,
    sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  } = {},
) {
  if (!Number.isInteger(attempts) || attempts < 1) {
    throw new Error('Xcode Cloud build start attempts must be a positive integer.');
  }

  let attempt = 1;
  while (true) {
    try {
      return await startBuildRun();
    } catch (error) {
      const conditionIsPropagating =
        error instanceof AppStoreConnectRequestError &&
        error.status === 409 &&
        error.message.includes('not associated with the workflow');
      if (!conditionIsPropagating || attempt >= attempts) throw error;
      attempt += 1;
      await sleep(delayMilliseconds);
    }
  }
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

function assertExpectedCommitSHA(expectedCommitSHA) {
  if (!/^[0-9a-f]{40}$/.test(expectedCommitSHA)) {
    throw new Error('XCODE_CLOUD_EXPECTED_COMMIT_SHA must be a full lowercase commit SHA.');
  }
}

export async function resolveBuildRunSource(
  buildRun,
  expectedCommitSHA,
  appStoreConnect,
  {
    attempts = 6,
    delayMilliseconds = 2_000,
    sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  } = {},
) {
  if (!expectedCommitSHA || buildRun.attributes?.sourceCommit?.commitSha) return buildRun;
  assertExpectedCommitSHA(expectedCommitSHA);
  if (!buildRun.id) {
    throw new Error('Xcode Cloud did not report the build run ID needed to verify its source commit.');
  }
  if (!Number.isInteger(attempts) || attempts < 1) {
    throw new Error('Xcode Cloud source verification attempts must be a positive integer.');
  }

  let resolvedBuildRun = buildRun;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const response = await appStoreConnect(
      `/v1/ciBuildRuns/${encodeURIComponent(buildRun.id)}?fields[ciBuildRuns]=number,sourceCommit`,
    );
    resolvedBuildRun = response.data;
    if (resolvedBuildRun.attributes?.sourceCommit?.commitSha) return resolvedBuildRun;
    if (attempt < attempts) await sleep(delayMilliseconds);
  }
  return resolvedBuildRun;
}

export function assertExpectedBuildSource(buildRun, expectedCommitSHA) {
  if (!expectedCommitSHA) return;
  assertExpectedCommitSHA(expectedCommitSHA);
  const actualCommitSHA = buildRun.attributes?.sourceCommit?.commitSha;
  if (!actualCommitSHA) {
    throw new Error('Xcode Cloud did not report the source commit selected for the build.');
  }
  if (actualCommitSHA !== expectedCommitSHA) {
    throw new Error(`Xcode Cloud selected commit ${actualCommitSHA}, expected ${expectedCommitSHA}.`);
  }
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

export function matchesExpectedXcodeVersion(actualVersion, expectedVersion) {
  if (actualVersion === expectedVersion) return true;
  const expectedMajor = expectedVersion?.match(/^(\d+)/)?.[1];
  if (!expectedMajor || typeof actualVersion !== 'string') return false;
  const semanticVersion = `${expectedMajor}(?:\\.\\d+){0,2}`;
  const buildIdentifier = `${expectedMajor}[A-Z]\\d+[a-z]?`;
  return new RegExp(`^(?:${semanticVersion}|${buildIdentifier})$`).test(actualVersion);
}

export async function validateWorkflowXcodeVersion(workflowID, expectedVersion, appStoreConnect) {
  if (!expectedVersion) return;
  if (!workflowID) {
    throw new Error('Cannot validate Xcode Cloud version without a workflow ID.');
  }
  const response = await appStoreConnect(
    `/v1/ciWorkflows/${encodeURIComponent(workflowID)}?include=xcodeVersion&fields[ciXcodeVersions]=version`,
  );
  const xcodeVersionID = response.data?.relationships?.xcodeVersion?.data?.id;
  const actualVersion = response.included?.find(
    ({ type, id }) => type === 'ciXcodeVersions' && id === xcodeVersionID,
  )?.attributes?.version;
  if (!matchesExpectedXcodeVersion(actualVersion, expectedVersion)) {
    throw new Error(
      `Xcode Cloud workflow uses Xcode ${actualVersion ?? 'unknown'}, expected ${expectedVersion}.`,
    );
  }
}

export function assertImmutableExpectedSource(gitReference, expectedCommitSHA) {
  if (!expectedCommitSHA) return;
  assertExpectedCommitSHA(expectedCommitSHA);
  const canonicalName = gitReference?.attributes?.canonicalName;
  if (!canonicalName?.startsWith('refs/tags/')) {
    throw new Error('An expected Xcode Cloud commit SHA must be built from a pre-verified immutable tag.');
  }
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

export async function resolveGitReferenceWithPropagation(
  repositoryID,
  refName,
  appStoreConnect,
  {
    attempts = 12,
    delayMilliseconds = 5_000,
    sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  } = {},
) {
  if (!Number.isInteger(attempts) || attempts < 1) {
    throw new Error('Xcode Cloud git reference attempts must be a positive integer.');
  }

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const references = await collectAppStoreConnectPages(
      `/v1/scmRepositories/${repositoryID}/gitReferences?limit=200`,
      appStoreConnect,
    );
    try {
      return selectGitReference(references, refName);
    } catch (error) {
      const isMissing = error instanceof Error && error.message.includes('was not found');
      if (!isMissing || attempt === attempts) throw error;
      await sleep(delayMilliseconds);
    }
  }
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
  let sourceReference;
  const hasExplicitTarget = hasExplicitBuildTarget(workflowID, branchRefID);

  if (hasExplicitTarget) {
    const reference = await appStoreConnect(
      `/v1/scmGitReferences/${encodeURIComponent(branchRefID)}?fields[scmGitReferences]=canonicalName,name`,
    );
    sourceReference = reference.data;
  } else {
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
    sourceReference = await resolveGitReferenceWithPropagation(
      repository.data.id,
      gitRefName,
      appStoreConnect,
    );
    branchRefID = sourceReference.id;
    const selectedRefName =
      sourceReference.attributes?.name ?? gitRefName.replace(/^refs\/(?:heads|tags)\//, '');

    const isBranch = sourceReference.attributes?.canonicalName?.startsWith('refs/heads/');
    const isTag = sourceReference.attributes?.canonicalName?.startsWith('refs/tags/');
    const missingManualBranchCondition =
      isBranch &&
      !manualBranchConditionAllows(workflow.attributes?.manualBranchStartCondition, selectedRefName);
    const missingManualTagCondition =
      isTag && !manualTagConditionAllows(workflow.attributes?.manualTagStartCondition, selectedRefName);

    if (missingManualBranchCondition || missingManualTagCondition) {
      const conditionKind = isBranch ? 'branch' : 'tag';
      const updated = await appStoreConnect(`/v1/ciWorkflows/${workflowID}`, {
        method: 'PATCH',
        body: JSON.stringify(
          isBranch
            ? createManualBranchConditionUpdatePayload(
                workflowID,
                workflow.attributes?.manualBranchStartCondition,
                selectedRefName,
              )
            : createManualTagConditionUpdatePayload(
                workflowID,
                workflow.attributes?.manualTagStartCondition,
                selectedRefName,
              ),
        ),
      });
      workflow = updated.data;
      console.log(
        `Associated ${conditionKind} "${selectedRefName}" with Xcode Cloud workflow "${process.env.XCODE_CLOUD_WORKFLOW_NAME}".`,
      );
    }
  }

  await validateWorkflowXcodeVersion(
    workflowID,
    process.env.XCODE_CLOUD_EXPECTED_XCODE_VERSION,
    appStoreConnect,
  );
  assertImmutableExpectedSource(sourceReference, process.env.XCODE_CLOUD_EXPECTED_COMMIT_SHA);

  // The moment before the build is asked for is a floor every upload from
  // this run must clear; App Store Connect does not always return the run's
  // own creation date on the resolved build run, so this clock is the
  // fallback rather than the string "undefined".
  const requestedAt = new Date().toISOString();
  const response = await startBuildRunWithConditionPropagation(() =>
    appStoreConnect('/v1/ciBuildRuns', {
      method: 'POST',
      body: JSON.stringify(createBuildRunPayload(workflowID, branchRefID)),
    }),
  );

  const buildRun = await resolveBuildRunSource(
    response.data,
    process.env.XCODE_CLOUD_EXPECTED_COMMIT_SHA,
    appStoreConnect,
  );
  assertExpectedBuildSource(buildRun, process.env.XCODE_CLOUD_EXPECTED_COMMIT_SHA);
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
      `build_run_id=${buildRun.id}\nbuild_number=${buildRun.attributes.number}\nbuild_created_at=${buildRunCreatedAt(buildRun, requestedAt)}\n`,
    );
  }
}

// The build run's own creation date when App Store Connect reports one, else
// the time this run asked for the build; both precede any upload it makes.
export function buildRunCreatedAt(buildRun, requestedAt) {
  const reported = buildRun?.attributes?.createdDate;
  return typeof reported === 'string' && Number.isFinite(Date.parse(reported)) ? reported : requestedAt;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
