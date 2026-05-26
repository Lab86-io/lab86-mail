import { randomUUID } from 'node:crypto';
import { DEVOPS_LABEL_ID } from '../mail/smart-categories';
import type { SmartLabelDefinition } from '../shared/types';
import { db, findMany, findOne, upsert } from './db';

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
  color: '#0b7285',
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

export async function ensureSeedSmartLabels() {
  const existing = await findOne<SmartLabelDefinition>(db().smartLabels, { _id: DEVOPS_LABEL_ID });
  const ts = now();
  const seeded = {
    ...DEVOPS_LABEL,
    createdAt: existing?.createdAt || ts,
    updatedAt: existing?.updatedAt || ts,
  };
  await upsert(db().smartLabels, { _id: DEVOPS_LABEL_ID }, seeded);
}

export async function listSmartLabels(includeDisabled = false) {
  await ensureSeedSmartLabels();
  const query = includeDisabled ? {} : { enabled: true };
  return await findMany<SmartLabelDefinition>(db().smartLabels, query, { sort: { createdAt: 1 } });
}

export async function getSmartLabel(id: string) {
  await ensureSeedSmartLabels();
  return await findOne<SmartLabelDefinition>(db().smartLabels, { _id: id });
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
  if (!input.positiveExamples.filter(Boolean).length)
    throw new Error('At least one positive example is required');
  if (!input.negativeExamples.filter(Boolean).length)
    throw new Error('At least one negative example is required');
  const label: SmartLabelDefinition = {
    _id: randomUUID(),
    name,
    slug,
    description: input.description.trim(),
    enabled: true,
    sidebarVisible: input.sidebarVisible ?? true,
    gmailLabelName: `MailOS/${name}`,
    aiMode: 'metadata_snippet',
    positiveExamples: input.positiveExamples.map((v) => v.trim()).filter(Boolean),
    negativeExamples: input.negativeExamples.map((v) => v.trim()).filter(Boolean),
    candidateQuery: 'newer_than:90d',
    createdBy: input.createdBy || 'user',
    createdAt: ts,
    updatedAt: ts,
  };
  await upsert(db().smartLabels, { _id: label._id }, label);
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
  const next: SmartLabelDefinition = {
    ...existing,
    ...patch,
    name: patch.name?.trim() || existing.name,
    slug: patch.name ? slugify(patch.name) : existing.slug,
    gmailLabelName: patch.name ? `MailOS/${patch.name.trim()}` : existing.gmailLabelName,
    positiveExamples:
      patch.positiveExamples?.map((v) => v.trim()).filter(Boolean) || existing.positiveExamples,
    negativeExamples:
      patch.negativeExamples?.map((v) => v.trim()).filter(Boolean) || existing.negativeExamples,
    updatedAt: now(),
  };
  if (!next.positiveExamples.length) throw new Error('At least one positive example is required');
  if (!next.negativeExamples.length) throw new Error('At least one negative example is required');
  await upsert(db().smartLabels, { _id: id }, next);
  return next;
}

export async function disableSmartLabel(id: string) {
  const existing = await getSmartLabel(id);
  if (!existing) throw new Error('Smart label not found');
  const next = { ...existing, enabled: false, updatedAt: now() };
  await upsert(db().smartLabels, { _id: id }, next);
  return next;
}
