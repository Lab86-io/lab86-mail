import { describe, expect, test } from 'bun:test';
import { generateKeyPairSync } from 'node:crypto';
import { AppStoreConnectRequestError } from '../.github/scripts/app-store-connect.mjs';
import {
  assertExpectedBuildSource,
  assertImmutableExpectedSource,
  collectAppStoreConnectPages,
  createBuildRunPayload,
  createManualBranchConditionUpdatePayload,
  createManualTagConditionUpdatePayload,
  createProductionWorkflowPayload,
  hasExplicitBuildTarget,
  main,
  manualBranchConditionAllows,
  manualTagConditionAllows,
  matchesExpectedXcodeVersion,
  resolveBuildRunSource,
  resolveGitReferenceWithPropagation,
  selectBranchRefID,
  selectWorkflowID,
  startBuildRunWithConditionPropagation,
  validateWorkflowXcodeVersion,
} from '../.github/scripts/start-xcode-cloud.mjs';

describe('Xcode Cloud build discovery', () => {
  test('selects the named workflow and exact branch identity', () => {
    expect(
      selectWorkflowID(
        [
          { id: 'staging-workflow', attributes: { name: 'Staging TestFlight' } },
          { id: 'production-workflow', attributes: { name: 'Production App Store' } },
        ],
        'Production App Store',
      ),
    ).toBe('production-workflow');

    expect(
      selectBranchRefID(
        [
          { id: 'staging-ref', attributes: { name: 'staging', canonicalName: 'refs/heads/staging' } },
          { id: 'main-ref', attributes: { name: 'main', canonicalName: 'refs/heads/main' } },
        ],
        'main',
      ),
    ).toBe('main-ref');
  });

  test('fails closed when workflow or branch configuration is absent', () => {
    expect(() => selectWorkflowID([], 'Production App Store')).toThrow(
      'Xcode Cloud workflow "Production App Store" was not found.',
    );
    expect(() => selectBranchRefID([], 'main')).toThrow('Xcode Cloud git reference "main" was not found.');
    expect(() => hasExplicitBuildTarget('workflow', undefined)).toThrow(
      'XCODE_CLOUD_WORKFLOW_ID and XCODE_CLOUD_BRANCH_REF_ID must be provided together.',
    );
    expect(() => hasExplicitBuildTarget(undefined, 'branch')).toThrow(
      'XCODE_CLOUD_WORKFLOW_ID and XCODE_CLOUD_BRANCH_REF_ID must be provided together.',
    );
    expect(hasExplicitBuildTarget(undefined, undefined)).toBe(false);
    expect(hasExplicitBuildTarget('workflow', 'branch')).toBe(true);
    expect(() =>
      selectBranchRefID(
        [
          { id: 'branch-ref', attributes: { name: 'release', canonicalName: 'refs/heads/release' } },
          { id: 'tag-ref', attributes: { name: 'release', canonicalName: 'refs/tags/release' } },
        ],
        'release',
      ),
    ).toThrow('is ambiguous');
    expect(
      selectBranchRefID(
        [
          { id: 'branch-ref', attributes: { name: 'release', canonicalName: 'refs/heads/release' } },
          { id: 'tag-ref', attributes: { name: 'release', canonicalName: 'refs/tags/release' } },
        ],
        'refs/tags/release',
      ),
    ).toBe('tag-ref');
  });

  test('explains that production workflow creation requires a configured template', async () => {
    const environmentNames = [
      'ASC_ISSUER_ID',
      'ASC_KEY_ID',
      'ASC_PRIVATE_KEY',
      'APP_STORE_APP_ID',
      'XCODE_CLOUD_WORKFLOW_NAME',
      'XCODE_CLOUD_BRANCH_NAME',
      'XCODE_CLOUD_EXPECTED_COMMIT_SHA',
      'XCODE_CLOUD_TEMPLATE_WORKFLOW_ID',
      'XCODE_CLOUD_WORKFLOW_ID',
      'XCODE_CLOUD_BRANCH_REF_ID',
    ];
    const previousEnvironment = new Map(environmentNames.map((name) => [name, process.env[name]] as const));
    const previousFetch = globalThis.fetch;
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    Object.assign(process.env, {
      ASC_ISSUER_ID: 'issuer',
      ASC_KEY_ID: 'key',
      ASC_PRIVATE_KEY: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
      APP_STORE_APP_ID: 'app',
      XCODE_CLOUD_WORKFLOW_NAME: 'Production App Store',
      XCODE_CLOUD_BRANCH_NAME: 'main',
    });
    delete process.env.XCODE_CLOUD_TEMPLATE_WORKFLOW_ID;
    delete process.env.XCODE_CLOUD_WORKFLOW_ID;
    delete process.env.XCODE_CLOUD_BRANCH_REF_ID;
    globalThis.fetch = async (input) => {
      const path = new URL(String(input)).pathname;
      if (path === '/v1/apps/app/ciProduct') {
        return Response.json({ data: { id: 'product' } });
      }
      return Response.json({ data: [], links: { next: null } });
    };

    try {
      await expect(main()).rejects.toThrow('no template workflow is configured');
    } finally {
      globalThis.fetch = previousFetch;
      for (const [name, value] of previousEnvironment) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });

  test('builds the App Store Connect relationship payload from discovered IDs', () => {
    expect(createBuildRunPayload('production-workflow', 'main-ref')).toEqual({
      data: {
        type: 'ciBuildRuns',
        attributes: {},
        relationships: {
          workflow: {
            data: { type: 'ciWorkflows', id: 'production-workflow' },
          },
          sourceBranchOrTag: {
            data: { type: 'scmGitReferences', id: 'main-ref' },
          },
        },
      },
    });
  });

  test('resolves and verifies an explicit immutable tag before starting a build', async () => {
    const environmentNames = [
      'ASC_ISSUER_ID',
      'ASC_KEY_ID',
      'ASC_PRIVATE_KEY',
      'XCODE_CLOUD_WORKFLOW_ID',
      'XCODE_CLOUD_BRANCH_REF_ID',
      'XCODE_CLOUD_EXPECTED_COMMIT_SHA',
      'XCODE_CLOUD_EXPECTED_XCODE_VERSION',
      'GITHUB_OUTPUT',
    ];
    const previousEnvironment = new Map(environmentNames.map((name) => [name, process.env[name]] as const));
    const previousFetch = globalThis.fetch;
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const expectedCommit = 'a'.repeat(40);
    const requests: Array<{ path: string; method: string; body?: unknown }> = [];

    Object.assign(process.env, {
      ASC_ISSUER_ID: 'issuer',
      ASC_KEY_ID: 'key',
      ASC_PRIVATE_KEY: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
      XCODE_CLOUD_WORKFLOW_ID: 'production-workflow',
      XCODE_CLOUD_BRANCH_REF_ID: 'release-tag',
      XCODE_CLOUD_EXPECTED_COMMIT_SHA: expectedCommit,
    });
    delete process.env.XCODE_CLOUD_EXPECTED_XCODE_VERSION;
    delete process.env.GITHUB_OUTPUT;

    globalThis.fetch = async (input, init) => {
      const url = new URL(String(input));
      const method = init?.method ?? 'GET';
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
      requests.push({ path: `${url.pathname}${url.search}`, method, body });
      if (url.pathname === '/v1/scmGitReferences/release-tag') {
        return Response.json({
          data: {
            id: 'release-tag',
            attributes: { name: 'v0.10.0', canonicalName: 'refs/tags/v0.10.0' },
          },
        });
      }
      if (url.pathname === '/v1/ciBuildRuns' && method === 'POST') {
        return Response.json({
          data: {
            id: 'build-run',
            attributes: { number: 90, sourceCommit: { commitSha: expectedCommit } },
          },
        });
      }
      return new Response('not found', { status: 404 });
    };

    try {
      await main();
    } finally {
      globalThis.fetch = previousFetch;
      for (const [name, value] of previousEnvironment) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }

    expect(requests[0]?.path).toBe(
      '/v1/scmGitReferences/release-tag?fields[scmGitReferences]=canonicalName,name',
    );
    expect(requests[1]?.body).toEqual(createBuildRunPayload('production-workflow', 'release-tag'));
  });

  test('rejects a workflow whose selected Xcode version is not iOS 27', async () => {
    const requests: string[] = [];
    await expect(
      validateWorkflowXcodeVersion('production/workflow', '27.0', async (path: string) => {
        requests.push(path);
        return {
          data: {
            relationships: {
              xcodeVersion: { data: { type: 'ciXcodeVersions', id: 'xcode-26' } },
            },
          },
          included: [{ type: 'ciXcodeVersions', id: 'xcode-26', attributes: { version: '26.6' } }],
        };
      }),
    ).rejects.toThrow('uses Xcode 26.6, expected 27.0');
    expect(requests).toEqual([
      '/v1/ciWorkflows/production%2Fworkflow?include=xcodeVersion&fields[ciXcodeVersions]=version',
    ]);

    await expect(
      validateWorkflowXcodeVersion('production-workflow', '27.0', async () => ({
        data: {
          relationships: {
            xcodeVersion: { data: { type: 'ciXcodeVersions', id: 'xcode-27' } },
          },
        },
        included: [{ type: 'ciXcodeVersions', id: 'xcode-27', attributes: { version: '27.0' } }],
      })),
    ).resolves.toBeUndefined();
  });

  test('accepts Apple Xcode 27 build identifiers without accepting adjacent major versions', () => {
    expect(matchesExpectedXcodeVersion('27A5237l', '27.0')).toBe(true);
    expect(matchesExpectedXcodeVersion('27.1', '27.0')).toBe(true);
    expect(matchesExpectedXcodeVersion('26A5237l', '27.0')).toBe(false);
    expect(matchesExpectedXcodeVersion('270A5237l', '27.0')).toBe(false);
    expect(matchesExpectedXcodeVersion('27.', '27.0')).toBe(false);
    expect(matchesExpectedXcodeVersion('27.foo', '27.0')).toBe(false);
    expect(matchesExpectedXcodeVersion('27A', '27.0')).toBe(false);
  });

  test('requires Xcode Cloud to report the expected immutable source commit', () => {
    const expectedCommit = 'a'.repeat(40);
    expect(() =>
      assertExpectedBuildSource(
        {
          attributes: {
            sourceCommit: { commitSha: expectedCommit },
          },
        },
        expectedCommit,
      ),
    ).not.toThrow();
    expect(() => assertExpectedBuildSource({ attributes: {} }, expectedCommit)).toThrow(
      'did not report the source commit',
    );
    expect(() =>
      assertExpectedBuildSource(
        {
          attributes: {
            sourceCommit: { commitSha: 'b'.repeat(40) },
          },
        },
        expectedCommit,
      ),
    ).toThrow(`expected ${expectedCommit}`);
    expect(() => assertExpectedBuildSource({ attributes: {} }, 'short-sha')).toThrow(
      'must be a full lowercase commit SHA',
    );
  });

  test('rejects an expected commit build when its source branch can move', () => {
    const expectedCommit = 'a'.repeat(40);
    expect(() =>
      assertImmutableExpectedSource({ attributes: { canonicalName: 'refs/heads/staging' } }, expectedCommit),
    ).toThrow('must be built from a pre-verified immutable tag');
    expect(() =>
      assertImmutableExpectedSource(
        { attributes: { canonicalName: `refs/tags/ios-staging-${expectedCommit}` } },
        expectedCommit,
      ),
    ).not.toThrow();
  });

  test('hydrates a sparse build creation response before verifying its source commit', async () => {
    const expectedCommit = 'a'.repeat(40);
    const requests: string[] = [];
    let reads = 0;
    const buildRun = await resolveBuildRunSource(
      { id: 'build/run', attributes: { number: 84 } },
      expectedCommit,
      async (path: string) => {
        requests.push(path);
        reads += 1;
        return {
          data: {
            id: 'build/run',
            attributes: {
              number: 84,
              ...(reads === 2 ? { sourceCommit: { commitSha: expectedCommit } } : {}),
            },
          },
        };
      },
      { attempts: 2, delayMilliseconds: 0 },
    );

    expect(requests).toEqual([
      '/v1/ciBuildRuns/build%2Frun?fields[ciBuildRuns]=number,sourceCommit',
      '/v1/ciBuildRuns/build%2Frun?fields[ciBuildRuns]=number,sourceCommit',
    ]);
    expect(() => assertExpectedBuildSource(buildRun, expectedCommit)).not.toThrow();
  });

  test('fails closed when source commit hydration remains incomplete', async () => {
    const expectedCommit = 'a'.repeat(40);
    const buildRun = await resolveBuildRunSource(
      { id: 'build-run', attributes: { number: 84 } },
      expectedCommit,
      async () => ({ data: { id: 'build-run', attributes: { number: 84 } } }),
      { attempts: 2, delayMilliseconds: 0 },
    );

    expect(() => assertExpectedBuildSource(buildRun, expectedCommit)).toThrow(
      'did not report the source commit',
    );
    await expect(
      resolveBuildRunSource(
        { id: 'build-run', attributes: {} },
        expectedCommit,
        async () => ({ data: { id: 'build-run', attributes: {} } }),
        { attempts: 0 },
      ),
    ).rejects.toThrow('attempts must be a positive integer');
  });

  test('recognizes exact and prefix manual tag conditions', () => {
    expect(
      manualTagConditionAllows(
        {
          source: {
            isAllMatch: false,
            patterns: [
              { isPrefix: true, pattern: 'release/' },
              { isPrefix: false, pattern: 'v0.9.0' },
            ],
          },
        },
        'v0.9.0',
      ),
    ).toBe(true);
    expect(
      manualTagConditionAllows(
        {
          source: {
            isAllMatch: false,
            patterns: [{ isPrefix: true, pattern: 'v' }],
          },
        },
        'v0.9.1',
      ),
    ).toBe(true);
    expect(manualTagConditionAllows(undefined, 'v0.9.0')).toBe(false);
  });

  test('recognizes exact and prefix manual branch conditions', () => {
    expect(
      manualBranchConditionAllows(
        {
          source: {
            isAllMatch: false,
            patterns: [
              { isPrefix: true, pattern: 'release/' },
              { isPrefix: false, pattern: 'main' },
            ],
          },
        },
        'main',
      ),
    ).toBe(true);
    expect(
      manualBranchConditionAllows(
        {
          source: {
            isAllMatch: false,
            patterns: [{ isPrefix: true, pattern: 'release/' }],
          },
        },
        'main',
      ),
    ).toBe(false);
    expect(manualBranchConditionAllows(undefined, 'main')).toBe(false);
  });

  test('adds main without discarding existing manual branch patterns', () => {
    expect(
      createManualBranchConditionUpdatePayload(
        'production-workflow',
        {
          source: {
            isAllMatch: false,
            patterns: [{ isPrefix: true, pattern: 'release/' }],
          },
        },
        'main',
      ),
    ).toEqual({
      data: {
        type: 'ciWorkflows',
        id: 'production-workflow',
        attributes: {
          manualBranchStartCondition: {
            source: {
              isAllMatch: false,
              patterns: [
                { isPrefix: true, pattern: 'release/' },
                { isPrefix: false, pattern: 'main' },
              ],
            },
          },
        },
      },
    });
  });

  test('adds the immutable release tag without discarding existing manual tag patterns', () => {
    expect(
      createManualTagConditionUpdatePayload(
        'production-workflow',
        {
          source: {
            isAllMatch: false,
            patterns: [{ isPrefix: true, pattern: 'release/' }],
          },
        },
        'v0.9.0',
      ),
    ).toEqual({
      data: {
        type: 'ciWorkflows',
        id: 'production-workflow',
        attributes: {
          manualTagStartCondition: {
            source: {
              isAllMatch: false,
              patterns: [
                { isPrefix: true, pattern: 'release/' },
                { isPrefix: false, pattern: 'v0.9.0' },
              ],
            },
          },
        },
      },
    });
  });

  test('rejects condition updates that would change existing all-match semantics', () => {
    const allMatchCondition = {
      source: {
        isAllMatch: true,
        patterns: [{ isPrefix: true, pattern: 'release/' }],
      },
    };

    expect(() =>
      createManualBranchConditionUpdatePayload('production-workflow', allMatchCondition, 'main'),
    ).toThrow('without changing its existing all-match semantics');
    expect(() =>
      createManualTagConditionUpdatePayload('production-workflow', allMatchCondition, 'v0.9.0'),
    ).toThrow('without changing its existing all-match semantics');
  });

  test('retries only while an updated workflow tag condition propagates', async () => {
    let calls = 0;
    const response = await startBuildRunWithConditionPropagation(
      async () => {
        calls += 1;
        if (calls < 3) {
          throw new AppStoreConnectRequestError('The tag is not associated with the workflow.', {
            status: 409,
          });
        }
        return { data: { id: 'build-run' } };
      },
      { delayMilliseconds: 0 },
    );

    expect(response).toEqual({ data: { id: 'build-run' } });
    expect(calls).toBe(3);

    await expect(
      startBuildRunWithConditionPropagation(
        async () => {
          throw new AppStoreConnectRequestError('Daily build limit reached.', { status: 409 });
        },
        { delayMilliseconds: 0 },
      ),
    ).rejects.toThrow('Daily build limit reached');

    const persistentPropagationError = new AppStoreConnectRequestError(
      'The tag is not associated with the workflow.',
      { status: 409 },
    );
    let persistentCalls = 0;
    try {
      await startBuildRunWithConditionPropagation(
        async () => {
          persistentCalls += 1;
          throw persistentPropagationError;
        },
        { attempts: 2, delayMilliseconds: 0 },
      );
      throw new Error('Expected the persistent propagation error to be rethrown.');
    } catch (error) {
      expect(error).toBe(persistentPropagationError);
    }
    expect(persistentCalls).toBe(2);
  });

  test('creates a main-only App Store workflow from the proven archive template', () => {
    const payload = createProductionWorkflowPayload(
      {
        data: {
          attributes: {
            actions: [
              {
                actionType: 'ARCHIVE',
                buildDistributionAudience: 'INTERNAL_ONLY',
                destination: 'ANY_IOS_DEVICE',
                isRequiredToPass: true,
                name: 'Archive',
                platform: 'IOS',
                scheme: 'Lab86Mail',
              },
            ],
            clean: true,
            containerFilePath: 'apps/ios/Lab86Mail.xcodeproj',
            description: 'Staging archive',
            isEnabled: true,
            name: 'Staging TestFlight',
          },
          relationships: {
            product: { data: { type: 'ciProducts', id: 'product' } },
            repository: { data: { type: 'scmRepositories', id: 'repository' } },
            xcodeVersion: { data: { type: 'ciXcodeVersions', id: 'xcode' } },
            macOsVersion: { data: { type: 'ciMacOsVersions', id: 'macos' } },
          },
        },
      },
      'Production App Store',
      'main',
    );

    expect(payload.data.attributes.name).toBe('Production App Store');
    expect(payload.data.attributes.actions[0].buildDistributionAudience).toBe('APP_STORE_ELIGIBLE');
    expect(payload.data.attributes.manualBranchStartCondition).toEqual({
      source: {
        isAllMatch: false,
        patterns: [{ isPrefix: false, pattern: 'main' }],
      },
    });
    expect(payload.data.relationships).toEqual({
      product: { data: { type: 'ciProducts', id: 'product' } },
      repository: { data: { type: 'scmRepositories', id: 'repository' } },
      xcodeVersion: { data: { type: 'ciXcodeVersions', id: 'xcode' } },
      macOsVersion: { data: { type: 'ciMacOsVersions', id: 'macos' } },
    });
  });

  test('refuses to create a production workflow from an incomplete template', () => {
    expect(() =>
      createProductionWorkflowPayload(
        {
          data: {
            attributes: {
              actions: [],
              clean: true,
              containerFilePath: 'apps/ios/Lab86Mail.xcodeproj',
              description: '',
              isEnabled: true,
              name: 'No archive',
            },
            relationships: {},
          },
        },
        'Production App Store',
        'main',
      ),
    ).toThrow('does not contain an archive action');
  });

  test('preserves non-archive actions and resolves included workflow relationships', () => {
    const payload = createProductionWorkflowPayload(
      {
        data: {
          attributes: {
            actions: [
              {
                actionType: 'BUILD',
                destination: 'ANY_IOS_SIMULATOR',
                isRequiredToPass: true,
                name: 'Build',
                platform: 'IOS',
                scheme: 'Lab86Mail',
              },
              {
                actionType: 'ARCHIVE',
                destination: 'ANY_IOS_DEVICE',
                isRequiredToPass: true,
                name: 'Archive',
                platform: 'IOS',
                scheme: 'Lab86Mail',
              },
            ],
            clean: false,
            containerFilePath: 'apps/ios/Lab86Mail.xcodeproj',
            description: '',
            isEnabled: true,
            name: 'Staging TestFlight',
          },
          relationships: {},
        },
        included: [
          { type: 'ciProducts', id: 'product' },
          { type: 'scmRepositories', id: 'repository' },
          { type: 'ciXcodeVersions', id: 'xcode' },
          { type: 'ciMacOsVersions', id: 'macos' },
        ],
      },
      'Production App Store',
      'main',
    );

    expect(payload.data.attributes.actions[0].actionType).toBe('BUILD');
    expect(payload.data.attributes.actions[0].buildDistributionAudience).toBeUndefined();
    expect(payload.data.relationships.repository.data.id).toBe('repository');
  });

  test('reports missing template attributes and relationships precisely', () => {
    expect(() =>
      createProductionWorkflowPayload(
        { data: { attributes: { actions: [] } } },
        'Production App Store',
        'main',
      ),
    ).toThrow('missing required attribute clean');

    expect(() =>
      createProductionWorkflowPayload(
        {
          data: {
            attributes: {
              actions: [{ actionType: 'ARCHIVE' }],
              clean: true,
              containerFilePath: 'apps/ios/Lab86Mail.xcodeproj',
              description: '',
              isEnabled: true,
              name: 'Staging TestFlight',
            },
            relationships: {},
          },
        },
        'Production App Store',
        'main',
      ),
    ).toThrow('missing its product relationship');
  });

  test('creates the missing production workflow and starts its main build through App Store Connect', async () => {
    const environmentNames = [
      'ASC_ISSUER_ID',
      'ASC_KEY_ID',
      'ASC_PRIVATE_KEY',
      'APP_STORE_APP_ID',
      'XCODE_CLOUD_WORKFLOW_NAME',
      'XCODE_CLOUD_BRANCH_NAME',
      'XCODE_CLOUD_EXPECTED_COMMIT_SHA',
      'XCODE_CLOUD_TEMPLATE_WORKFLOW_ID',
      'XCODE_CLOUD_WORKFLOW_ID',
      'XCODE_CLOUD_BRANCH_REF_ID',
      'GITHUB_OUTPUT',
    ];
    const previousEnvironment = new Map(environmentNames.map((name) => [name, process.env[name]] as const));
    const previousFetch = globalThis.fetch;
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const requests: Array<{ path: string; method: string; body?: unknown }> = [];

    Object.assign(process.env, {
      ASC_ISSUER_ID: 'issuer',
      ASC_KEY_ID: 'key',
      ASC_PRIVATE_KEY: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
      APP_STORE_APP_ID: 'app',
      XCODE_CLOUD_WORKFLOW_NAME: 'Production App Store',
      XCODE_CLOUD_BRANCH_NAME: 'main',
      XCODE_CLOUD_TEMPLATE_WORKFLOW_ID: 'staging-workflow',
    });
    delete process.env.XCODE_CLOUD_WORKFLOW_ID;
    delete process.env.XCODE_CLOUD_BRANCH_REF_ID;
    delete process.env.GITHUB_OUTPUT;

    const template = {
      data: {
        attributes: {
          actions: [{ actionType: 'ARCHIVE', scheme: 'Lab86Mail', platform: 'IOS' }],
          clean: true,
          containerFilePath: 'apps/ios/Lab86Mail.xcodeproj',
          description: '',
          isEnabled: true,
          name: 'Staging TestFlight',
        },
        relationships: {
          product: { data: { type: 'ciProducts', id: 'product' } },
          repository: { data: { type: 'scmRepositories', id: 'repository' } },
          xcodeVersion: { data: { type: 'ciXcodeVersions', id: 'xcode' } },
          macOsVersion: { data: { type: 'ciMacOsVersions', id: 'macos' } },
        },
      },
    };

    globalThis.fetch = async (input, init) => {
      const url = new URL(String(input));
      const method = init?.method ?? 'GET';
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
      requests.push({ path: `${url.pathname}${url.search}`, method, body });

      let response: object;
      if (url.pathname === '/v1/apps/app/ciProduct') {
        response = { data: { id: 'product' } };
      } else if (url.pathname === '/v1/ciProducts/product/workflows') {
        response = { data: [], links: { next: null } };
      } else if (url.pathname === '/v1/ciWorkflows/staging-workflow') {
        response = template;
      } else if (url.pathname === '/v1/ciWorkflows' && method === 'POST') {
        response = {
          data: {
            id: 'production-workflow',
            attributes: {
              manualBranchStartCondition: {
                source: {
                  isAllMatch: false,
                  patterns: [{ isPrefix: false, pattern: 'main' }],
                },
              },
            },
          },
        };
      } else if (url.pathname === '/v1/ciWorkflows/production-workflow/repository') {
        response = { data: { id: 'repository' } };
      } else if (url.pathname === '/v1/scmRepositories/repository/gitReferences') {
        response = {
          data: [
            {
              id: 'main-ref',
              attributes: { name: 'main', canonicalName: 'refs/heads/main' },
            },
          ],
          links: { next: null },
        };
      } else if (url.pathname === '/v1/ciBuildRuns' && method === 'POST') {
        response = { data: { id: 'build-run', attributes: { number: 35 } } };
      } else {
        return new Response('not found', { status: 404 });
      }
      return Response.json(response);
    };

    try {
      await main();
    } finally {
      globalThis.fetch = previousFetch;
      for (const [name, value] of previousEnvironment) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }

    const createWorkflow = requests.find(
      ({ path, method }) => path === '/v1/ciWorkflows' && method === 'POST',
    );
    expect(createWorkflow?.body.data.attributes.actions[0].buildDistributionAudience).toBe(
      'APP_STORE_ELIGIBLE',
    );
    expect(requests.at(-1)?.body).toEqual(createBuildRunPayload('production-workflow', 'main-ref'));
  });

  test('associates main with an existing production workflow before starting it', async () => {
    const environmentNames = [
      'ASC_ISSUER_ID',
      'ASC_KEY_ID',
      'ASC_PRIVATE_KEY',
      'APP_STORE_APP_ID',
      'XCODE_CLOUD_WORKFLOW_NAME',
      'XCODE_CLOUD_BRANCH_NAME',
      'XCODE_CLOUD_GIT_REF_NAME',
      'XCODE_CLOUD_EXPECTED_COMMIT_SHA',
      'XCODE_CLOUD_TEMPLATE_WORKFLOW_ID',
      'XCODE_CLOUD_WORKFLOW_ID',
      'XCODE_CLOUD_BRANCH_REF_ID',
      'GITHUB_OUTPUT',
    ];
    const previousEnvironment = new Map(environmentNames.map((name) => [name, process.env[name]] as const));
    const previousFetch = globalThis.fetch;
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const requests: Array<{ path: string; method: string; body?: unknown }> = [];

    Object.assign(process.env, {
      ASC_ISSUER_ID: 'issuer',
      ASC_KEY_ID: 'key',
      ASC_PRIVATE_KEY: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
      APP_STORE_APP_ID: 'app',
      XCODE_CLOUD_WORKFLOW_NAME: 'Production App Store',
      XCODE_CLOUD_BRANCH_NAME: 'main',
      XCODE_CLOUD_GIT_REF_NAME: 'refs/heads/main',
      XCODE_CLOUD_TEMPLATE_WORKFLOW_ID: 'staging-workflow',
    });
    delete process.env.XCODE_CLOUD_WORKFLOW_ID;
    delete process.env.XCODE_CLOUD_BRANCH_REF_ID;
    delete process.env.GITHUB_OUTPUT;

    globalThis.fetch = async (input, init) => {
      const url = new URL(String(input));
      const method = init?.method ?? 'GET';
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
      requests.push({ path: `${url.pathname}${url.search}`, method, body });

      if (url.pathname === '/v1/apps/app/ciProduct') {
        return Response.json({ data: { id: 'product' } });
      }
      if (url.pathname === '/v1/ciProducts/product/workflows') {
        return Response.json({
          data: [
            {
              id: 'production-workflow',
              attributes: {
                name: 'Production App Store',
                manualBranchStartCondition: null,
              },
            },
          ],
          links: { next: null },
        });
      }
      if (url.pathname === '/v1/ciWorkflows/production-workflow/repository') {
        return Response.json({ data: { id: 'repository' } });
      }
      if (url.pathname === '/v1/scmRepositories/repository/gitReferences') {
        return Response.json({
          data: [
            {
              id: 'main-ref',
              attributes: { name: 'main', canonicalName: 'refs/heads/main' },
            },
          ],
          links: { next: null },
        });
      }
      if (url.pathname === '/v1/ciWorkflows/production-workflow' && method === 'PATCH') {
        return Response.json({
          data: {
            id: 'production-workflow',
            attributes: {
              name: 'Production App Store',
              manualBranchStartCondition: body.data.attributes.manualBranchStartCondition,
            },
          },
        });
      }
      if (url.pathname === '/v1/ciBuildRuns' && method === 'POST') {
        return Response.json({ data: { id: 'build-run', attributes: { number: 84 } } });
      }
      return new Response('not found', { status: 404 });
    };

    try {
      await main();
    } finally {
      globalThis.fetch = previousFetch;
      for (const [name, value] of previousEnvironment) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }

    const updateWorkflow = requests.find(
      ({ path, method }) => path === '/v1/ciWorkflows/production-workflow' && method === 'PATCH',
    );
    expect(updateWorkflow?.body).toEqual(
      createManualBranchConditionUpdatePayload('production-workflow', undefined, 'main'),
    );
    expect(requests.at(-1)?.body).toEqual(createBuildRunPayload('production-workflow', 'main-ref'));
  });

  test('associates an immutable release tag with the production workflow before starting it', async () => {
    const environmentNames = [
      'ASC_ISSUER_ID',
      'ASC_KEY_ID',
      'ASC_PRIVATE_KEY',
      'APP_STORE_APP_ID',
      'XCODE_CLOUD_WORKFLOW_NAME',
      'XCODE_CLOUD_BRANCH_NAME',
      'XCODE_CLOUD_GIT_REF_NAME',
      'XCODE_CLOUD_EXPECTED_COMMIT_SHA',
      'XCODE_CLOUD_TEMPLATE_WORKFLOW_ID',
      'XCODE_CLOUD_WORKFLOW_ID',
      'XCODE_CLOUD_BRANCH_REF_ID',
      'GITHUB_OUTPUT',
    ];
    const previousEnvironment = new Map(environmentNames.map((name) => [name, process.env[name]] as const));
    const previousFetch = globalThis.fetch;
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const requests: Array<{ path: string; method: string; body?: unknown }> = [];

    Object.assign(process.env, {
      ASC_ISSUER_ID: 'issuer',
      ASC_KEY_ID: 'key',
      ASC_PRIVATE_KEY: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
      APP_STORE_APP_ID: 'app',
      XCODE_CLOUD_WORKFLOW_NAME: 'Production App Store',
      XCODE_CLOUD_BRANCH_NAME: 'main',
      XCODE_CLOUD_GIT_REF_NAME: 'refs/tags/v0.9.0',
      XCODE_CLOUD_TEMPLATE_WORKFLOW_ID: 'staging-workflow',
    });
    delete process.env.XCODE_CLOUD_WORKFLOW_ID;
    delete process.env.XCODE_CLOUD_BRANCH_REF_ID;
    delete process.env.GITHUB_OUTPUT;

    globalThis.fetch = async (input, init) => {
      const url = new URL(String(input));
      const method = init?.method ?? 'GET';
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
      requests.push({ path: `${url.pathname}${url.search}`, method, body });

      if (url.pathname === '/v1/apps/app/ciProduct') {
        return Response.json({ data: { id: 'product' } });
      }
      if (url.pathname === '/v1/ciProducts/product/workflows') {
        return Response.json({
          data: [
            {
              id: 'production-workflow',
              attributes: {
                name: 'Production App Store',
                manualTagStartCondition: null,
              },
            },
          ],
          links: { next: null },
        });
      }
      if (url.pathname === '/v1/ciWorkflows/production-workflow/repository') {
        return Response.json({ data: { id: 'repository' } });
      }
      if (url.pathname === '/v1/scmRepositories/repository/gitReferences') {
        return Response.json({
          data: [
            {
              id: 'release-ref',
              attributes: { name: 'v0.9.0', canonicalName: 'refs/tags/v0.9.0' },
            },
          ],
          links: { next: null },
        });
      }
      if (url.pathname === '/v1/ciWorkflows/production-workflow' && method === 'PATCH') {
        return Response.json({
          data: {
            id: 'production-workflow',
            attributes: {
              name: 'Production App Store',
              manualTagStartCondition: body.data.attributes.manualTagStartCondition,
            },
          },
        });
      }
      if (url.pathname === '/v1/ciBuildRuns' && method === 'POST') {
        return Response.json({ data: { id: 'build-run', attributes: { number: 83 } } });
      }
      return new Response('not found', { status: 404 });
    };

    try {
      await main();
    } finally {
      globalThis.fetch = previousFetch;
      for (const [name, value] of previousEnvironment) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }

    const updateWorkflow = requests.find(
      ({ path, method }) => path === '/v1/ciWorkflows/production-workflow' && method === 'PATCH',
    );
    expect(updateWorkflow?.body).toEqual(
      createManualTagConditionUpdatePayload('production-workflow', undefined, 'v0.9.0'),
    );
    expect(requests.at(-1)?.body).toEqual(createBuildRunPayload('production-workflow', 'release-ref'));
  });

  test('follows absolute pagination links and returns every discovery result', async () => {
    const requests: string[] = [];
    const pages = new Map([
      [
        '/v1/ciProducts/product/workflows?limit=200',
        {
          data: [{ id: 'first', attributes: { name: 'Staging TestFlight' } }],
          links: {
            next: 'https://api.appstoreconnect.apple.com/v1/ciProducts/product/workflows?limit=200&cursor=next',
          },
        },
      ],
      [
        '/v1/ciProducts/product/workflows?limit=200&cursor=next',
        {
          data: [{ id: 'second', attributes: { name: 'Production App Store' } }],
          links: { next: null },
        },
      ],
    ]);

    const results = await collectAppStoreConnectPages(
      '/v1/ciProducts/product/workflows?limit=200',
      async (path: string) => {
        requests.push(path);
        return pages.get(path);
      },
    );

    expect(requests).toEqual([
      '/v1/ciProducts/product/workflows?limit=200',
      '/v1/ciProducts/product/workflows?limit=200&cursor=next',
    ]);
    expect(results.map(({ id }) => id)).toEqual(['first', 'second']);
  });

  test('waits for a newly pinned immutable tag to reach Xcode Cloud', async () => {
    let reads = 0;
    const delays: number[] = [];
    const reference = await resolveGitReferenceWithPropagation(
      'repository',
      'refs/tags/ios-staging-abc',
      async () => {
        reads += 1;
        return {
          data:
            reads === 3
              ? [
                  {
                    id: 'tag-ref',
                    attributes: {
                      name: 'ios-staging-abc',
                      canonicalName: 'refs/tags/ios-staging-abc',
                    },
                  },
                ]
              : [],
          links: { next: null },
        };
      },
      {
        attempts: 3,
        delayMilliseconds: 25,
        sleep: async (milliseconds) => {
          delays.push(milliseconds);
        },
      },
    );

    expect(reference.id).toBe('tag-ref');
    expect(reads).toBe(3);
    expect(delays).toEqual([25, 25]);
    await expect(
      resolveGitReferenceWithPropagation(
        'repository',
        'refs/tags/missing',
        async () => ({
          data: [],
          links: { next: null },
        }),
        { attempts: 0 },
      ),
    ).rejects.toThrow('attempts must be a positive integer');
  });

  test('rejects pagination cycles and unexpected origins', async () => {
    await expect(
      collectAppStoreConnectPages('/v1/workflows', async () => ({
        data: [],
        links: { next: '/v1/workflows' },
      })),
    ).rejects.toThrow('App Store Connect pagination repeated a page');

    await expect(
      collectAppStoreConnectPages('/v1/workflows', async () => ({
        data: [],
        links: { next: 'https://example.com/v1/workflows' },
      })),
    ).rejects.toThrow('App Store Connect pagination returned an unexpected origin');
  });
});
