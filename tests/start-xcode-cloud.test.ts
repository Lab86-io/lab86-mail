import { describe, expect, test } from 'bun:test';
import {
  createBuildRunPayload,
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
});
