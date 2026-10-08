// A run's access to the secure store (docs/albatross-secure-store.md).
//
// The runner model writes `{{secure:<itemId>.<field>}}` in browser_type,
// browser_select, or secure_fetch. This module turns one reference into its
// value at the moment of use, after these checks:
// - the field takes this kind of value (a password goes only into an HTML
//   password field; codes, card data, and new passwords are never typed);
// - the page is https, and the field's own frame and its form's action are on
//   one of the item's sites (or an "Allow once" grant covers the site for this
//   step);
// - an ID or a date on a new site stops the run with an allow_secure handoff;
//   a sign-in or a key on a wrong site is refused.
//
// What the model reads back from a page passes through cleanPage:
// - values of items saved for that page's site, and values this run typed
//   there, are replaced with "[secure: <label>]";
// - values of other items are not looked for at all, so a page cannot test
//   guesses against the store (a replaced guess would tell the model it is
//   right);
// - a value this run typed that shows up on a page outside its sites stops the
//   run (SecureLeak): the model gets at most one bit, and the run ends.
//
// Each use, refusal, and question is a line in the item's use history, and
// the run log says what happened in plain words. No message here holds a
// value: the model sees labels only.

import { api, convexQuery } from '../hosted/convex';
import { SECURE_FIELD_LABELS, SECURE_FIELDS, type SecureAllowRequest } from './contract';
import {
  formatSecureValue,
  kindMayAskForSite,
  referenceLabel,
  SecurePolicyError,
  type SecureReference,
  scrubNeedles,
  siteCovers,
  siteForHost,
} from './policy';
import { SecureScrubber } from './scrub';
import { type OpenedItem, openSecureItems, recordSecureUse } from './store';

/** What a page field accepts, from its type, autocomplete, and accessible name. */
export type SecureFieldKind = 'password' | 'new_password' | 'code' | 'card' | 'ssn' | 'plain';

/** A reference the run may not use here. The message is for the model. */
export class SecureRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SecureRefused';
  }
}

/** An ID or a date on a new site: the run hands off with next.kind allow_secure. */
export class SecureNeedsAllow extends Error {
  constructor(
    readonly request: SecureAllowRequest,
    message: string,
  ) {
    super(message);
    this.name = 'SecureNeedsAllow';
  }
}

/** A value this run typed appeared on a page outside its sites. The run stops. */
export class SecureLeak extends Error {
  constructor(
    readonly itemId: string,
    readonly host: string,
  ) {
    super('A page outside the saved sites showed one of your saved values, so Albatross stopped.');
    this.name = 'SecureLeak';
  }
}

export interface SecureBrowserAccess {
  /**
   * The parts a model may read from a page at this address: saved values of
   * this site and of this run removed. Throws SecureLeak when a value this run
   * typed shows on another site.
   */
  cleanPage(pageUrl: string, parts: readonly string[]): Promise<string[]>;
  /** The value for one reference in one page field, after every check. */
  resolveForField(input: {
    reference: SecureReference;
    fieldUrl: string;
    fieldKind: SecureFieldKind;
    /** The address the field's form sends to, when it has one. */
    formUrl?: string | null;
  }): Promise<{ value: string; label: string }>;
}

export interface SecureRunAccess extends SecureBrowserAccess {
  /** The key for secure_fetch, after the host check. */
  resolveForFetch(input: {
    reference: SecureReference;
    url: string;
  }): Promise<{ value: string; label: string }>;
  /** The text with every value this run used removed (API answers, errors). */
  cleanText(text: string): string;
  /** The newest new-site question of this run, for the allow_secure handoff. */
  pendingAllow(): SecureAllowRequest | null;
  /** The site of a sign-in page with no saved sign-in, for the "save a sign-in" offer. */
  signInOffer(pageUrl: string): Promise<{ site: string } | null>;
}

