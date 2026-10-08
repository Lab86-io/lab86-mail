// The step runner's hands in the shared browser.
//
// The agent reads the page as Playwright's AI accessibility snapshot
// (`ariaSnapshot({ mode: 'ai' })`), where each element carries a ref such as
// `[ref=e12]`, and it acts with the `aria-ref=e12` locator. The agent model
// chooses each action itself, so no second model runs per click and the run
// meter sees every cost. Refs belong to one CDP connection: a run keeps one
// connection open from its first browser call to its end, and a resumed run
// must read a new snapshot before it acts.
//
// The page rules below are a safety net under the runner prompt:
// - The agent never types into a password, one-time-code, or card field.
// - The agent never clicks a control that pays, buys, signs, accepts terms,
//   deletes, sends, or submits. It hands that page to the user.
// - Enter submits only search-like fields; any other submit is a click on the
//   (checked) submit control.
// - A saved value from Passwords and IDs goes in only as one
//   `{{secure:<id>.<field>}}` reference, which lib/secure/runner-access.ts
//   checks and opens. Every snapshot, title, URL, and page text the model
//   reads has the user's saved values removed (docs/albatross-secure-store.md).

import { findReferences, mentionsReference } from '../secure/policy';
import type { SecureBrowserAccess, SecureFieldKind } from '../secure/runner-access';
import { scrubTypedFields } from '../secure/scrub';
import { isPrivateHost } from '../shared/private-host';
import { truncateText } from '../shared/text';

export { isPrivateHost };

export const SNAPSHOT_MAX_CHARS = 14_000;
const ACTION_TIMEOUT_MS = 12_000;
const NAVIGATION_TIMEOUT_MS = 25_000;

export class BrowserHandoffRequired extends Error {
  constructor(
    readonly reason: 'secret' | 'final_action' | 'submit',
    message: string,
  ) {
    super(message);
    this.name = 'BrowserHandoffRequired';
  }
}

export interface SnapshotElement {
  role: string;
  name: string;
}

