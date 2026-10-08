import { describe, expect, test } from 'bun:test';
import { JSDOM } from 'jsdom';
import { renderToStaticMarkup } from 'react-dom/server';
import { SecureRequestCard } from '../components/ai-elements/secure-request-card';
import { AllowSecureBlock } from '../components/albatross/thread/AllowSecureBlock';
import { RunBlock, type RunBlockProps } from '../components/albatross/thread/RunBlock';
import { MASKED_INPUT_COPY, MaskedInput } from '../components/settings/MaskedInput';
import { SAVED_SIGN_INS_COPY, SavedSignInsRow } from '../components/settings/SavedSignIns';
import { SecureDetailsList, type SecureDetailsListProps } from '../components/settings/SecureDetailsList';
import { SecureItemForm, SHEET_COPY } from '../components/settings/SecureItemSheet';
import { SecretNotice } from '../components/shell/SecretNotice';
import {
  allowRunFixture,
  SECURE_FIXTURE_IDS,
  secureItemsFixture,
  secureRequestFixture,
  secureUsesFixture,
  signInOfferRunFixture,
} from '../lib/albatross/secure-fixtures';
import { ALLOW_COPY, SAVE_SIGN_IN_COPY, SECURE_COPY } from '../lib/albatross/secure-view';
import { threadDetailsFixture } from '../lib/albatross/thread-fixtures';
import { PENDING_FORM_ATTRIBUTE } from '../lib/albatross/thread-view';

const NOW = Date.UTC(2026, 9, 8, 13, 46, 0);
const items = secureItemsFixture(NOW);
const details = threadDetailsFixture(NOW).details;
const noop = () => undefined;
const ok = async () => true;

/** The static markup with its text entities back as characters, so copy with an apostrophe compares as written. */
function render(element: React.ReactElement): string {
  return renderToStaticMarkup(element)
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&');
}

function doc(html: string) {
  return new JSDOM(html).window.document;
}

/** The action buttons (the shadcn Button). */
function buttons(html: string): string[] {
  return [...doc(html).querySelectorAll('button[data-slot="button"]')].map(
    (node) => node.textContent?.trim() ?? '',
  );
}

function textButtons(html: string): string[] {
  return [...doc(html).querySelectorAll('button:not([data-slot="button"])')].map(
    (node) => node.textContent?.trim() ?? '',
  );
}

function list(over: Partial<SecureDetailsListProps> = {}) {
  return render(
    <SecureDetailsList
      items={items}
      now={NOW}
      timeZone="UTC"
      openId={null}
      onToggle={noop}
      uses={{}}
      busy={null}
      onReplace={ok}
      onRename={ok}
      onRemoveSite={noop}
      onAddSite={ok}
      onDelete={noop}
      onAdd={noop}
      {...over}
    />,
  );
}