/** The run log copy. Plain words; no value. */
export const SECURE_LOG = {
  typed: (label: string, host: string) => `Typed your saved ${label} on ${host}.`,
  sent: (label: string, host: string) => `Called ${host} with your saved ${label}.`,
  refused: (label: string, host: string) =>
    `Did not use your saved ${label} on ${host}. It is not saved for that site.`,
  asked: (label: string, site: string) => `Asked you to allow your saved ${label} on ${site}.`,
  leaked: (label: string, host: string) => `Stopped: ${host} showed your saved ${label}. You have the page.`,
};

export const secureRunDeps = {
  openItems: openSecureItems,
  recordUse: recordSecureUse,
  hasGrant: (input: { userId: string; itemId: string; site: string; workId: string; stepKey: string }) =>
    convexQuery<boolean>(api.secureDetails.hasGrant, input),
};

function fieldLabel(field: string) {
  return SECURE_FIELD_LABELS[field] || field;
}

function hostOfUrl(raw: string): string {
  try {
    return new URL(raw).hostname.toLowerCase();
  } catch {
    return '';
  }
}

/** One value this run used: its forms to find, its exact typed forms, and the sites it may show on. */
interface UsedItem {
  label: string;
  needles: string[];
  exact: Set<string>;
  sites: Set<string>;
}

const FIELD_LINE = /^(\s*-\s+(?:textbox|searchbox|combobox|spinbutton)\b[^\n]*?):\s*(.+)$/;
const OPTION_LINE = /^(\s*-\s+option\s+"((?:[^"\\]|\\.)*)")\s*\[selected\]/;