/** The role and accessible name on the snapshot line of one ref. */
export function elementForRef(snapshot: string, ref: string): SnapshotElement | null {
  const marker = `[ref=${ref}]`;
  const line = snapshot.split('\n').find((entry) => entry.includes(marker));
  if (!line) return null;
  const match = line.match(/^\s*-\s+([a-zA-Z]+)(?:\s+"((?:[^"\\]|\\.)*)")?/);
  if (!match) return { role: 'generic', name: '' };
  return { role: match[1].toLowerCase(), name: (match[2] || '').replace(/\\"/g, '"') };
}

const SECRET_NAME =
  /password|passcode|passphrase|one[- ]?time|verification code|security code|auth(entication)? code|\b2fa\b|\bmfa\b|\bcvv\b|\bcvc\b|\bcsc\b|card number|credit card|debit card|\bpin\b|social security|\bssn\b|routing number|account number/i;

/** A field the agent must never type into. */
export function isSecretField(
  element: SnapshotElement | null,
  input?: { type?: string; autocomplete?: string } | null,
): boolean {
  const type = (input?.type || '').toLowerCase();
  const autocomplete = (input?.autocomplete || '').toLowerCase();
  if (type === 'password') return true;
  if (/password|one-time-code|cc-/.test(autocomplete)) return true;
  return SECRET_NAME.test(element?.name || '');
}

const CODE_NAME =
  /one[- ]?time|verification code|security code|auth(entication)? code|sign[- ]?in code|\b2fa\b|\bmfa\b|\botp\b|\bpin\b|recovery code|backup code/i;
const CARD_NAME =
  /\bcvv\b|\bcvc\b|\bcsc\b|card number|credit card|debit card|routing number|account number|\biban\b/i;
const SSN_NAME = /social security|\bssn\b/i;
const PASSWORD_NAME = /password|passcode|passphrase/i;

/** What a field takes, for the secure store's field rules. */
export function secureFieldKind(
  element: SnapshotElement | null,
  input?: { type?: string; autocomplete?: string } | null,
): SecureFieldKind {
  const type = (input?.type || '').toLowerCase();
  const autocomplete = (input?.autocomplete || '').toLowerCase();
  const name = element?.name || '';
  if (/one-time-code/.test(autocomplete) || CODE_NAME.test(name)) return 'code';
  if (/\bcc-/.test(autocomplete) || CARD_NAME.test(name)) return 'card';
  if (
    /new-password/.test(autocomplete) ||
    (/\bnew\b|confirm|re-?enter|repeat/i.test(name) && PASSWORD_NAME.test(name))
  )
    return 'new_password';
  // A password goes only into a real password input. A text field that a page
  // names "Password" (a form question, a post) is not one.
  if (type === 'password') return 'password';
  if (SSN_NAME.test(name)) return 'ssn';
  return 'plain';
}

const FINAL_ACTION =
  /\b(pay|payment|place (my |your |the )?order|buy|purchase|check ?out|transfer|send money|donate|subscribe|start (my |your |a )?(free )?trial|accept|agree|e-?sign|sign (and )?(submit|send|file)|submit|confirm|book( now)?|reserve|delete|remove (my |your )?account|close (my |your )?account|cancel (my |your )?(subscription|membership|account|order|plan|reservation)|unsubscribe|send|file (my |your |the )?(claim|dispute|return|report))\b/i;
const HARMLESS = /cookie|cookies|search|filter|sort|send (me )?(a )?(code|link)|resend/i;
const CLICKABLE_ROLES = new Set([
  'button',
  'link',
  'menuitem',
  'checkbox',
  'radio',
  'switch',
  'option',
  'tab',
]);

/** A control whose click commits the user: money, a signature, terms, a send, a submit, a delete. */
export function isFinalAction(element: SnapshotElement | null): boolean {
  if (!element || !CLICKABLE_ROLES.has(element.role)) return false;
  if (!element.name) return false;
  if (HARMLESS.test(element.name) && !/\b(pay|buy|purchase|submit|agree)\b/i.test(element.name)) return false;
  return FINAL_ACTION.test(element.name);
}

/** Enter may submit only a search-like field. */
export function enterMaySubmit(element: SnapshotElement | null): boolean {
  if (!element) return false;
  if (element.role === 'searchbox') return true;
  // Address names (ZIP, city) are checkout and application fields too, where
  // Enter submits the whole form. A finder has a Search or Find control.
  return /search|find|look ?up|query|keyword/i.test(element.name);
}

/** Only web pages: no file, data, javascript, or browser-internal URLs. */
export function safeBrowserUrl(raw: string): string | null {
  try {
    const url = new URL(raw.trim());
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    if (isPrivateHost(url.hostname)) return null;
    return url.toString();
  } catch {
    return null;
  }
}

/**
 * A snapshot the model can afford. Cursor hints go, long link targets are
 * shortened, and `find` keeps only the lines that mention one of its words
 * (with their refs). A cut snapshot says so, so the model asks with `find`.
 */
export function compactSnapshot(
  raw: string,
  options: { find?: string; maxChars?: number } = {},
): { text: string; truncated: boolean } {
  const maxChars = options.maxChars ?? SNAPSHOT_MAX_CHARS;
  let lines = raw
    .split('\n')
    .map((line) =>
      line
        .replace(/\s*\[cursor=pointer\]/g, '')
        .replace(/(\/url:\s*)(\S{120})\S+/, '$1$2…')
        .trimEnd(),
    )
    .filter((line) => line.trim() && line.trim() !== '- generic');
  const words = (options.find || '')
    .toLowerCase()
    .split(/[\s,]+/)
    .filter((word) => word.length > 1);
  if (words.length) {
    lines = lines.filter((line) => {
      const lower = line.toLowerCase();
      return words.some((word) => lower.includes(word));
    });
  }
  let used = 0;
  const kept: string[] = [];
  for (const line of lines) {
    if (used + line.length + 1 > maxChars) {
      return {
        text: `${kept.join('\n')}\n… The page continues. Call browser_snapshot with find to read a part.`,
        truncated: true,
      };
    }
    kept.push(line);
    used += line.length + 1;
  }
  return { text: kept.join('\n'), truncated: false };
}

export interface AgentPage {
  goto(url: string): Promise<void>;
  url(): string;
  title(): Promise<string>;
  snapshot(): Promise<string>;
  click(ref: string): Promise<void>;
  fill(ref: string, text: string): Promise<void>;
  select(ref: string, values: string[]): Promise<void>;
  press(key: string): Promise<void>;
  back(): Promise<void>;
  wait(ms: number): Promise<void>;
  /**
   * The field's type, its autocomplete, and the address of the frame it is in
   * (a frame has its own). The address comes from the browser, never from page
   * script, because the secure store's site check trusts it.
   */
  inputKind(
    ref: string,
  ): Promise<{ type?: string; autocomplete?: string; documentUrl?: string; formUrl?: string } | null>;
  text(): Promise<string>;
}

export interface AgentConnection {
  page(): Promise<AgentPage | null>;
  close(): Promise<void>;
}

export type AgentConnector = (connectUrl: string) => Promise<AgentConnection>;

/** playwright-core over CDP. The newest tab is the page; a popup becomes the page. */
export const playwrightAgentConnector: AgentConnector = async (connectUrl) => {
  const { chromium } = await import('playwright-core');
  const browser = await chromium.connectOverCDP(connectUrl);
  const context = browser.contexts()[0];
  const current = () => context?.pages().at(-1) ?? null;
  const settle = async (page: NonNullable<ReturnType<typeof current>>) => {
    await page
      .waitForLoadState('domcontentloaded', { timeout: NAVIGATION_TIMEOUT_MS })
      .catch(() => undefined);
  };
  return {
    page: async () => {
      if (!current() && context) await context.newPage();
      const page = current();
      if (!page) return null;
      return {
        goto: async (url) => {
          await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAVIGATION_TIMEOUT_MS });
        },
        url: () => current()?.url() ?? page.url(),
        title: async () => (current() ?? page).title(),
        snapshot: async () => (current() ?? page).ariaSnapshot({ mode: 'ai', timeout: ACTION_TIMEOUT_MS }),
        click: async (ref) => {
          const target = current() ?? page;
          await target.locator(`aria-ref=${ref}`).click({ timeout: ACTION_TIMEOUT_MS });
          await settle(current() ?? target);
        },
        fill: async (ref, text) => {
          await (current() ?? page).locator(`aria-ref=${ref}`).fill(text, { timeout: ACTION_TIMEOUT_MS });
        },
        select: async (ref, values) => {
          await (current() ?? page)
            .locator(`aria-ref=${ref}`)
            .selectOption(values, { timeout: ACTION_TIMEOUT_MS });
        },
        press: async (key) => {
          const target = current() ?? page;
          await target.keyboard.press(key);
          await settle(current() ?? target);
        },
        back: async () => {
          await (current() ?? page).goBack({ waitUntil: 'domcontentloaded', timeout: NAVIGATION_TIMEOUT_MS });
        },
        wait: async (ms) => {
          await (current() ?? page).waitForTimeout(ms);
        },
        inputKind: async (ref) => {
          const locator = (current() ?? page).locator(`aria-ref=${ref}`);
          const kind = await locator
            .evaluate((element: any) => ({
              type: String(element?.type || ''),
              autocomplete: String(element?.autocomplete || element?.getAttribute?.('autocomplete') || ''),
              // Where the field's form sends it (resolved by the browser), or empty.
              formUrl: String(element?.form?.action || ''),
            }))
            .catch(() => null);
          if (!kind) return null;
          // The field's frame address comes from the browser, not from page
          // script: a page can redefine its own DOM getters, but not this.
          const handle = await locator.elementHandle({ timeout: ACTION_TIMEOUT_MS }).catch(() => null);
          const frame = handle ? await handle.ownerFrame().catch(() => null) : null;
          await handle?.dispose().catch(() => undefined);
          return { ...kind, documentUrl: frame?.url() ?? '' };
        },
        text: async () => {
          try {
            return await (current() ?? page).innerText('body', { timeout: 5_000 });
          } catch {
            return '';
          }
        },
      };
    },
    // Disconnects this client only. The remote session ends by release or timeout.
    close: () => browser.close(),
  };
};

