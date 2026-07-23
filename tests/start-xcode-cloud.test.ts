import { describe, expect, test } from 'bun:test';
import {
  collectAppStoreConnectPages,
  createBuildRunPayload,
  createProductionWorkflowPayload,
  hasExplicitBuildTarget,
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
