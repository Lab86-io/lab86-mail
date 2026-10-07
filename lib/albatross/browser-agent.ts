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

import { truncateText } from '../shared/text';

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
  return /search|find|look ?up|zip|postal|city|location|query|keyword/i.test(element.name);
}

/** Only web pages: no file, data, javascript, or browser-internal URLs. */
export function safeBrowserUrl(raw: string): string | null {
  try {
    const url = new URL(raw.trim());
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    if (/^(localhost|127\.|10\.|192\.168\.|169\.254\.|\[?::1\]?)/i.test(url.hostname)) return null;
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
  inputKind(ref: string): Promise<{ type?: string; autocomplete?: string } | null>;
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
        inputKind: async (ref) =>
          (current() ?? page)
            .locator(`aria-ref=${ref}`)
            .evaluate((element: any) => ({
              type: String(element?.type || ''),
              autocomplete: String(element?.autocomplete || element?.getAttribute?.('autocomplete') || ''),
            }))
            .catch(() => null),
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
  'Space',
]);

export interface PageView {
  url: string;
  title: string;
  snapshot: string;
  truncated: boolean;
}

/** One run's browser. All page rules live here, not in the tool wrappers. */
export class AgentBrowser {
  private lastSnapshot = '';

  constructor(private readonly page: AgentPage) {}

  private async view(find?: string): Promise<PageView> {
    const raw = await this.page.snapshot();
    this.lastSnapshot = raw;
    const compact = compactSnapshot(raw, { find });
    return {
      url: this.page.url(),
      title: truncateText(await this.page.title().catch(() => ''), 300),
      snapshot: compact.text,
      truncated: compact.truncated,
    };
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
    const input = await this.page.inputKind(ref);
    if (isSecretField(element, input)) {
      throw new BrowserHandoffRequired(
        'secret',
        'This field takes a password, a code, or card data. Only the user types it. Hand off with next.kind sign_in.',
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
    this.element(ref);
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

  /** The visible text, for the proof check. */
  async readText(): Promise<{ url: string; title: string; text: string }> {
    return {
      url: this.page.url(),
      title: truncateText(await this.page.title().catch(() => ''), 300),
      text: truncateText((await this.page.text()).replace(/\s+/g, ' ').trim(), 6_000),
    };
  }
}
