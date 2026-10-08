import { describe, expect, test } from 'bun:test';
import { readyForYouRowsWithSecure } from '../components/report/ReadyForYou';
import {
  allowRunFixture,
  SECURE_FIXTURE_IDS,
  secureItemsFixture,
  secureRequestFixture,
  secureUsesFixture,
  signInOfferRunFixture,
} from '../lib/albatross/secure-fixtures';
import {
  ALLOW_COPY,
  allowAlwaysLabel,
  allowAnswerOf,
  allowQuestion,
  allowReason,
  allowReceipt,
  checkSecureValues,
  deleteDialogCopy,
  draftWithMarker,
  expiryWarning,
  idPhrase,
  lastUsedLine,
  monthYear,
  REFUSAL_COPY,
  readyForYouAllowLine,
  refusalLine,
  regionName,
  SECURE_COPY,
  savedMarker,
  saveSignInOffer,
  secretNoticeCanSave,
  secretNoticeLine,
  secretToItem,
  secureCountLine,
  secureFieldRows,
  secureGroups,
  secureItemHint,
  secureItemLine,
  secureRequestExisting,
  secureRequestExistsTitle,
  secureRequestTitle,
  secureUseLine,
  secureUseTimeLine,
  secureUseTone,
  sitePreview,
} from '../lib/albatross/secure-view';
import { SETTINGS_TAB_META, settingsNavGroups } from '../lib/albatross/settings-nav';
import { SETTINGS_TABS, settingsTabFromSearch } from '../lib/albatross/teach-ui';
import { threadDetailFixture, threadRunFixtures } from '../lib/albatross/thread-fixtures';
import {
  PENDING_FORM_ATTRIBUTE,
  runBlockDismisses,
  runQuestionAnswered,
  runStateLine,
  threadStateInput,
} from '../lib/albatross/thread-view';
import { detectSecretShapes } from '../lib/secure/redact';

const NOW = Date.UTC(2026, 9, 8, 13, 46, 0);
const items = secureItemsFixture(NOW);
const byId = Object.fromEntries(items.map((item) => [item.id, item]));
const license = byId[SECURE_FIXTURE_IDS.license];
const chase = byId[SECURE_FIXTURE_IDS.chase];

describe('the settings tab', () => {
  test('Passwords and IDs sits after Personal details in the You group and can hide', () => {
    const ids = SETTINGS_TABS.map((tab) => tab.id);
    expect(ids.indexOf('secure')).toBe(ids.indexOf('personal') + 1);
    expect(SETTINGS_TAB_META.secure.group).toBe('you');
    expect(settingsTabFromSearch('secure')).toBe('secure');
    const you = settingsNavGroups().find((group) => group.id === 'you');
    expect(you?.items.map((item) => item.label)).toContain('Passwords and IDs');
    const hidden = settingsNavGroups(['secure']).find((group) => group.id === 'you');
    expect(hidden?.items.map((item) => item.id)).not.toContain('secure');
  });

  test('no copy says confirm or verify, and no state copy uses an -ing form', () => {
    const copy = [
      ...(Object.values(SECURE_COPY) as unknown[]).filter(
        (value): value is string => typeof value === 'string',
      ),
      ...Object.values(ALLOW_COPY),
    ];
    for (const line of copy) expect(line).not.toMatch(/\b(confirm|verify)/i);
    // State copy carries no -ing verb form (thread decision 6); "Nothing" in the cancel line is a noun.
    for (const line of [ALLOW_COPY.once, ALLOW_COPY.deny, ALLOW_COPY.fine, ALLOW_COPY.cancelled])
      expect(line.replace(/\bNothing\b/, '')).not.toMatch(/\b\w+ing\b/);
  });
});