describe('the Passwords and IDs list', () => {
  test('three groups, the rows with masked hints, the count, and the add row', () => {
    const html = list();
    expect(html).toContain('Passwords and IDs');
    expect(html).toContain('4 saved');
    for (const title of ['Sign-ins', 'IDs', 'Keys']) expect(html).toContain(title);
    expect(html).toContain('chase.com · s•••@example.com · ');
    expect(html).toContain('sr-only">saved<');
    expect(html).toContain('New York · ends 4821 · expires June 2029');
    expect(html).toContain('api.openai.com · sk-…f3a2 · Authorization: Bearer');
    expect(html).toContain('Last used today, 1:12 PM');
    expect(html).toContain(SECURE_COPY.noSites);
    expect(html).toContain(SECURE_COPY.note);
    expect(doc(html).querySelector('button[data-slot="dropdown-menu-trigger"]')?.textContent).toBe('Add');
    const rows = doc(html).querySelectorAll('[data-slot="secure-item"]');
    expect(rows).toHaveLength(4);
    // No value anywhere: nothing that looks like a full number or a key.
    expect(html).not.toMatch(/\b\d{3}-\d{2}-\d{4}\b/);
    expect(html).not.toMatch(/sk-[A-Za-z0-9]{8,}/);
  });

  test('the empty store shows the date of birth slot and the add row', () => {
    const html = list({ items: [] });
    expect(html).toContain('Nothing saved yet');
    expect(html).toContain('Date of birth');
    expect(html).toContain('Not saved');
    expect(html).not.toContain('Sign-ins');
    expect(html).not.toContain('Keys');
    expect(buttons(html).filter((label) => label === 'Add')).toHaveLength(1);
    expect(doc(html).querySelector('button[data-slot="dropdown-menu-trigger"]')?.textContent).toBe('Add');
  });

  test('the open item shows its fields with Replace, its sites, its uses, Rename and Delete', () => {
    const html = list({
      openId: SECURE_FIXTURE_IDS.license,
      uses: { [SECURE_FIXTURE_IDS.license]: { status: 'ready', uses: secureUsesFixture(NOW) } },
    });
    const open = doc(html).querySelector('[data-slot="secure-item"][data-open]');
    expect(open?.querySelector('button[aria-expanded="true"]')).not.toBeNull();
    expect(html).toContain('Expiry date');
    expect(html).toContain('Name on the ID');
    expect(textButtons(html).filter((label) => label === 'Replace')).toHaveLength(3);
    expect(html).toContain(SECURE_COPY.sitesTitle);
    expect(html).toContain('ny.gov');
    expect(textButtons(html)).toContain('Remove');
    expect(html).toContain(SECURE_COPY.addSiteHint);
    expect(html).toContain(SECURE_COPY.usesTitle);
    expect(html).toContain('Typed the number');
    expect(html).toContain('Refused: not one of its sites');
    expect(html).toContain('Renew the car registration');
    expect(html).toContain(SECURE_COPY.usesKept);
    expect(textButtons(html)).toContain('Rename');
    expect(textButtons(html)).toContain('Delete');
    expect(html).not.toContain('Reveal');
    expect(html).not.toContain('Copy');
  });

  test('a loading or missing history, and a note under the site input', () => {
    const loading = list({ openId: SECURE_FIXTURE_IDS.chase });
    expect(loading).toContain(SECURE_COPY.usesLoading);
    const empty = list({
      openId: SECURE_FIXTURE_IDS.chase,
      uses: { [SECURE_FIXTURE_IDS.chase]: { status: 'ready', uses: [] } },
      notes: { [SECURE_FIXTURE_IDS.chase]: { text: SECURE_COPY.siteCheckCancelled, tone: 'quiet' } },
    });
    expect(empty).toContain(SECURE_COPY.usesEmpty);
    expect(empty).toContain(SECURE_COPY.siteCheckCancelled);
    // The only site of a sign-in cannot be removed.
    expect(textButtons(empty)).not.toContain('Remove');
  });

  test('the renamed browser row sits as the last group', () => {
    const html = list({
      browser: <SavedSignInsRow state={{ saved: true, lastUsedAt: NOW }} onForget={noop} />,
    });
    expect(html).toContain('In the shared browser');
    expect(html).toContain('Signed-in sites');
    expect(html).toContain('No password is kept here.');
    expect(buttons(html)).toContain(SAVED_SIGN_INS_COPY.forget);
    expect(SAVED_SIGN_INS_COPY.forget).toBe('Sign out everywhere');
  });
});

describe('the masked input and the add form', () => {
  test('a masked input is a text field that password managers ignore, with Show', () => {
    const html = render(<MaskedInput id="pw" value="" onChange={noop} />);
    const input = doc(html).querySelector('input');
    expect(input?.getAttribute('type')).toBe('text');
    expect(input?.getAttribute('autocomplete')).toBe('off');
    expect(input?.hasAttribute('data-1p-ignore')).toBe(true);
    expect(input?.getAttribute('data-lpignore')).toBe('true');
    expect(html).toContain('-webkit-text-security:disc');
    expect(html).toContain(MASKED_INPUT_COPY.show);
    expect(html).toContain(MASKED_INPUT_COPY.help);
  });

  test('the sign-in form starts with the site and names what it covers', () => {
    const html = render(
      <SecureItemForm
        request={{ kind: 'sign_in', site: 'springfieldwater.gov', label: 'Springfield Water' }}
        onSave={async () => items[0]}
        onCancel={noop}
      />,
    );
    const labels = [...doc(html).querySelectorAll('label')].map((node) => node.textContent);
    expect(labels).toEqual([SHEET_COPY.site, SHEET_COPY.label, SHEET_COPY.username, SHEET_COPY.password]);
    expect(html).toContain('Covers springfieldwater.gov and all its pages.');
    expect(html).toContain('value="Springfield Water"');
    expect(html).toContain(SHEET_COPY.fine);
    expect(buttons(html)).toEqual(['Save', 'Cancel']);
  });

  test('a site the chat suggested carries a warning line; a site from the user does not', () => {
    const fromCard = render(
      <SecureItemForm
        request={{ kind: 'sign_in', site: 'chase-online-help.com', siteSuggested: true }}
        onSave={async () => items[0]}
        onCancel={noop}
      />,
    );
    expect(fromCard).toContain(SHEET_COPY.siteSuggested.sign_in as string);
    expect(doc(fromCard).querySelector('[data-slot="site-suggested"]')?.className).toContain(
      '--color-warning',
    );
    expect(fromCard).not.toContain('Covers chase-online-help.com');
    const keyFromCard = render(
      <SecureItemForm
        request={{ kind: 'api_key', site: 'api.example.com', siteSuggested: true }}
        onSave={async () => items[3]}
        onCancel={noop}
      />,
    );
    expect(keyFromCard).toContain(SHEET_COPY.siteSuggested.api_key as string);
    const fromUser = render(
      <SecureItemForm
        request={{ kind: 'sign_in', site: 'chase.com' }}
        onSave={async () => items[0]}
        onCancel={noop}
      />,
    );
    expect(fromUser).not.toContain('Albatross suggested this site');
    expect(fromUser).toContain('Covers chase.com and all its pages.');
  });

  test('the ID form, the date of birth form, and the key form show their own fields', () => {
    const id = render(
      <SecureItemForm
        request={{ kind: 'id_number' }}
        onSave={async () => items[1]}
        onCancel={noop}
        defaultNameOnId="Sam Rivera"
      />,
    );
    expect(id).toContain(SHEET_COPY.type);
    expect(id).toContain(SHEET_COPY.region);
    expect(id).toContain(SHEET_COPY.expires);
    expect(id).toContain('value="Sam Rivera"');
    expect(id).toContain(SHEET_COPY.fromDetails);
    expect(id).toContain(SHEET_COPY.askFirst);
    const dob = render(
      <SecureItemForm
        request={{ kind: 'date_of_birth' }}
        onSave={async () => items[2]}
        onCancel={noop}
        hasDateOfBirth
      />,
    );
    expect(dob).toContain(SHEET_COPY.dateOfBirthExists);
    expect(dob).toContain('type="date"');
    const key = render(
      <SecureItemForm
        request={{ kind: 'api_key', site: 'api.openai.com' }}
        onSave={async () => items[3]}
        onCancel={noop}
      />,
    );
    expect(key).toContain(SHEET_COPY.host);
    expect(key).toContain('Albatross calls api.openai.com only.');
    expect(key).toContain(SHEET_COPY.headerHelp);
  });
});

