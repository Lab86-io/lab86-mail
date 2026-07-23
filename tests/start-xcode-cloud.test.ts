import { describe, expect, test } from 'bun:test';
import { generateKeyPairSync } from 'node:crypto';
import {
  collectAppStoreConnectPages,
  createBuildRunPayload,
  createProductionWorkflowPayload,
  hasExplicitBuildTarget,
  main,
  selectBranchRefID,
  selectWorkflowID,
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
    expect(() => selectBranchRefID([], 'main')).toThrow('Xcode Cloud branch "main" was not found.');
    expect(() => hasExplicitBuildTarget('workflow', undefined)).toThrow(
      'XCODE_CLOUD_WORKFLOW_ID and XCODE_CLOUD_BRANCH_REF_ID must be provided together.',
    );
    expect(() => hasExplicitBuildTarget(undefined, 'branch')).toThrow(
      'XCODE_CLOUD_WORKFLOW_ID and XCODE_CLOUD_BRANCH_REF_ID must be provided together.',
    );
    expect(hasExplicitBuildTarget(undefined, undefined)).toBe(false);
    expect(hasExplicitBuildTarget('workflow', 'branch')).toBe(true);
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
        response = { data: { id: 'production-workflow' } };
      } else if (url.pathname === '/v1/ciWorkflows/production-workflow/repository') {
        response = { data: { id: 'repository' } };
      } else if (url.pathname === '/v1/scmRepositories/repository/gitReferences') {
        response = {
          data: [{ id: 'main-ref', attributes: { name: 'main' } }],
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