const SAFE_KEYS = new Set([
  'Tab',
  'Shift+Tab',
  'Escape',
  'ArrowDown',
  'ArrowUp',
  'ArrowLeft',
  'ArrowRight',
  'PageDown',
  'PageUp',
  'Home',
  'End',
]);

export interface PageView {
  url: string;
  title: string;
  snapshot: string;
  truncated: boolean;
  /** The saved value the last action typed, by label ("Driver's license number"). */
  secure?: string;
}

function pageKey(url: string) {
  return url.split('#')[0];
}

/** One run's browser. All page rules live here, not in the tool wrappers. */
export class AgentBrowser {
  private lastSnapshot = '';
  /** Refs that hold a saved value, with its label, on the page where it was typed. */
  private typedFields = new Map<string, string>();
  private typedPage = '';

  constructor(
    private readonly page: AgentPage,
    private readonly secure: SecureBrowserAccess | null = null,
  ) {}

  /** Page text a model may read: saved values removed (lib/secure/runner-access.ts cleanPage). */
  private async clean(pageUrl: string, parts: string[]): Promise<string[]> {
    if (!this.secure) return parts;
    return this.secure.cleanPage(pageUrl, parts);
  }

  /** A message for the model (an error, a handoff reason) with saved values removed. */
  async cleanMessage(text: string): Promise<string> {
    if (!this.secure || !text) return text;
    try {
      return (await this.secure.cleanPage(this.page.url(), [text]))[0];
    } catch {
      return 'The page action failed.';
    }
  }