describe('the list', () => {
  test('groups in a fixed order, with the date of birth as a slot in IDs', () => {
    const groups = secureGroups(items);
    expect(groups.map((group) => group.kind)).toEqual(['sign_in', 'id_number', 'api_key']);
    expect(groups[1].dateOfBirth?.id).toBe(SECURE_FIXTURE_IDS.dateOfBirth);
    expect(groups[1].items.map((item) => item.id)).toEqual([SECURE_FIXTURE_IDS.license]);
    const idsOnly = secureGroups([license]);
    expect(idsOnly.map((group) => group.kind)).toEqual(['id_number']);
    expect(idsOnly[0].dateOfBirth).toBeNull();
    expect(secureGroups([]).map((group) => group.kind)).toEqual(['id_number']);
  });

  test('the count line', () => {
    expect(secureCountLine(items)).toBe('4 saved');
    expect(secureCountLine([])).toBe('Nothing saved yet');
  });

  test('a row line shows the site, the masked hints, and the safe facts, never a value', () => {
    expect(secureItemLine(chase)).toBe('chase.com · s•••@example.com · ••••••••');
    expect(secureItemLine(license)).toBe('New York · ends 4821 · expires June 2029');
    expect(secureItemLine(byId[SECURE_FIXTURE_IDS.dateOfBirth])).toBe('Saved');
    expect(secureItemLine(byId[SECURE_FIXTURE_IDS.openai])).toBe(
      'api.openai.com · sk-…f3a2 · Authorization: Bearer',
    );
  });

  test('the hint line: the last use, or the no-sites line for an unused ID', () => {
    expect(secureItemHint(chase, NOW, { timeZone: 'UTC' })).toBe('Last used today, 1:12 PM');
    expect(secureItemHint(byId[SECURE_FIXTURE_IDS.dateOfBirth], NOW)).toBe(SECURE_COPY.noSites);
    expect(secureItemHint(byId[SECURE_FIXTURE_IDS.openai], NOW, { timeZone: 'UTC' })).toBe('Last used Oct 6');
    expect(lastUsedLine(NOW - 86_400_000, NOW, { timeZone: 'UTC' })).toBe('Last used yesterday');
    expect(lastUsedLine(null, NOW)).toBe('Not used yet');
  });

  test('the field rows of the open item carry labels and hints', () => {
    expect(secureFieldRows(license)).toEqual([
      { field: 'number', label: 'Number', hint: 'ends 4821' },
      { field: 'expires', label: 'Expiry date', hint: 'June 2029' },
      { field: 'name_on_id', label: 'Name on the ID', hint: 'Saved' },
    ]);
    expect(monthYear('2029-06')).toBe('June 2029');
    expect(monthYear('soon')).toBe('soon');
    expect(regionName('ny')).toBe('New York');
    expect(regionName('Ontario')).toBe('Ontario');
  });

  test('use rows: one outcome line and tone each', () => {
    const uses = secureUsesFixture(NOW);
    expect(secureUseLine(uses[0], 'id_number')).toBe('Typed the expiry date');
    expect(secureUseLine(uses[1], 'id_number')).toBe('Typed the number');
    expect(secureUseLine({ ...uses[1], site: 'secure.chase.com' }, 'sign_in')).toBe(
      'Signed in to secure.chase.com',
    );
    expect(secureUseLine(uses[2], 'id_number')).toBe('You allowed it on ny.gov from now on');
    expect(secureUseLine(uses[3], 'id_number')).toBe('Asked to use it on ny.gov');
    expect(secureUseLine(uses[4], 'id_number')).toBe('Refused: not one of its sites');
    expect(secureUseLine({ ...uses[2], outcome: 'allowed_once' }, 'id_number')).toBe(
      'You allowed it on ny.gov for one run',
    );
    expect(secureUseLine({ ...uses[2], outcome: 'denied' }, 'id_number')).toBe(
      'You did not allow it on ny.gov',
    );
    expect(secureUseLine({ ...uses[2], outcome: 'sent', site: 'api.openai.com' }, 'api_key')).toBe(
      'Sent to api.openai.com',
    );
    expect(secureUseTone('typed')).toBe('did');
    expect(secureUseTone('refused_site')).toBe('warn');
    expect(secureUseTone('denied')).toBe('quiet');
    expect(secureUseTimeLine(uses[0].at, NOW, { timeZone: 'UTC' })).toBe('Today, 1:12 PM');
    expect(secureUseTimeLine(uses[4].at, NOW, { timeZone: 'UTC' })).toBe('Oct 3, 1:46 PM');
  });

  test('the delete dialog says what stops', () => {
    expect(deleteDialogCopy(chase)).toEqual({
      title: 'Delete Chase?',
      body: 'Albatross can no longer sign in to chase.com for you. A run that reaches the Chase sign-in page stops and asks you.',
    });
    expect(deleteDialogCopy(license).title).toBe("Delete your driver's license number?");
    expect(deleteDialogCopy(license).body).toContain('ny.gov');
    expect(deleteDialogCopy(byId[SECURE_FIXTURE_IDS.dateOfBirth]).title).toBe('Delete your date of birth?');
    expect(deleteDialogCopy(byId[SECURE_FIXTURE_IDS.openai]).body).toBe(
      'Albatross can no longer call api.openai.com for you.',
    );
  });
});

