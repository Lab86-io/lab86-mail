// The secure store on the Next server (docs/albatross-secure-store.md).
//
// Only this module and the runner's resolver open sealed values, and only at
// the moment of use. Every function that returns to a client returns
// SecureItemView: a label, sites, masked hints, and plain facts, never a value.

import { api, convexMutation, convexQuery } from '../hosted/convex';
import type {
  SecureItemCreate,
  SecureItemKind,
  SecureItemUpdate,
  SecureItemView,
  SecureUseOutcome,
  SecureUseView,
} from './contract';
import { SECURE_ITEM_KINDS } from './contract';
import { newSecureItemId, openSecureValues, type SealedItem, sealSecureValues } from './crypto';
import { secureStoreEnabledFor } from './flag';
import {
  ageYears,
  kindMayAskForSite,
  normalizeSites,
  type ParsedSecureItem,
  parseSecureItem,
  SECURE_ITEMS_MAX,
  SecurePolicyError,
  secureHints,
} from './policy';

/** The calls the store makes; tests replace them. */
export const secureStoreDeps = {
  query: convexQuery,
  mutation: convexMutation,
  enabled: secureStoreEnabledFor,
  newId: newSecureItemId,
  now: () => Date.now(),
};

export class SecureStoreError extends Error {
  constructor(
    readonly code: 'off' | 'not_found' | 'verify_identity' | 'limit',
    message: string,
  ) {
    super(message);
    this.name = 'SecureStoreError';
  }
}

interface ItemRow {
  itemId: string;
  kind: SecureItemKind;
  label: string;
  sites: string[];
  hints: Array<{ field: string; hint: string }>;
  facts: Array<{ name: string; value: string }>;
  createdAt: number;
  updatedAt: number;
  lastUsedAt: number | null;
}

export type SealedRow = ItemRow & SealedItem;

export function itemViewFromRow(row: ItemRow): SecureItemView {
  return {
    id: row.itemId,
    kind: row.kind,
    label: row.label,
    sites: row.sites,
    hints: Object.fromEntries(row.hints.map((entry) => [entry.field, entry.hint])),
    facts: Object.fromEntries(row.facts.map((entry) => [entry.name, entry.value])),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    lastUsedAt: row.lastUsedAt ?? null,
  };
}

function requireEnabled(userId: string) {
  if (!secureStoreDeps.enabled(userId))
    throw new SecureStoreError('off', 'Passwords and IDs is not available for this account.');
}

function shownOf(parsed: ParsedSecureItem) {
  return {
    hints: Object.entries(secureHints(parsed.kind, parsed.values)).map(([field, hint]) => ({ field, hint })),
    facts: Object.entries(parsed.facts).map(([name, value]) => ({ name, value })),
  };
}

function binding(userId: string, row: { itemId: string; kind: string }) {
  return { userId, itemId: row.itemId, kind: row.kind };
}

/** True when the store works for this user. */
export function secureStoreEnabled(userId: string) {
  return secureStoreDeps.enabled(userId);
}

export async function listSecureItems(userId: string): Promise<SecureItemView[]> {
  requireEnabled(userId);
  const rows = await secureStoreDeps.query<ItemRow[]>(api.secureDetails.listItems, { userId });
  return rows.map(itemViewFromRow).sort((a, b) => a.label.localeCompare(b.label));
}

async function sealedRows(userId: string): Promise<SealedRow[]> {
  return secureStoreDeps.query<SealedRow[]>(api.secureDetails.listSealed, { userId });
}

async function sealedRow(userId: string, itemId: string): Promise<SealedRow> {
  const row = (await sealedRows(userId)).find((entry) => entry.itemId === itemId);
  if (!row) throw new SecureStoreError('not_found', 'This item is not saved any more.');
  return row;
}

