export type AreaStatus = 'active' | 'archived';
export type AreaFactStatus = 'candidate' | 'verified' | 'rejected' | 'superseded';
export type AreaArtifactLinkStatus = 'candidate' | 'verified' | 'rejected';

export interface AlbatrossSourceRef {
  kind: string;
  id: string;
  label?: string;
  accountId?: string;
  url?: string;
}

export interface AlbatrossConfirmationRef {
  kind: string;
  id: string;
  confirmedAt: number;
  confirmedBy?: string;
  prompt?: string;
  sourceRefId?: string;
}

export const SENSITIVE_FACT_KINDS = new Set([
  'person',
  'people',
  'person_relationship',
  'job',
  'role',
  'relationship',
  'location',
  'finance',
  'financial',
  'health',
  'medical',
  'organization',
  'company',
]);

export function normalizeText(value: string, fallback = ''): string {
  return value.trim().replace(/\s+/g, ' ') || fallback;
}

export function isSensitiveFactKind(kind: string): boolean {
  const normalized = kind.trim().toLowerCase();
  if (SENSITIVE_FACT_KINDS.has(normalized)) return true;
  return [...SENSITIVE_FACT_KINDS].some((sensitive) => normalized.includes(sensitive));
}

export function hasUserConfirmation(refs: AlbatrossConfirmationRef[]): boolean {
  return refs.some((ref) => ref.kind === 'userConfirmation' && Number.isFinite(ref.confirmedAt));
}

export function assertVerifiedFactAllowed(input: {
  kind: string;
  status: AreaFactStatus;
  confirmationRefs: AlbatrossConfirmationRef[];
}) {
  if (input.status !== 'verified') return;
  if (!input.confirmationRefs.length) {
    throw new Error('Verified area facts require confirmation refs.');
  }
  if (isSensitiveFactKind(input.kind) && !hasUserConfirmation(input.confirmationRefs)) {
    throw new Error('Sensitive area facts require explicit user confirmation.');
  }
  if (!hasUserConfirmation(input.confirmationRefs)) {
    throw new Error('Verified area facts require explicit user confirmation.');
  }
}

export function assertFactTransitionAllowed(current: AreaFactStatus, next: AreaFactStatus) {
  if (current === next) return;
  const allowed =
    (current === 'candidate' && (next === 'verified' || next === 'rejected')) ||
    (current === 'verified' && next === 'superseded');
  if (!allowed) {
    throw new Error(`Invalid area fact transition: ${current} -> ${next}.`);
  }
}

export function normalizeSourceRefs(refs: AlbatrossSourceRef[] | undefined): AlbatrossSourceRef[] {
  return (refs || [])
    .map((ref) => ({
      kind: normalizeText(ref.kind),
      id: normalizeText(ref.id),
      label: ref.label ? normalizeText(ref.label) : undefined,
      accountId: ref.accountId ? normalizeText(ref.accountId) : undefined,
      url: ref.url ? normalizeText(ref.url) : undefined,
    }))
    .filter((ref) => ref.kind && ref.id)
    .slice(0, 20);
}

export function normalizeConfirmationRefs(
  refs: AlbatrossConfirmationRef[] | undefined,
): AlbatrossConfirmationRef[] {
  return (refs || [])
    .map((ref) => ({
      kind: normalizeText(ref.kind),
      id: normalizeText(ref.id),
      confirmedAt: ref.confirmedAt,
      confirmedBy: ref.confirmedBy ? normalizeText(ref.confirmedBy) : undefined,
      prompt: ref.prompt ? normalizeText(ref.prompt).slice(0, 500) : undefined,
      sourceRefId: ref.sourceRefId ? normalizeText(ref.sourceRefId) : undefined,
    }))
    .filter((ref) => ref.kind && ref.id && Number.isFinite(ref.confirmedAt))
    .slice(0, 20);
}