describe('the allow block', () => {
  const fixture = allowRunFixture(NOW).next?.allow;
  if (!fixture) throw new Error('fixture');
  const allow: NonNullable<typeof fixture> = fixture;

  function allowBlock(over: Partial<React.ComponentProps<typeof AllowSecureBlock>> = {}) {
    return render(
      <AllowSecureBlock
        allow={allow}
        headline="Needs your answer"
        answer={null}
        onAnswer={noop}
        onOpenSettings={noop}
        {...over}
      />,
    );
  }

  test('open: the question, the reason, three buttons in order, and the one quiet line', () => {
    const html = allowBlock();
    expect(html).toContain("Use your driver's license number on ny.gov?");
    expect(html).toContain('dmv.ny.gov asks for the number and the expiry date.');
    expect(buttons(html)).toEqual(['Allow once', 'Always on ny.gov', 'Do not allow']);
    expect(html).toContain(ALLOW_COPY.fine);
    expect(doc(html).querySelector('[data-allow-state="open"]')).not.toBeNull();
  });

  test('while the check runs the pressed button reads One moment and the others wait', () => {
    const html = allowBlock({ busyScope: 'always' });
    expect(buttons(html)).toEqual(['Allow once', 'One moment', 'Do not allow']);
    const disabled = [...doc(html).querySelectorAll('button[data-slot="button"][disabled]')];
    expect(disabled).toHaveLength(3);
  });

  test('a closed check leaves the buttons and one quiet line; a failure is in the danger voice', () => {
    const cancelled = allowBlock({ note: { text: ALLOW_COPY.cancelled, tone: 'quiet' } });
    expect(buttons(cancelled)).toHaveLength(3);
    expect(cancelled).toContain(ALLOW_COPY.cancelled);
    expect(cancelled).not.toContain(ALLOW_COPY.fine);
    const failed = allowBlock({ note: { text: ALLOW_COPY.failed, tone: 'danger' } });
    expect(failed).toContain('--color-danger');
  });

  test('answered: one receipt, with the Settings link for always', () => {
    const once = allowBlock({ answer: { scope: 'once' } });
    expect(buttons(once)).toEqual([]);
    expect(once).toContain('Allowed once on ny.gov.');
    const always = allowBlock({ answer: { scope: 'always' } });
    expect(always).toContain('Always allowed on ny.gov.');
    expect(always).toContain(ALLOW_COPY.settings);
    const deny = allowBlock({ answer: { scope: 'deny' } });
    expect(deny).toContain('Not allowed.');
    expect(allowBlock({ closed: true })).toContain(ALLOW_COPY.noLongerOpen);
  });
});

