import { randomUUID } from 'node:crypto';
import { generateTextForCurrentUser } from '../ai/gateway';
import { DEVOPS_LABEL_ID } from '../mail/smart-categories';
import type { SmartLabelDefinition } from '../shared/types';
import { kvCreateIfAbsent, kvDelete, kvGet, kvList, kvUpsert, requireStoreUserId } from './kv';

const now = () => Date.now();

export const DEVOPS_LABEL: SmartLabelDefinition = {
  _id: DEVOPS_LABEL_ID,
  name: 'Dev/Ops',
  slug: 'dev-ops',
  description:
    'Technical and platform operational mail, including TestFlight, App Store Connect, GitHub, Vercel, Railway, build/deploy/account notices, developer newsletters, product updates, changelogs, and docs digests.',
  enabled: true,
  sidebarVisible: true,
  icon: 'terminal',
  color: 'var(--color-accent)',
  gmailLabelName: 'MailOS/Dev/Ops',
  aiMode: 'metadata_snippet',
  positiveExamples: [
    'TestFlight build available to test',
    'App Store Connect review status',
    'GitHub issue or pull request notification',
    'Vercel or Railway deployment notice',
    'Developer changelog or product update',
  ],
  negativeExamples: [
    'Personal email from a human friend',
    'Shopping promotion',
    'Rewards program offer',
    'News publisher article',
    'Bank bill or tax notice',
  ],
  candidateQuery: 'newer_than:90d',
  createdBy: 'system',
  createdAt: 0,
  updatedAt: 0,
};

function slugify(value: string) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

// Seed writes are idempotent in Convex; this only avoids repeated read/upsert
// overhead while a long-running server process handles the same user.
const seededUsers = new Set<string>();

interface SmartLabelSlugIndex {
  _id: string;
  slug: string;
  labelId: string;
  createdAt: number;
}

async function writeSlugIndex(slug: string, labelId: string) {
  return await kvCreateIfAbsent<SmartLabelSlugIndex>(
    'smartLabelSlug',
    slug,
    { _id: slug, slug, labelId, createdAt: now() },
    slug,
  );
}

async function reserveSlug(slug: string, labelId: string) {
  const slugTaken = await findBySlug(slug);
  if (slugTaken && slugTaken._id !== labelId) {
    throw new Error(`A smart label named "${slugTaken.name}" already exists.`);
  }
  const reservation = await writeSlugIndex(slug, labelId);
  if (!reservation.created && reservation.doc.labelId !== labelId) {
    const owner = await kvGet<SmartLabelDefinition>('smartLabel', reservation.doc.labelId);
    throw new Error(`A smart label named "${owner?.name || slug}" already exists.`);
  }
}

export async function ensureSeedSmartLabels() {
  const userId = requireStoreUserId();
  if (seededUsers.has(userId)) return;
  const existing = await kvGet<SmartLabelDefinition>('smartLabel', DEVOPS_LABEL_ID);
  const ts = now();
  // Dev/Ops is no longer seeded by default — labels are the user's own.
  // Users who already have it keep it (normalized); deleting it sticks.
  if (existing) {
    const seeded: SmartLabelDefinition = {
      ...DEVOPS_LABEL,
      ...existing,
      createdAt: existing.createdAt || ts,
      updatedAt: existing.updatedAt || ts,
    };
    const changed = Object.keys(seeded).some(
      (key) =>
        JSON.stringify(seeded[key as keyof SmartLabelDefinition]) !==
        JSON.stringify(existing[key as keyof SmartLabelDefinition]),
    );
    if (changed) await kvUpsert('smartLabel', DEVOPS_LABEL_ID, seeded);
    await writeSlugIndex(DEVOPS_LABEL.slug, DEVOPS_LABEL_ID);
  }
  seededUsers.add(userId);
}

export async function listSmartLabels(includeDisabled = false) {
  await ensureSeedSmartLabels();
  const labels = await kvList<SmartLabelDefinition>('smartLabel', { limit: 500 });
  const filtered = includeDisabled ? labels : labels.filter((label) => label.enabled);
  filtered.sort((a, b) => a.createdAt - b.createdAt);
  return filtered;
}

export async function getSmartLabel(id: string) {
  await ensureSeedSmartLabels();
  return await kvGet<SmartLabelDefinition>('smartLabel', id);
}

async function findBySlug(slug: string) {
  await ensureSeedSmartLabels();
  const labels = await kvList<SmartLabelDefinition>('smartLabel', { limit: 500 });
  return labels.find((label) => label.slug === slug) || null;
}