  private async view(find?: string): Promise<PageView> {
    const raw = await this.page.snapshot();
    this.lastSnapshot = raw;
    const url = this.page.url();
    if (this.typedFields.size && pageKey(url) !== this.typedPage) this.typedFields.clear();
    const title = await this.page.title().catch(() => '');
    // Clean first, cut after: a cut must never leave part of a value behind.
    const [snapshot, cleanTitle, cleanUrl] = await this.clean(url, [
      scrubTypedFields(raw, this.typedFields),
      title,
      url,
    ]);
    const compact = compactSnapshot(snapshot, { find });
    return {
      url: cleanUrl,
      title: truncateText(cleanTitle, 300),
      snapshot: compact.text,
      truncated: compact.truncated,
    };
  }

  /** The one reference in a text, or null when it has none. Throws for a mix. */
  private reference(text: string) {
    if (!mentionsReference(text)) return null;
    if (!this.secure) throw new Error('Saved values are not available in this run.');
    const found = findReferences(text);
    if (found.length !== 1 || found[0].raw !== text.trim())
      throw new Error(
        'A saved value goes in alone: the text must be exactly one {{secure:<id>.<field>}} reference, with an optional |FORMAT.',
      );
    return found[0];
  }

  private async typeSaved(
    ref: string,
    element: SnapshotElement,
    reference: NonNullable<ReturnType<AgentBrowser['reference']>>,
    act: (value: string) => Promise<void>,
  ): Promise<PageView> {
    const input = await this.page.inputKind(ref);
    if (!input?.documentUrl) throw new Error('This field could not be checked. Hand it to the user.');
    const resolved = await (this.secure as SecureBrowserAccess).resolveForField({
      reference,
      fieldUrl: input.documentUrl,
      fieldKind: secureFieldKind(element, input),
      formUrl: input.formUrl || null,
    });
    try {
      await act(resolved.value);
    } catch {
      // Playwright's error quotes the call, with the value in it. It never reaches the model.
      throw new Error('The field did not take the saved value. Hand this field to the user.');
    }
    if (pageKey(this.page.url()) !== this.typedPage) this.typedFields.clear();
    this.typedPage = pageKey(this.page.url());
    this.typedFields.set(ref, resolved.label);
    return { ...(await this.view()), secure: `Typed the saved ${resolved.label}.` };
  }