/** Add an item. The sites are the item's own; no identity check is needed for them. */
export async function createSecureItem(userId: string, input: SecureItemCreate): Promise<SecureItemView> {
  requireEnabled(userId);
  if (!(SECURE_ITEM_KINDS as readonly string[]).includes(input.kind))
    throw new SecurePolicyError('invalid', 'Choose what to save.');
  const parsed = parseSecureItem({
    kind: input.kind,
    label: input.label,
    values: input.values || {},
    now: secureStoreDeps.now(),
  });
  const sites = normalizeSites(input.sites, input.kind);
  if (!kindMayAskForSite(input.kind) && !sites.length)
    throw new SecurePolicyError(
      'site',
      input.kind === 'api_key'
        ? 'Enter the API address, for example api.openai.com.'
        : 'Enter the site, for example chase.com.',
    );
  const existing = await secureStoreDeps.query<ItemRow[]>(api.secureDetails.listItems, { userId });
  if (input.kind === 'date_of_birth' && existing.some((row) => row.kind === 'date_of_birth'))
    throw new SecureStoreError('limit', 'Your date of birth is saved. Replace it there.');
  if (existing.length >= SECURE_ITEMS_MAX)
    throw new SecureStoreError('limit', `You can keep ${SECURE_ITEMS_MAX} items. Delete one first.`);
  const itemId = secureStoreDeps.newId();
  const sealed = sealSecureValues({ userId, itemId, kind: input.kind }, parsed.values);
  await secureStoreDeps.mutation(api.secureDetails.createItem, {
    userId,
    itemId,
    kind: input.kind,
    label: parsed.label,
    sites,
    ...shownOf(parsed),
    sealed,
  });
  const ts = secureStoreDeps.now();
  return itemViewFromRow({
    itemId,
    kind: input.kind,
    label: parsed.label,
    sites,
    ...shownOf(parsed),
    createdAt: ts,
    updatedAt: ts,
    lastUsedAt: null,
  });
}

/** The values a kind takes from its plain facts when the user replaces only one field. */
function factValues(kind: SecureItemKind, facts: Record<string, string>): Record<string, unknown> {
  if (kind === 'id_number')
    return {
      type: facts.type,
      ...(facts.region ? { region: facts.region } : {}),
      ...(facts.country ? { country: facts.country } : {}),
    };
  if (kind === 'api_key') return facts.header ? { header: facts.header } : {};
  return {};
}

/**
 * Change an item. New values replace only the fields they name (null clears
 * an optional field). A new site needs a recent identity check:
 * `identityChecked` comes from lib/secure/identity.ts.
 */
export async function updateSecureItem(
  userId: string,
  itemId: string,
  input: SecureItemUpdate,
  options: { identityChecked: boolean },
): Promise<SecureItemView> {
  requireEnabled(userId);
  const row = await sealedRow(userId, itemId);
  const kind = row.kind;
  let sites: string[] | undefined;
  if (input.sites) {
    sites = normalizeSites(input.sites, kind);
    if (!kindMayAskForSite(kind) && !sites.length)
      throw new SecurePolicyError('site', 'This item needs at least one site.');
    const added = sites.filter((site) => !row.sites.includes(site));
    if (added.length && !options.identityChecked)
      throw new SecureStoreError(
        'verify_identity',
        'Albatross needs one more check before it adds the site.',
      );
  }
  const label = input.label === undefined ? undefined : input.label;
  let parsed: ParsedSecureItem | null = null;
  if (input.values || label !== undefined) {
    const current = openSecureValues(binding(userId, row), row);
    const merged: Record<string, unknown> = {
      ...factValues(kind, Object.fromEntries(row.facts.map((entry) => [entry.name, entry.value]))),
      ...current,
    };
    for (const [field, value] of Object.entries(input.values || {})) {
      if (value === null) delete merged[field];
      else merged[field] = value;
    }
    parsed = parseSecureItem({ kind, label: label ?? row.label, values: merged, now: secureStoreDeps.now() });
  }
  const sealed = input.values && parsed ? sealSecureValues(binding(userId, row), parsed.values) : undefined;
  await secureStoreDeps.mutation(api.secureDetails.updateItem, {
    userId,
    itemId,
    ...(parsed && label !== undefined ? { label: parsed.label } : {}),
    ...(sites ? { sites } : {}),
    ...(parsed && input.values ? shownOf(parsed) : {}),
    ...(sealed ? { sealed } : {}),
  });
  const shown = parsed && input.values ? shownOf(parsed) : { hints: row.hints, facts: row.facts };
  return itemViewFromRow({
    ...row,
    label: parsed && label !== undefined ? parsed.label : row.label,
    sites: sites ?? row.sites,
    ...shown,
    updatedAt: secureStoreDeps.now(),
  });
}