describe('the add sheet checks', () => {
  test('the site preview names the site and the typed host', () => {
    expect(sitePreview('https://secure.chase.com/login', 'sign_in')).toEqual({
      ok: true,
      site: 'chase.com',
      line: 'Covers chase.com and its pages, such as secure.chase.com.',
    });
    expect(sitePreview('chase.com', 'sign_in')).toEqual({
      ok: true,
      site: 'chase.com',
      line: 'Covers chase.com and all its pages.',
    });
    expect(sitePreview('https://api.openai.com/v1', 'api_key')).toEqual({
      ok: true,
      site: 'api.openai.com',
      line: 'Albatross calls api.openai.com only.',
    });
    expect(sitePreview('', 'sign_in')).toBeNull();
    expect(sitePreview('not a site', 'sign_in')?.ok).toBe(false);
    expect(sitePreview('localhost', 'sign_in')?.ok).toBe(false);
  });

  test('required fields, the nine digits of a Social Security number, and a future date of birth', () => {
    expect(checkSecureValues('sign_in', {}, { site: '' })).toEqual({
      username: 'Type the username or email.',
      password: 'Type the password.',
      site: 'Type the site, such as chase.com.',
    });
    expect(checkSecureValues('sign_in', { username: 'sam', password: 'x' }, { site: 'chase.com' })).toEqual(
      {},
    );
    expect(checkSecureValues('id_number', { type: 'ssn', number: '12345' })).toEqual({
      number: 'Use nine digits.',
    });
    expect(checkSecureValues('id_number', { type: 'drivers_license', number: '' })).toEqual({
      number: 'Type the number.',
    });
    expect(checkSecureValues('date_of_birth', { date: '2999-01-01' })).toEqual({ date: 'Check the date.' });
    expect(checkSecureValues('date_of_birth', { date: '1990-04-12' })).toEqual({});
    expect(checkSecureValues('api_key', { key: '' }, { site: '' })).toEqual({
      key: 'Type the key.',
      site: 'Type the host, such as api.openai.com.',
    });
  });

  test('a card number and a refused label are refused before the server sees them', () => {
    // A test card number built from parts; it is not a real card.
    const card = ['4242', '4242', '4242', '4242'].join(' ');
    expect(checkSecureValues('id_number', { type: 'other', number: card }, { label: 'Library' }).number).toBe(
      REFUSAL_COPY.card,
    );
    expect(
      checkSecureValues('api_key', { key: 'abc' }, { label: 'One-time code', site: 'api.example.com' }).label,
    ).toBe(REFUSAL_COPY.code);
    expect(
      checkSecureValues('api_key', { key: 'abc' }, { label: 'Routing number', site: 'api.example.com' })
        .label,
    ).toBe(REFUSAL_COPY.bank);
    expect(refusalLine('bank', 'server text')).toBe(REFUSAL_COPY.bank);
    expect(refusalLine('other', 'server text')).toBe('server text');
  });

  test('an expired ID warns and still saves', () => {
    expect(expiryWarning('2024-06-03', NOW)).toBe('This ID expired on June 3, 2024. You can still save it.');
    expect(expiryWarning('2029-06-03', NOW)).toBeNull();
    expect(expiryWarning(undefined, NOW)).toBeNull();
  });
});

