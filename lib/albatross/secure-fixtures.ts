// Invented fixtures for Passwords and IDs: four items without values, a short
// use history, an allow_secure run in each state, a sign-in handoff with the
// save offer, and one ask_secure_detail request. The dev harness
// (app/dev/secure-preview) and the tests read them. Sam Rivera is not a real
// person; the hints hold no real number.

import type { SecureItemView, SecureRequestInput, SecureUseView } from '../secure/contract';
import type { AllowScope } from './secure-view';
import type { ThreadRunView } from './thread-contract';
import { threadRunFixtures } from './thread-fixtures';

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

export const SECURE_FIXTURE_IDS = {
  chase: 'item_chase',
  license: 'item_license',
  dateOfBirth: 'item_dob',
  openai: 'item_openai',
} as const;

export function secureItemsFixture(now = Date.now()): SecureItemView[] {
  return [
    {
      id: SECURE_FIXTURE_IDS.chase,
      kind: 'sign_in',
      label: 'Chase',
      sites: ['chase.com'],
      hints: { username: 's•••@example.com', password: '••••••••' },
      facts: {},
      createdAt: now - 12 * DAY,
      updatedAt: now - 12 * DAY,
      lastUsedAt: now - 34 * MINUTE,
    },
    {
      id: SECURE_FIXTURE_IDS.license,
      kind: 'id_number',
      label: "Driver's license",
      sites: ['ny.gov'],
      hints: { number: 'ends 4821', expires: 'saved', name_on_id: 'saved' },
      facts: { type: 'drivers_license', region: 'NY', expires: '2029-06' },
      createdAt: now - 6 * DAY,
      updatedAt: now - 6 * DAY,
      lastUsedAt: now - 34 * MINUTE,
    },
    {
      id: SECURE_FIXTURE_IDS.dateOfBirth,
      kind: 'date_of_birth',
      label: 'Date of birth',
      sites: [],
      hints: { date: 'saved' },
      facts: {},
      createdAt: now - 6 * DAY,
      updatedAt: now - 6 * DAY,
      lastUsedAt: null,
    },
    {
      id: SECURE_FIXTURE_IDS.openai,
      kind: 'api_key',
      label: 'OpenAI',
      sites: ['api.openai.com'],
      hints: { key: 'sk-…f3a2' },
      facts: { header: 'Authorization: Bearer' },
      createdAt: now - 3 * DAY,
      updatedAt: now - 3 * DAY,
      lastUsedAt: now - 2 * DAY,
    },
  ];
}

export function secureUsesFixture(
  now = Date.now(),
  itemId: string = SECURE_FIXTURE_IDS.license,
): SecureUseView[] {
  const work = { workId: 'work_registration', workTitle: 'Renew the car registration' };
  return [
    {
      id: 'use_1',
      itemId,
      field: 'expires',
      site: 'dmv.ny.gov',
      outcome: 'typed',
      at: now - 34 * MINUTE,
      ...work,
    },
    {
      id: 'use_2',
      itemId,
      field: 'number',
      site: 'dmv.ny.gov',
      outcome: 'typed',
      at: now - 34 * MINUTE,
      ...work,
    },
    {
      id: 'use_3',
      itemId,
      field: null,
      site: 'ny.gov',
      outcome: 'allowed_always',
      at: now - 35 * MINUTE,
      ...work,
    },
    { id: 'use_4', itemId, field: null, site: 'ny.gov', outcome: 'asked', at: now - 36 * MINUTE, ...work },
    {
      id: 'use_5',
      itemId,
      field: 'number',
      site: 'ny-dmv-renewals.com',
      outcome: 'refused_site',
      at: now - 5 * DAY,
      ...work,
    },
  ];
}

const ALLOW_LOG = [
  'Opened dmv.ny.gov',
  'Read the renewal notice: plate ABC 1234, due October 31',
  'Typed the plate number into the renewal form',
  "The form asks for your driver's license number and its expiry date",
];

/** An allow_secure run: pending, or with the stored answer. */
export function allowRunFixture(now = Date.now(), answered: AllowScope | null = null): ThreadRunView {
  const base = threadRunFixtures(now).signIn;
  return {
    ...base,
    id: answered ? `run_allow_${answered}` : 'run_allow',
    stepKey: 'step-renew',
    stepTitle: 'Renew the registration online',
    state: 'handed_off',
    outcome: 'needs_answer',
    summary:
      "Opened the renewal form on dmv.ny.gov and typed the plate number from the notice. The form also asks for your driver's license number and its expiry date.",
    log: ALLOW_LOG.map((text, index) => ({ at: now - (6 - index) * MINUTE, text })),
    next: {
      kind: 'allow_secure',
      label: 'Answer',
      detail: "Use your saved Driver's license on ny.gov?",
      doneLabel: null,
      allow: {
        itemId: SECURE_FIXTURE_IDS.license,
        kind: 'id_number',
        itemLabel: "Driver's license",
        fieldLabels: ['Number', 'Expiry date'],
        site: 'ny.gov',
        host: 'dmv.ny.gov',
      },
      saveSignIn: null,
      allowAnswer: answered ? { scope: answered, at: now - MINUTE } : null,
      target: { kind: 'secure', id: SECURE_FIXTURE_IDS.license, url: 'https://ny.gov' },
    },
    question: null,
    createdAt: now - 7 * MINUTE,
    updatedAt: now - 2 * MINUTE,
    finishedAt: now - 2 * MINUTE,
  } as ThreadRunView;
}

/** A sign-in handoff that also offers to save a sign-in for its site (V13). */
export function signInOfferRunFixture(now = Date.now()): ThreadRunView {
  const base = threadRunFixtures(now).signIn;
  return {
    ...base,
    id: 'run_sign_in_offer',
    stepTitle: 'Pay the water bill',
    summary: 'Opened springfieldwater.gov. The site asks you to sign in before the bill shows.',
    next: {
      ...base.next,
      kind: 'sign_in',
      label: 'Sign in',
      detail: 'Sign in to springfieldwater.gov in the page, then press Continue.',
      doneLabel: 'I signed in',
      allow: null,
      saveSignIn: { site: 'springfieldwater.gov' },
      allowAnswer: null,
      target: { kind: 'session', id: 'session_water' },
    },
  } as ThreadRunView;
}

export const secureRequestFixture: SecureRequestInput = {
  kind: 'sign_in',
  label: 'Springfield Water',
  site: 'springfieldwater.gov',
  reason: 'To pay the water bill, Albatross must sign in to your account.',
};