// Animated lucide icons vendored under components/ui — the model picks the
// best fit for a new label; anything unrecognized falls back to bookmark.
export const SMART_LABEL_ICONS = [
  'bell',
  'bookmark',
  'flame',
  'layers',
  'calendar-days',
  'send',
  'square-pen',
  'archive',
  'alarm-clock',
  'key',
  'receipt',
  'credit-card',
  'user',
  'users',
  'file-text',
  'message-circle',
  'gauge',
  'history',
  'layout-grid',
  'mail-check',
  'terminal',
] as const;

async function pickLabelIcon(name: string, description: string): Promise<string> {
  try {
    const result = await generateTextForCurrentUser({
      feature: 'smart_label_icon',
      speed: 'fast',
      prompt: `Pick the single best icon name for an email label called "${name}" (${description.slice(0, 200)}). Answer with EXACTLY one name from this list and nothing else: ${SMART_LABEL_ICONS.join(', ')}`,
    });
    const picked = (result.text || '')
      .trim()
      .toLowerCase()
      .replace(/[^a-z-]/g, '');
    if ((SMART_LABEL_ICONS as readonly string[]).includes(picked)) return picked;
  } catch {
    // No AI available (or it rambled) — fall through to the default.
  }
  return 'bookmark';
}

export async function createSmartLabel(input: {
  name: string;
  description: string;
  positiveExamples: string[];
  negativeExamples: string[];
  sidebarVisible?: boolean;
  createdBy?: SmartLabelDefinition['createdBy'];
}) {
  const ts = now();
  const name = input.name.trim();
  const slug = slugify(name);
  if (!name || !slug) throw new Error('Smart label name is required');
  if (!input.description.trim()) throw new Error('Smart label description is required');
  const positiveExamples = input.positiveExamples.map((v) => v.trim()).filter(Boolean);
  const negativeExamples = input.negativeExamples.map((v) => v.trim()).filter(Boolean);
  if (!positiveExamples.length) throw new Error('At least one positive example is required');
  if (!negativeExamples.length) throw new Error('At least one negative example is required');
  const labelId = randomUUID();
  await reserveSlug(slug, labelId);
  const icon = await pickLabelIcon(name, input.description);
  const label: SmartLabelDefinition = {
    _id: labelId,
    name,
    slug,
    description: input.description.trim(),
    icon,
    enabled: true,
    sidebarVisible: input.sidebarVisible ?? true,
    gmailLabelName: `MailOS/${name}`,
    aiMode: 'metadata_snippet',
    positiveExamples,
    negativeExamples,
    candidateQuery: 'newer_than:90d',
    createdBy: input.createdBy || 'user',
    createdAt: ts,
    updatedAt: ts,
  };
  try {
    await kvUpsert('smartLabel', label._id, label);
  } catch (err) {
    await kvDelete('smartLabelSlug', slug).catch(() => undefined);
    throw err;
  }
  return label;
}

export async function updateSmartLabel(
  id: string,
  patch: Partial<
    Pick<
      SmartLabelDefinition,
      'name' | 'description' | 'positiveExamples' | 'negativeExamples' | 'enabled' | 'sidebarVisible'
    >
  >,
) {
  const existing = await getSmartLabel(id);
  if (!existing) throw new Error('Smart label not found');
  const trimmedName = patch.name === undefined ? undefined : patch.name.trim();
  if (trimmedName !== undefined && !trimmedName) throw new Error('Smart label name is required');
  const nextSlug = trimmedName ? slugify(trimmedName) : existing.slug;
  if (trimmedName && nextSlug !== existing.slug) {
    await reserveSlug(nextSlug, id);
  }
  const next: SmartLabelDefinition = {
    ...existing,
    ...patch,
    name: trimmedName || existing.name,
    slug: nextSlug,
    gmailLabelName: trimmedName ? `MailOS/${trimmedName}` : existing.gmailLabelName,
    positiveExamples:
      patch.positiveExamples?.map((v) => v.trim()).filter(Boolean) || existing.positiveExamples,
    negativeExamples:
      patch.negativeExamples?.map((v) => v.trim()).filter(Boolean) || existing.negativeExamples,
    updatedAt: now(),
  };
  if (!next.positiveExamples.length) throw new Error('At least one positive example is required');
  if (!next.negativeExamples.length) throw new Error('At least one negative example is required');
  await kvUpsert('smartLabel', id, next);
  if (nextSlug !== existing.slug) {
    const oldReservation = await kvGet<SmartLabelSlugIndex>('smartLabelSlug', existing.slug);
    if (oldReservation?.labelId === id) await kvDelete('smartLabelSlug', existing.slug);
  }
  return next;
}

export async function disableSmartLabel(id: string) {
  const existing = await getSmartLabel(id);
  if (!existing) throw new Error('Smart label not found');
  const next = { ...existing, enabled: false, updatedAt: now() };
  await kvUpsert('smartLabel', id, next);
  return next;
}