describe('the allow block', () => {
  const allow = allowRunFixture(NOW).next?.allow;
  if (!allow) throw new Error('fixture');

  test('the question names the site and the item; the reason names the host and the fields', () => {
    expect(allowQuestion(allow)).toBe("Use your driver's license number on ny.gov?");
    expect(allowReason(allow)).toBe(
      'dmv.ny.gov asks for the number and the expiry date. Albatross types them on the page. They do not appear in this conversation.',
    );
    expect(allowReason({ ...allow, host: 'ny.gov', fieldLabels: ['Number'] })).toBe(
      'The page asks for the number. Albatross types it on the page. It does not appear in this conversation.',
    );
    expect(allowQuestion({ kind: 'id_number', itemLabel: 'Social Security number', site: 'irs.gov' })).toBe(
      'Use your Social Security number on irs.gov?',
    );
    expect(allowQuestion({ kind: 'id_number', itemLabel: 'State ID', site: 'ny.gov' })).toBe(
      'Use your state ID number on ny.gov?',
    );
    expect(allowQuestion({ kind: 'date_of_birth', itemLabel: 'Date of birth', site: 'ny.gov' })).toBe(
      'Use your date of birth on ny.gov?',
    );
    expect(
      allowReason({
        kind: 'date_of_birth',
        fieldLabels: ['Date of birth'],
        site: 'ny.gov',
        host: 'dmv.ny.gov',
      }),
    ).toBe(
      'dmv.ny.gov asks for it. Albatross types it on the page. It does not appear in this conversation.',
    );
    expect(idPhrase('Passport')).toBe('passport number');
    expect(readyForYouAllowLine(allow)).toBe(
      "Albatross needs your answer: use your driver's license number on ny.gov?",
    );
  });

  test('the second button names the site, with the contract label for long sites', () => {
    expect(allowAlwaysLabel('ny.gov')).toBe('Always on ny.gov');
    expect(allowAlwaysLabel('a-very-long-site-name-for-a-button.example')).toBe(ALLOW_COPY.alwaysOnThisSite);
  });

  test('the receipts of the three answers', () => {
    expect(allowReceipt('once', 'ny.gov')).toBe('Allowed once on ny.gov.');
    expect(allowReceipt('always', 'ny.gov')).toBe('Always allowed on ny.gov.');
    expect(allowReceipt('deny', 'ny.gov')).toBe('Not allowed.');
    expect(allowAnswerOf(allowRunFixture(NOW))).toBeNull();
    expect(allowAnswerOf(allowRunFixture(NOW, 'always'))?.scope).toBe('always');
    expect(allowAnswerOf(threadRunFixtures(NOW).signIn)).toBeNull();
  });

  test('an open allow block is a pending question; an answered one is not', () => {
    // The thread fixture's current step is step-1; the allow run must sit on it to count.
    const pending = { ...allowRunFixture(NOW), stepKey: 'step-1' };
    const answered = { ...allowRunFixture(NOW, 'once'), stepKey: 'step-1' };
    expect(runStateLine(pending)).toEqual({ text: 'Needs your answer', tone: 'waiting' });
    expect(runStateLine(answered)).toEqual({ text: 'Answered', tone: 'quiet' });
    expect(runQuestionAnswered(pending)).toBe(false);
    expect(runQuestionAnswered(answered)).toBe(true);
    expect(runBlockDismisses(pending)).toBe(false);
    expect(runBlockDismisses(answered)).toBe(false);
    expect(runBlockDismisses(threadRunFixtures(NOW).signIn)).toBe(true);
    const detail = threadDetailFixture(NOW);
    expect(threadStateInput(detail, [pending]).pendingQuestion).toBe(true);
    expect(threadStateInput(detail, [answered]).pendingQuestion).toBe(false);
    expect(PENDING_FORM_ATTRIBUTE).toBe('data-thread-pending-form');
  });

  test('the Brief row carries the question and one Answer button that opens the thread', () => {
    const rows = readyForYouRowsWithSecure([
      { workId: 'work_registration', workTitle: 'Renew the car registration', run: allowRunFixture(NOW) },
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0].line).toBe("Albatross needs your answer: use your driver's license number on ny.gov?");
    expect(rows[0].action).toEqual({ label: 'Answer', behaviour: { kind: 'open_work' } });
  });
});