export async function deleteSecureItem(userId: string, itemId: string): Promise<boolean> {
  requireEnabled(userId);
  const result = await secureStoreDeps.mutation<{ deleted: boolean }>(api.secureDetails.deleteItem, {
    userId,
    itemId,
  });
  return Boolean(result?.deleted);
}

export async function listSecureUses(userId: string, itemId: string): Promise<SecureUseView[]> {
  requireEnabled(userId);
  const rows = await secureStoreDeps.query<
    Array<SecureUseView & { host: string | null; runId: string | null; workTitle: string | null }>
  >(api.secureDetails.listUses, { userId, itemId, limit: 50 });
  return rows.map((row) => ({
    id: row.id,
    itemId: row.itemId,
    field: row.field,
    site: row.site,
    workId: row.workId,
    workTitle: row.workTitle ?? null,
    outcome: row.outcome,
    at: row.at,
  }));
}

export async function recordSecureUse(input: {
  userId: string;
  itemId: string;
  outcome: SecureUseOutcome;
  field?: string;
  site?: string;
  host?: string;
  workId?: string;
  runId?: string;
}) {
  await secureStoreDeps
    .mutation(api.secureDetails.recordUse, {
      userId: input.userId,
      itemId: input.itemId,
      outcome: input.outcome,
      ...(input.field ? { field: input.field } : {}),
      ...(input.site ? { site: input.site } : {}),
      ...(input.host ? { host: input.host } : {}),
      ...(input.workId ? { workId: input.workId } : {}),
      ...(input.runId ? { runId: input.runId } : {}),
    })
    .catch(() => undefined);
}

export interface OpenedItem {
  item: SecureItemView;
  values: Record<string, string>;
}

/** Every item of the user, opened. For a run that types values or scrubs pages. */
export async function openSecureItems(userId: string): Promise<OpenedItem[]> {
  if (!secureStoreDeps.enabled(userId)) return [];
  const rows = await sealedRows(userId);
  const opened: OpenedItem[] = [];
  for (const row of rows) {
    try {
      opened.push({ item: itemViewFromRow(row), values: openSecureValues(binding(userId, row), row) });
    } catch {
      // A row that no configured key opens is left out; the rotation report names it.
    }
  }
  return opened;
}

/** What the model may know about the user's items: no value, and no masked hint. */
export interface SecureInventoryEntry {
  id: string;
  kind: SecureItemKind;
  label: string;
  sites: string[];
  fields: string[];
  idType?: string;
  region?: string;
  country?: string;
  expired?: boolean;
  ageYears?: number;
  header?: string;
}

export async function secureInventory(userId: string): Promise<SecureInventoryEntry[]> {
  if (!secureStoreDeps.enabled(userId)) return [];
  const opened = await openSecureItems(userId);
  const now = secureStoreDeps.now();
  return opened.map(({ item, values }) => {
    const entry: SecureInventoryEntry = {
      id: item.id,
      kind: item.kind,
      label: item.label,
      sites: item.sites,
      fields: Object.keys(values).sort(),
    };
    if (item.facts.type) entry.idType = item.facts.type;
    if (item.facts.region) entry.region = item.facts.region;
    if (item.facts.country) entry.country = item.facts.country;
    if (values.expires) entry.expired = Date.parse(`${values.expires}T23:59:59Z`) < now;
    if (item.kind === 'date_of_birth' && values.date) {
      const age = ageYears(values.date, now);
      if (age !== null) entry.ageYears = age;
    }
    if (item.facts.header) entry.header = item.facts.header;
    return entry;
  });
}
