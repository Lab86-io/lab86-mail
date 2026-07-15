export function areaMcpArtifactId(connectionId: string, externalId: string): string {
  return `${connectionId}:${externalId}`.slice(0, 500);
}

export function areaMcpExternalId(artifactId: string, connectionId?: string): string {
  const prefix = connectionId ? `${connectionId}:` : '';
  return prefix && artifactId.startsWith(prefix) ? artifactId.slice(prefix.length) : artifactId;
}

export function mcpAreaTargetDecision(input: {
  matchedAreaId?: string;
  existingTargetKind?: 'area' | 'project' | 'work' | 'routine';
  existingTargetId?: string;
  rejectedAreaIds: Iterable<string>;
}) {
  const rejected = new Set(input.rejectedAreaIds);
  const contradicted = Boolean(
    (input.matchedAreaId && rejected.has(input.matchedAreaId)) ||
      (input.existingTargetKind === 'area' && input.existingTargetId && rejected.has(input.existingTargetId)),
  );
  if (contradicted) {
    return { contradicted: true, patch: { targetKind: undefined, targetId: undefined } } as const;
  }
  if (input.matchedAreaId && !input.existingTargetKind) {
    return {
      contradicted: false,
      patch: { targetKind: 'area' as const, targetId: input.matchedAreaId },
    };
  }
  if (input.existingTargetKind && input.existingTargetId) {
    return {
      contradicted: false,
      patch: { targetKind: input.existingTargetKind, targetId: input.existingTargetId },
    };
  }
  return { contradicted: false, patch: {} } as const;
}