  private element(ref: string): SnapshotElement {
    // Page refs look like e12; refs inside a frame look like f1e12.
    if (!/^(f\d+)?e\d+$/.test(ref)) {
      throw new Error(`"${ref}" is not a ref from the snapshot. Use a ref such as e12.`);
    }
    const element = elementForRef(this.lastSnapshot, ref);
    if (!element) throw new Error(`Ref ${ref} is not in the latest snapshot. Call browser_snapshot first.`);
    return element;
  }

  async open(rawUrl: string): Promise<PageView> {
    const url = safeBrowserUrl(rawUrl);
    if (!url) throw new Error('Only public http and https pages can be opened.');
    await this.page.goto(url);
    return this.view();
  }

  snapshot(find?: string): Promise<PageView> {
    return this.view(find);
  }

  async click(ref: string): Promise<PageView> {
    const element = this.element(ref);
    if (isFinalAction(element)) {
      throw new BrowserHandoffRequired(
        'final_action',
        `"${element.name}" commits the user. Stop here and hand the page to the user with next.kind finish_on_page.`,
      );
    }
    await this.page.click(ref);
    return this.view();
  }

  async type(ref: string, text: string, submit = false): Promise<PageView> {
    const element = this.element(ref);
    const reference = this.reference(text);
    if (reference) {
      if (submit)
        throw new Error('A saved value never submits with Enter. Type it, then click the checked control.');
      return this.typeSaved(ref, element, reference, (value) => this.page.fill(ref, value));
    }
    const input = await this.page.inputKind(ref);
    if (isSecretField(element, input)) {
      throw new BrowserHandoffRequired(
        'secret',
        this.secure
          ? 'This field takes a password, a code, card data, or an ID number. Type a saved value as one {{secure:<id>.<field>}} reference (secure_details_list), or hand off with next.kind sign_in.'
          : 'This field takes a password, a code, or card data. Only the user types it. Hand off with next.kind sign_in.',
      );
    }
    if (submit && !enterMaySubmit(element)) {
      throw new BrowserHandoffRequired(
        'submit',
        'Enter would submit this form. Fill the fields, then stop and hand the form to the user, or click a checked control.',
      );
    }
    await this.page.fill(ref, text);
    if (submit) await this.page.press('Enter');
    return this.view();
  }

  async select(ref: string, values: string[]): Promise<PageView> {
    const element = this.element(ref);
    const references = values.filter((value) => mentionsReference(value));
    if (references.length) {
      if (values.length !== 1) throw new Error('A saved value is chosen alone: pass one value.');
      const reference = this.reference(values[0]);
      if (reference)
        return this.typeSaved(ref, element, reference, (value) => this.page.select(ref, [value]));
    }
    await this.page.select(ref, values.slice(0, 10));
    return this.view();
  }

  async press(key: string): Promise<PageView> {
    if (!SAFE_KEYS.has(key))
      throw new Error(`Key ${key} is not allowed. Allowed: ${[...SAFE_KEYS].join(', ')}.`);
    await this.page.press(key);
    return this.view();
  }

  async back(): Promise<PageView> {
    await this.page.back();
    return this.view();
  }

  async wait(seconds: number): Promise<PageView> {
    await this.page.wait(Math.min(Math.max(seconds, 1), 10) * 1_000);
    return this.view();
  }

  /** The page address now (for the server only; the model reads it scrubbed). */
  currentUrl(): string {
    return this.page.url();
  }

  /** The visible text, for the proof check. */
  async readText(): Promise<{ url: string; title: string; text: string }> {
    const url = this.page.url();
    const [cleanUrl, title, text] = await this.clean(url, [
      url,
      await this.page.title().catch(() => ''),
      (await this.page.text()).replace(/\s+/g, ' ').trim(),
    ]);
    return { url: cleanUrl, title: truncateText(title, 300), text: truncateText(text, 6_000) };
  }
}