describe('the run block with Passwords and IDs', () => {
  function block(over: Partial<RunBlockProps>) {
    return render(
      <RunBlock
        run={allowRunFixture(NOW)}
        timeZone="UTC"
        details={details}
        onStop={noop}
        onResume={noop}
        onDismiss={noop}
        onStart={noop}
        onMarkDone={noop}
        onNext={noop}
        onAnswer={noop}
        onAllow={noop}
        onSaveSignIn={noop}
        {...over}
      />,
    );
  }

  test('an open allow block is the pending question of the thread and has no Dismiss', () => {
    const html = block({});
    expect(html).toContain('Needs your answer');
    expect(html).toContain(`${PENDING_FORM_ATTRIBUTE}=""`);
    expect(buttons(html)).toEqual(['Allow once', 'Always on ny.gov', 'Do not allow']);
  });

  test('an answered allow block shows the stored answer on every device', () => {
    const html = block({ run: allowRunFixture(NOW, 'always') });
    expect(html).toContain('Answered');
    expect(html).toContain('Always allowed on ny.gov.');
    expect(html).not.toContain(`${PENDING_FORM_ATTRIBUTE}=""`);
    expect(buttons(html)).toEqual([]);
    const optimistic = block({ allowAnswered: 'once' });
    expect(optimistic).toContain('Allowed once on ny.gov.');
  });

  test('the sign-in handoff offers to save a sign-in, then reads Continue after the save', () => {
    const offer = block({ run: signInOfferRunFixture(NOW), secureItems: [] });
    expect(offer).toContain(SAVE_SIGN_IN_COPY.offer('springfieldwater.gov'));
    expect(textButtons(offer)).toContain(SAVE_SIGN_IN_COPY.save);
    expect(textButtons(offer)).toContain(SAVE_SIGN_IN_COPY.notNow);
    expect(buttons(offer)).toEqual(['I signed in', 'Dismiss']);
    const chase = signInOfferRunFixture(NOW);
    const covered = block({
      run: { ...chase, next: { ...chase.next, saveSignIn: { site: 'chase.com' } } } as typeof chase,
      secureItems: items,
    });
    expect(covered).not.toContain(SAVE_SIGN_IN_COPY.save);
    const saved = block({ run: signInOfferRunFixture(NOW), secureItems: [], signInSaved: true });
    expect(saved).toContain(SAVE_SIGN_IN_COPY.saved('springfieldwater.gov'));
    expect(saved).toContain(SAVE_SIGN_IN_COPY.detailAfterSave);
    expect(buttons(saved)).toEqual(['Continue', 'Dismiss']);
  });
});

describe('the ask_secure_detail card', () => {
  function card(over: Partial<React.ComponentProps<typeof SecureRequestCard>> = {}) {
    return render(
      <SecureRequestCard
        input={secureRequestFixture}
        state="pending"
        onAdd={noop}
        onSkip={noop}
        onOpenSettings={noop}
        {...over}
      />,
    );
  }

  test('pending: the title, the reason, Skip and Add', () => {
    const html = card();
    expect(html).toContain('Add your sign-in for springfieldwater.gov');
    expect(html).toContain(secureRequestFixture.reason);
    expect(textButtons(html)).toEqual(['Skip', 'Add']);
    expect(doc(html).querySelector('[data-request-state="pending"]')).not.toBeNull();
  });

  test('opening disables the actions; saved and skipped collapse to one line', () => {
    const opening = card({ state: 'opening' });
    expect([...doc(opening).querySelectorAll('button[disabled]')]).toHaveLength(2);
    const saved = card({ state: 'saved' });
    expect(saved).toContain('Saved. Albatross can use it on springfieldwater.gov.');
    expect(textButtons(saved)).toEqual([]);
    expect(card({ state: 'skipped' })).toContain('Skipped');
  });

  test('already saved names the item and offers Use it', () => {
    const html = card({
      input: { kind: 'sign_in', site: 'chase.com', reason: 'To pay the bill.' },
      existing: items[0],
      onUseExisting: noop,
    });
    expect(html).toContain('Your sign-in for chase.com is saved');
    expect(textButtons(html)).toEqual(['Open Settings', 'Use it']);
  });
});

describe('the composer notice', () => {
  test('a Social Security number offers Save and Send without it; a card only Send without it', () => {
    const ssn = render(<SecretNotice kind="ssn" canSave onSave={noop} onSendWithout={noop} />);
    expect(ssn).toContain('role="status"');
    expect(ssn).toContain('This looks like a Social Security number. Albatross does not send it.');
    expect(textButtons(ssn)).toEqual(['Save in Passwords and IDs', 'Send without it']);
    const cardHtml = render(<SecretNotice kind="card" canSave={false} onSave={noop} onSendWithout={noop} />);
    expect(textButtons(cardHtml)).toEqual(['Send without it']);
  });
});
