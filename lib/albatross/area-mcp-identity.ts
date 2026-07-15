const MAX_ARTIFACT_ID_LENGTH = 500;

function stableIdentityHash(value: string): string {
  let a = 0x9e3779b9;
  let b = 0x243f6a88;
  let c = 0xb7e15162;
  let d = 0xdeadbeef;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    a = Math.imul(a ^ code, 2_654_435_761);
    b = Math.imul(b ^ code, 1_597_334_677);
    c = Math.imul(c ^ code, 2_246_822_519);
    d = Math.imul(d ^ code, 3_266_489_917);
  }
  return [a, b, c, d].map((part) => (part >>> 0).toString(16).padStart(8, '0')).join('');
}

export function areaMcpArtifactId(connectionId: string, externalId: string): string {
  const identity = `${connectionId}:${externalId}`;
  if (identity.length <= MAX_ARTIFACT_ID_LENGTH) return identity;
  const suffix = `:${stableIdentityHash(identity)}`;
  return `${identity.slice(0, MAX_ARTIFACT_ID_LENGTH - suffix.length)}${suffix}`;
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
