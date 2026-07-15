import { describe, expect, test } from 'bun:test';
import {
  areaMcpArtifactId,
  areaMcpExternalId,
  mcpAreaTargetDecision,
} from '../lib/albatross/area-mcp-identity';

describe('connection-scoped MCP Area identity', () => {
  test('keeps identical external IDs distinct across connections and recoverable', () => {
    expect(areaMcpArtifactId('github_one', 'issue:42')).toBe('github_one:issue:42');
    expect(areaMcpArtifactId('github_two', 'issue:42')).toBe('github_two:issue:42');
    expect(areaMcpExternalId('github_one:issue:42', 'github_one')).toBe('issue:42');
    expect(areaMcpExternalId('legacy-external-id')).toBe('legacy-external-id');
  });

  test('clears a rejected Area target and does not restore it during resync', () => {
    expect(
      mcpAreaTargetDecision({
        matchedAreaId: 'area_albatross',
        existingTargetKind: 'area',
        existingTargetId: 'area_albatross',
        rejectedAreaIds: ['area_albatross'],
      }),
    ).toEqual({ contradicted: true, patch: { targetKind: undefined, targetId: undefined } });
  });

  test('assigns new matches and preserves unrelated existing targets', () => {
    expect(mcpAreaTargetDecision({ matchedAreaId: 'area_one', rejectedAreaIds: [] })).toEqual({
      contradicted: false,
      patch: { targetKind: 'area', targetId: 'area_one' },
    });
    expect(
      mcpAreaTargetDecision({
        matchedAreaId: 'area_one',
        existingTargetKind: 'project',
        existingTargetId: 'project_one',
        rejectedAreaIds: [],
      }),
    ).toEqual({ contradicted: false, patch: { targetKind: 'project', targetId: 'project_one' } });
  });
});