export function createSecureRunAccess(input: {
  userId: string;
  runId: string;
  workId: string;
  stepKey: string;
  log: (line: string) => Promise<void>;
  deps?: Partial<typeof secureRunDeps>;
}): SecureRunAccess {
  const deps = { ...secureRunDeps, ...input.deps };
  let opened: Promise<OpenedItem[]> | null = null;
  let pending: SecureAllowRequest | null = null;
  const once = new Set<string>();
  const used = new Map<string, UsedItem>();

  const items = () => {
    opened ??= deps.openItems(input.userId).catch(() => [] as OpenedItem[]);
    return opened;
  };

  const record = async (
    key: string,
    use: Parameters<typeof recordSecureUse>[0],
    line: string | null,
  ): Promise<void> => {
    if (once.has(key)) return;
    once.add(key);
    await deps.recordUse(use);
    if (line) await input.log(line);
  };

  const use = (entry: OpenedItem, site: string, exact: string, label: string) => {
    const current = used.get(entry.item.id) ?? {
      label: entry.item.label,
      needles: scrubNeedles(entry.item.kind, entry.values, entry.item.facts.type),
      exact: new Set<string>(),
      sites: new Set(entry.item.sites),
    };
    current.sites.add(site);
    current.exact.add(exact);
    used.set(entry.item.id, current);
    void label;
  };

  const find = async (reference: SecureReference) => {
    const entry = (await items()).find((candidate) => candidate.item.id === reference.itemId);
    if (!entry) throw new SecureRefused('No saved item has this id. Call secure_details_list for the ids.');
    const { item, values } = entry;
    if (!SECURE_FIELDS[item.kind].includes(reference.field))
      throw new SecureRefused(
        `${item.label} has no field "${reference.field}". Its fields: ${Object.keys(values).join(', ')}.`,
      );
    const value = values[reference.field];
    if (!value)
      throw new SecureRefused(`${item.label} has no saved ${fieldLabel(reference.field).toLowerCase()}.`);
    return { entry, item, value };
  };

  const format = (item: OpenedItem['item'], reference: SecureReference, value: string) => {
    try {
      return formatSecureValue({
        kind: item.kind,
        field: reference.field,
        value,
        format: reference.format,
        idType: item.facts.type,
      });
    } catch (error) {
      throw new SecureRefused(error instanceof SecurePolicyError ? error.message : 'Check the format.');
    }
  };

  const hostOf = (raw: string) => {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      throw new SecureRefused('This page has no address that can be checked. Hand the field to the user.');
    }
    if (url.protocol !== 'https:')
      throw new SecureRefused('Saved values go only to https pages. Hand the field to the user.');
    const host = url.hostname.toLowerCase();
    const site = siteForHost(host);
    if (!site) throw new SecureRefused('Saved values go only to public sites. Hand the field to the user.');
    return { host, site };
  };

  const covers = (sites: Iterable<string>, host: string) => {
    for (const site of sites) if (siteCovers(site, host)) return true;
    return false;
  };

  const usedScrubber = () => {
    const scrubber = new SecureScrubber();
    for (const item of used.values()) scrubber.add(item.needles, item.label);
    return scrubber;
  };

  return {
    async cleanPage(pageUrl, parts) {
      const host = hostOfUrl(pageUrl);
      const all = await items();
      // A value this run typed, on a page outside its sites: stop the run.
      for (const [itemId, item] of used) {
        if (host && covers(item.sites, host)) continue;
        const lower = parts.map((part) => part.toLowerCase());
        if (item.needles.some((needle) => lower.some((part) => part.includes(needle.toLowerCase())))) {
          await record(
            `leak:${itemId}:${host}`,
            {
              userId: input.userId,
              itemId,
              outcome: 'refused_site',
              host: host || undefined,
              site: (host && siteForHost(host)) || undefined,
              workId: input.workId,
              runId: input.runId,
            },
            SECURE_LOG.leaked(item.label, host || 'a page'),
          );
          throw new SecureLeak(itemId, host);
        }
      }
      // The values to remove here: items saved for this site, and values this run used here.
      const scrubber = new SecureScrubber();
      const exact = new Map<string, string>();
      for (const { item, values } of all) {
        const run = used.get(item.id);
        const here = host && (covers(item.sites, host) || (run && covers(run.sites, host)));
        if (!here) continue;
        scrubber.add(scrubNeedles(item.kind, values, item.facts.type), item.label);
        for (const value of run?.exact ?? []) exact.set(value, item.label);
      }
      return parts.map((part) => {
        let text = part;
        if (exact.size) {
          text = text
            .split('\n')
            .map((line) => {
              const field = line.match(FIELD_LINE);
              if (field) {
                const value = field[2].trim().replace(/^"(.*)"$/, '$1');
                const label = exact.get(value);
                return label ? `${field[1]}: [secure: ${label}]` : line;
              }
              const option = line.match(OPTION_LINE);
              return option && exact.has(option[2]) ? line.replace(/\s*\[selected\]/, '') : line;
            })
            .join('\n');
        }
        return scrubber.scrub(text);
      });
    },

    cleanText(text) {
      return usedScrubber().scrub(text);
    },

    async resolveForField({ reference, fieldUrl, fieldKind, formUrl }) {
      const { entry, item, value } = await find(reference);
      const label = referenceLabel(item.label, item.kind, reference.field);
      if (item.kind === 'api_key')
        throw new SecureRefused('A key is never typed on a page. Use secure_fetch.');
      if (fieldKind === 'code' || fieldKind === 'card')
        throw new SecureRefused(
          'Only the user types sign-in codes and card data. Hand off with next.kind sign_in or finish_on_page.',
        );
      if (fieldKind === 'new_password')
        throw new SecureRefused(
          'This field sets a new password. Only the user does that. Hand off with next.kind finish_on_page.',
        );
      if (reference.field === 'password' && fieldKind !== 'password')
        throw new SecureRefused('A password goes only into a password field.');
      if (fieldKind === 'password' && !(item.kind === 'sign_in' && reference.field === 'password'))
        throw new SecureRefused('Only a saved sign-in password goes into a password field.');
      if (
        fieldKind === 'ssn' &&
        !(item.kind === 'id_number' && reference.field === 'number' && item.facts.type === 'ssn')
      )
        throw new SecureRefused(
          'This field asks for a Social Security number. Use a saved Social Security number, or hand the field to the user.',
        );

      const { host, site } = hostOf(fieldUrl);
      const base = {
        userId: input.userId,
        itemId: item.id,
        field: reference.field,
        site,
        host,
        workId: input.workId,
        runId: input.runId,
      };
      const own = covers(item.sites, host);
      if (!own) {
        if (!kindMayAskForSite(item.kind)) {
          await record(
            `refused:${item.id}:${host}`,
            { ...base, outcome: 'refused_site' },
            SECURE_LOG.refused(item.label, host),
          );
          throw new SecureRefused(
            `${item.label} is saved for ${item.sites.join(', ') || 'no site'}, not ${host}. Do not type it here. If this is the real site, hand off with next.kind sign_in so the user signs in.`,
          );
        }
        const granted = await deps
          .hasGrant({
            userId: input.userId,
            itemId: item.id,
            site,
            workId: input.workId,
            stepKey: input.stepKey,
          })
          .catch(() => false);
        if (!granted) {
          const fields =
            pending && pending.itemId === item.id && pending.site === site ? pending.fieldLabels : [];
          pending = {
            itemId: item.id,
            kind: item.kind,
            itemLabel: item.label,
            fieldLabels: [...new Set([...fields, fieldLabel(reference.field)])],
            site,
            host,
          };
          await record(
            `asked:${item.id}:${site}`,
            { ...base, outcome: 'asked' },
            SECURE_LOG.asked(item.label, site),
          );
          throw new SecureNeedsAllow(
            pending,
            `${item.label} is not allowed on ${site} yet. Fill the other fields, then call step_handoff with outcome your_turn and next.kind allow_secure. After the user answers, the next run types it.`,
          );
        }
      }
      // The form must send to the same place: a form on a saved site can post anywhere.
      const formHost = formUrl ? hostOfUrl(formUrl) : '';
      if (
        formHost &&
        /^https?:/i.test(formUrl ?? '') &&
        !siteCovers(site, formHost) &&
        !covers(item.sites, formHost)
      ) {
        await record(
          `refused:${item.id}:${formHost}`,
          { ...base, host: formHost, outcome: 'refused_site' },
          SECURE_LOG.refused(item.label, formHost),
        );
        throw new SecureRefused(
          `This form sends to ${formHost}, not a site that ${item.label} is saved for. Hand the field to the user.`,
        );
      }
      const formatted = format(item, reference, value);
      use(entry, site, formatted, label);
      await record(
        `typed:${item.id}:${reference.field}:${host}`,
        { ...base, outcome: 'typed' },
        once.has(`typed-line:${item.id}:${host}`)
          ? null
          : SECURE_LOG.typed(item.kind === 'sign_in' ? `${item.label} sign-in` : label, host),
      );
      once.add(`typed-line:${item.id}:${host}`);
      return { value: formatted, label };
    },

    async resolveForFetch({ reference, url }) {
      const { entry, item, value } = await find(reference);
      if (item.kind !== 'api_key') throw new SecureRefused('secure_fetch sends only a saved API key.');
      const { host, site } = hostOf(url);
      const base = {
        userId: input.userId,
        itemId: item.id,
        field: reference.field,
        site,
        host,
        workId: input.workId,
        runId: input.runId,
      };
      if (!covers(item.sites, host)) {
        await record(
          `refused:${item.id}:${host}`,
          { ...base, outcome: 'refused_site' },
          SECURE_LOG.refused(item.label, host),
        );
        throw new SecureRefused(`${item.label} is saved for ${item.sites.join(', ')}, not ${host}.`);
      }
      const label = referenceLabel(item.label, item.kind, reference.field);
      const formatted = format(item, reference, value);
      use(entry, host, formatted, label);
      await record(`sent:${item.id}:${host}`, { ...base, outcome: 'sent' }, SECURE_LOG.sent(label, host));
      return { value: formatted, label };
    },

    pendingAllow() {
      return pending;
    },

    async signInOffer(pageUrl: string) {
      const host = hostOfUrl(pageUrl);
      if (!host) return null;
      const site = siteForHost(host);
      if (!site) return null;
      const covered = (await items()).some(({ item }) => item.kind === 'sign_in' && covers(item.sites, host));
      return covered ? null : { site };
    },
  };
}
