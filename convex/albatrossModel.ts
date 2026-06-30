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

const REF_KIND_MAX = 80;
const REF_ID_MAX = 200;
const REF_LABEL_MAX = 200;
const REF_ACCOUNT_ID_MAX = 120;
const REF_URL_MAX = 500;
const REF_CONFIRMED_BY_MAX = 120;
const REF_PROMPT_MAX = 500;
const REF_SOURCE_ID_MAX = 200;

export function normalizeText(value: string, fallback = ''): string {
  return value.trim().replace(/\s+/g, ' ') || fallback;
}

function boundedText(value: string, max: number, fallback = ''): string {
  return normalizeText(value, fallback).slice(0, max);
}

function optionalBoundedText(value: string | undefined, max: number): string | undefined {
  if (!value) return undefined;
  return boundedText(value, max) || undefined;
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

export function assertVerifiedArtifactLinkAllowed(
  status: AreaArtifactLinkStatus,
  confirmationRefs: AlbatrossConfirmationRef[],
) {
  if (status !== 'verified') return;
  if (!hasUserConfirmation(confirmationRefs)) {
    throw new Error('Verified area artifact links require explicit user confirmation.');
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
      kind: boundedText(ref.kind, REF_KIND_MAX),
      id: boundedText(ref.id, REF_ID_MAX),
      label: optionalBoundedText(ref.label, REF_LABEL_MAX),
      accountId: optionalBoundedText(ref.accountId, REF_ACCOUNT_ID_MAX),
      url: optionalBoundedText(ref.url, REF_URL_MAX),
    }))
    .filter((ref) => ref.kind && ref.id)
    .slice(0, 20);
}

export function normalizeConfirmationRefs(
  refs: AlbatrossConfirmationRef[] | undefined,
): AlbatrossConfirmationRef[] {
  return (refs || [])
    .map((ref) => ({
      kind: boundedText(ref.kind, REF_KIND_MAX),
      id: boundedText(ref.id, REF_ID_MAX),
      confirmedAt: ref.confirmedAt,
      confirmedBy: optionalBoundedText(ref.confirmedBy, REF_CONFIRMED_BY_MAX),
      prompt: optionalBoundedText(ref.prompt, REF_PROMPT_MAX),
      sourceRefId: optionalBoundedText(ref.sourceRefId, REF_SOURCE_ID_MAX),
    }))
    .filter((ref) => ref.kind && ref.id && Number.isFinite(ref.confirmedAt))
    .slice(0, 20);
}