describe('the ask_secure_detail card and the save offer', () => {
  test('titles by kind', () => {
    expect(secureRequestTitle(secureRequestFixture)).toBe('Add your sign-in for springfieldwater.gov');
    expect(secureRequestTitle({ kind: 'id_number', label: 'Passport' })).toBe('Add your passport');
    expect(secureRequestTitle({ kind: 'date_of_birth' })).toBe('Add your date of birth');
    expect(secureRequestTitle({ kind: 'api_key', site: 'api.openai.com' })).toBe(
      'Add your key for api.openai.com',
    );
    expect(secureRequestExistsTitle(secureRequestFixture)).toBe(
      'Your sign-in for springfieldwater.gov is saved',
    );
  });

  test('already saved comes from the client list: the site, its pages, the one date of birth, or the label', () => {
    expect(secureRequestExisting(items, secureRequestFixture)).toBeNull();
    expect(secureRequestExisting(items, { kind: 'sign_in', site: 'secure.chase.com' })?.id).toBe(
      SECURE_FIXTURE_IDS.chase,
    );
    expect(secureRequestExisting(items, { kind: 'date_of_birth' })?.id).toBe(SECURE_FIXTURE_IDS.dateOfBirth);
    expect(secureRequestExisting(items, { kind: 'id_number', label: "driver's license" })?.id).toBe(
      SECURE_FIXTURE_IDS.license,
    );
    expect(secureRequestExisting(items, { kind: 'id_number', label: 'Passport' })).toBeNull();
    expect(secureRequestExisting(items, { kind: 'api_key', site: 'api.openai.com' })?.id).toBe(
      SECURE_FIXTURE_IDS.openai,
    );
  });

  test('a sign-in handoff offers to save a sign-in only when none covers its site', () => {
    const run = signInOfferRunFixture(NOW);
    expect(saveSignInOffer(run, [])).toEqual({ site: 'springfieldwater.gov' });
    expect(saveSignInOffer(run, items)).toEqual({ site: 'springfieldwater.gov' });
    const covered = { ...run, next: { ...run.next, saveSignIn: { site: 'chase.com' } } } as typeof run;
    expect(saveSignInOffer(covered, items)).toBeNull();
    expect(saveSignInOffer(threadRunFixtures(NOW).signIn, [])).toBeNull();
    expect(saveSignInOffer(allowRunFixture(NOW), [])).toBeNull();
  });
});

describe('the composer notice', () => {
  test('one line per kind; cards and an off store have no save action', () => {
    expect(secretNoticeLine('ssn')).toBe(
      'This looks like a Social Security number. Albatross does not send it.',
    );
    expect(secretNoticeLine('api_key')).toBe('This looks like a key. Albatross does not send it.');
    expect(secretNoticeLine('card')).toContain('does not keep card numbers yet');
    expect(secretNoticeCanSave('ssn', true)).toBe(true);
    expect(secretNoticeCanSave('card', true)).toBe(false);
    expect(secretNoticeCanSave('ssn', false)).toBe(false);
  });

  test('the saved marker replaces the value in the draft and the sheet gets the value', () => {
    const draft = 'my number is 123-45-6789 for the form';
    const [match] = detectSecretShapes(draft);
    expect(match.kind).toBe('ssn');
    expect(savedMarker('ssn')).toBe('[saved: Social Security number]');
    expect(draftWithMarker(draft, match, savedMarker('ssn'))).toBe(
      'my number is [saved: Social Security number] for the form',
    );
    expect(secretToItem('ssn', draft.slice(match.start, match.end))).toEqual({
      kind: 'id_number',
      values: { type: 'ssn', number: '123-45-6789' },
    });
    expect(secretToItem('api_key', 'sk-x')).toEqual({ kind: 'api_key', values: { key: 'sk-x' } });
    expect(secretToItem('card', '4242')).toBeNull();
  });
});
