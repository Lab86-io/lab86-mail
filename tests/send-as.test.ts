import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { __setGoogleHttpDepsForTest } from '../lib/google/http';
import {
  __setGoogleSendAsDepsForTest,
  forgetGmailSendAs,
  type GmailSendAs,
  gmailSendAsIdentities,
  gmailSendAsToIdentity,
  listGmailSendAs,
  SEND_AS_CACHE_MS,
} from '../lib/google/send-as';
import {
  __setSendAsDepsForTest,
  defaultSendAsFor,
  loadSendAsIdentities,
  loadSendAsPage,
  mailboxIdentity,
  resolveComposeFrom,
  SendAsUnavailableError,
} from '../lib/mail/send-as';
import {
  addressesInHeader,
  anchorSendAs,
  composerFromChoices,
  defaultSendAs,
  fromChoiceKey,
  isBareAddress,
  isSendAsError,
  requireUsableSendAs,
  SendAsError,
  type SendAsIdentity,
  selectedFromChoice,
} from '../lib/shared/send-as';

const PRIMARY: GmailSendAs = {
  sendAsEmail: 'ann@gmail.com',
  displayName: 'Ann Lee',
  isPrimary: true,
  isDefault: false,
  signature: '',
};
const WORK: GmailSendAs = {
  sendAsEmail: 'Ann@Work.example',
  displayName: 'Ann at Work',
  replyToAddress: 'team@work.example',
  signature: '<b>Ann</b>',
  isDefault: true,
  treatAsAlias: true,
  verificationStatus: 'accepted',
};
const PENDING: GmailSendAs = { sendAsEmail: 'side@club.example', verificationStatus: 'pending' };

const identities = gmailSendAsIdentities([WORK, PRIMARY, PENDING]);

const GOOGLE_ACCOUNT = {
  accountId: 'acct-1',
  email: 'ann@gmail.com',
  grantId: 'google:11111111-1111-1111-1111-111111111111',
  displayName: 'Ann Lee',
};
const NYLAS_ACCOUNT = {
  accountId: 'acct-2',
  email: 'ann@outlook.example',
  grantId: 'nylas-grant-2',
  displayName: 'Ann',
};

afterEach(() => {
  __setGoogleSendAsDepsForTest();
  __setSendAsDepsForTest();
  __setGoogleHttpDepsForTest();
});

describe('Gmail send-as mapping', () => {
  test('an entry maps to an identity; only the primary and accepted addresses can send', () => {
    expect(gmailSendAsToIdentity(WORK)).toEqual({
      email: 'Ann@Work.example',
      displayName: 'Ann at Work',
      isPrimary: false,
      isDefault: true,
      verificationStatus: 'accepted',
      replyTo: 'team@work.example',
      hasProviderSignature: true,
      usable: true,
    });
    expect(gmailSendAsToIdentity(PRIMARY)).toMatchObject({
      verificationStatus: 'accepted',
      usable: true,
      hasProviderSignature: false,
    });
    expect(gmailSendAsToIdentity(PENDING)).toMatchObject({ verificationStatus: 'pending', usable: false });
    expect(gmailSendAsToIdentity({ sendAsEmail: 'x@y.example', verificationStatus: 'odd' })).toMatchObject({
      verificationStatus: 'unknown',
      usable: false,
    });
    expect(gmailSendAsToIdentity({ displayName: 'No address' })).toBeNull();
  });

  test('the list puts the primary first, drops repeats, and adds a missing primary', () => {
    expect(identities.map((identity) => identity.email)).toEqual([
      'ann@gmail.com',
      'Ann@Work.example',
      'side@club.example',
    ]);
    expect(gmailSendAsIdentities([WORK, { ...WORK, displayName: 'Again' }])).toHaveLength(1);
    const added = gmailSendAsIdentities([PENDING], 'me@gmail.com');
    expect(added[0]).toMatchObject({ email: 'me@gmail.com', isPrimary: true, isDefault: true, usable: true });
    // An entry for the mailbox address without the primary flag becomes the primary.
    const marked = gmailSendAsIdentities(
      [{ sendAsEmail: 'ME@gmail.com', verificationStatus: 'pending' }],
      'me@gmail.com',
    );
    expect(marked).toHaveLength(1);
    expect(marked[0]).toMatchObject({ isPrimary: true, usable: true, verificationStatus: 'accepted' });
    expect(gmailSendAsIdentities(undefined)).toEqual([]);
  });

  test('the list reads users.settings.sendAs through the Gmail client', async () => {
    const urls: string[] = [];
    __setGoogleHttpDepsForTest({
      getGoogleAccessToken: async () => 'token',
      invalidateGoogleAccessToken: () => {},
      fetch: async (input: string) => {
        urls.push(input);
        return Response.json({ sendAs: [PRIMARY, WORK] });
      },
    });
    const listed = await listGmailSendAs(GOOGLE_ACCOUNT.grantId, GOOGLE_ACCOUNT.email);
    expect(urls).toEqual(['https://gmail.googleapis.com/gmail/v1/users/me/settings/sendAs']);
    expect(listed.map((identity) => identity.email)).toEqual(['ann@gmail.com', 'Ann@Work.example']);
  });

  test('the list is cached for ten minutes per grant, shared while it loads, and forgotten on demand', async () => {
    let now = 1_000_000;
    let reads = 0;
    __setGoogleSendAsDepsForTest({
      now: () => now,
      fetchSendAs: async () => {
        reads += 1;
        return { sendAs: [PRIMARY] };
      },
    });
    const [first, second] = await Promise.all([listGmailSendAs('google:a'), listGmailSendAs('google:a')]);
    expect(first).toEqual(second);
    expect(reads).toBe(1);
    now += SEND_AS_CACHE_MS - 1;
    await listGmailSendAs('google:a');
    expect(reads).toBe(1);
    now += 1;
    await listGmailSendAs('google:a');
    expect(reads).toBe(2);
    forgetGmailSendAs('google:a');
    await listGmailSendAs('google:a');
    expect(reads).toBe(3);
    await listGmailSendAs('google:b');
    expect(reads).toBe(4);
  });

  test('a forget during a read keeps the old list out of the cache', async () => {
    let reads = 0;
    let release: (value: { sendAs: GmailSendAs[] }) => void = () => {};
    __setGoogleSendAsDepsForTest({
      fetchSendAs: async () => {
        reads += 1;
        if (reads === 1) return await new Promise((resolve) => (release = resolve));
        return { sendAs: [PRIMARY, WORK] };
      },
    });
    const stale = listGmailSendAs('google:d');
    forgetGmailSendAs('google:d');
    // A read after the forget does not wait for the old one.
    expect(await listGmailSendAs('google:d')).toHaveLength(2);
    release({ sendAs: [PRIMARY] });
    expect(await stale).toHaveLength(1);
    expect(await listGmailSendAs('google:d')).toHaveLength(2);
    expect(reads).toBe(2);
  });

  test('each caller gets its own mailbox address added when Gmail lists no primary', async () => {
    __setGoogleSendAsDepsForTest({ fetchSendAs: async () => ({ sendAs: [WORK] }) });
    const [one, two] = await Promise.all([
      listGmailSendAs('google:e', 'one@gmail.com'),
      listGmailSendAs('google:e', 'two@gmail.com'),
    ]);
    expect(one[0].email).toBe('one@gmail.com');
    expect(two[0].email).toBe('two@gmail.com');
    expect(await listGmailSendAs('google:e')).toHaveLength(1);
  });

  test('a failed read is not cached', async () => {
    let reads = 0;
    __setGoogleSendAsDepsForTest({
      fetchSendAs: async () => {
        reads += 1;
        if (reads === 1) throw new Error('Gmail is down');
        return { sendAs: [PRIMARY] };
      },
    });
    await expect(listGmailSendAs('google:c')).rejects.toThrow('Gmail is down');
    expect(await listGmailSendAs('google:c')).toHaveLength(1);
  });

  test('the cache keeps at most 1000 grants', async () => {
    let reads = 0;
    __setGoogleSendAsDepsForTest({
      fetchSendAs: async () => {
        reads += 1;
        return { sendAs: [PRIMARY] };
      },
    });
    for (let index = 0; index <= 1000; index += 1) await listGmailSendAs(`google:${index}`);
    expect(reads).toBe(1001);
    await listGmailSendAs('google:1000');
    expect(reads).toBe(1001);
    await listGmailSendAs('google:0');
    expect(reads).toBe(1002);
  });
});

describe('send-as rules', () => {
  test('a usable address passes; an unknown or unverified one is a SendAsError', () => {
    expect(requireUsableSendAs(identities, 'ann@WORK.example').email).toBe('Ann@Work.example');
    const unknown = (() => {
      try {
        requireUsableSendAs(identities, 'stranger@x.example');
      } catch (error) {
        return error as SendAsError;
      }
    })();
    expect(unknown).toBeInstanceOf(SendAsError);
    expect(unknown).toMatchObject({ statusCode: 400, code: 'from_unknown' });
    expect(() => requireUsableSendAs(identities, 'side@club.example')).toThrow('Gmail did not accept');
    expect(isSendAsError(new SendAsError('from_unsupported'))).toBe(true);
    expect(isSendAsError(Object.assign(new Error('x'), { name: 'SendAsError' }))).toBe(true);
    expect(isSendAsError(new Error('x'))).toBe(false);
  });

  test("the default is Gmail's default address, else the primary", () => {
    expect(defaultSendAs(identities)?.email).toBe('Ann@Work.example');
    const pendingDefault = gmailSendAsIdentities([PRIMARY, { ...PENDING, isDefault: true }]);
    expect(defaultSendAs(pendingDefault)?.email).toBe('ann@gmail.com');
    expect(defaultSendAs([])).toBeUndefined();
  });

  test('addresses come out of headers lowercased, in order', () => {
    expect(addressesInHeader('"Lee, Ann" <Ann@Work.example>, bob@x.example')).toEqual([
      'ann@work.example',
      'bob@x.example',
    ]);
    expect(addressesInHeader(undefined)).toEqual([]);
    expect(isBareAddress('ann@work.example')).toBe(true);
    expect(isBareAddress('Ann <ann@work.example>')).toBe(false);
    expect(isBareAddress('no-at-sign')).toBe(false);
    expect(isBareAddress(7)).toBe(false);
  });

  test('a reply goes from the address the original was sent to, from, cc, or delivered to', () => {
    const anchor = { from: 'Bob <bob@x.example>', to: 'ANN@work.example', cc: 'ann@gmail.com' };
    expect(anchorSendAs(identities, anchor)?.email).toBe('Ann@Work.example');
    // A follow-up on the user's own message keeps its From.
    expect(anchorSendAs(identities, { from: 'ann@gmail.com', to: 'ann@work.example' })?.email).toBe(
      'ann@gmail.com',
    );
    expect(
      anchorSendAs(identities, { from: 'bob@x.example', to: 'list@x.example', cc: 'ann@gmail.com' })?.email,
    ).toBe('ann@gmail.com');
    expect(anchorSendAs(identities, { to: 'list@x.example', deliveredTo: 'ann@work.example' })?.email).toBe(
      'Ann@Work.example',
    );
    // An address that Gmail did not verify is never chosen.
    expect(anchorSendAs(identities, { to: 'side@club.example' })).toBeUndefined();
  });

  test('composer rows list each mailbox, its usable addresses, and select by address', () => {
    const choices = composerFromChoices(
      [
        { accountId: 'acct-1', email: 'ann@gmail.com', displayName: 'Ann Lee' },
        { accountId: 'acct-2', email: 'ann@outlook.example', displayName: 'Ann' },
        { accountId: 'acct-3' },
      ],
      { 'acct-1': { identities } },
    );
    expect(choices.map((choice) => [choice.accountId, choice.email, choice.name, choice.primary])).toEqual([
      ['acct-1', 'ann@gmail.com', 'Ann Lee', true],
      ['acct-1', 'Ann@Work.example', 'Ann at Work', false],
      ['acct-2', 'ann@outlook.example', 'Ann', true],
      ['acct-3', 'acct-3', undefined, true],
    ]);
    expect(choices[1].key).toBe(fromChoiceKey('acct-1', 'ann@work.example'));
    expect(selectedFromChoice(choices, 'acct-1', 'ANN@work.example')?.email).toBe('Ann@Work.example');
    expect(selectedFromChoice(choices, 'acct-1', 'gone@x.example')?.email).toBe('ann@gmail.com');
    expect(selectedFromChoice(choices, 'acct-1', null)?.email).toBe('ann@gmail.com');
    expect(selectedFromChoice(choices, 'acct-9', 'x@y.example')).toBeUndefined();
  });
});

function googleList(
  list: SendAsIdentity[] = identities,
  overrides: Parameters<typeof __setSendAsDepsForTest>[0] = {},
) {
  const calls: string[] = [];
  __setSendAsDepsForTest({
    getAccount: (async (_userId: string, account: string) =>
      account === 'acct-1' ? GOOGLE_ACCOUNT : account === 'acct-2' ? NYLAS_ACCOUNT : null) as any,
    listGmailSendAs: async (grantId: string) => {
      calls.push(grantId);
      return list;
    },
    getHeaders: (async () => null) as any,
    resolveAnchor: (async () => {
      throw new Error('no anchor');
    }) as any,
    ...overrides,
  });
  return calls;
}

describe('mailbox send-as lists', () => {
  test('a Nylas mailbox lists only its own address and reads no Gmail list', async () => {
    const calls = googleList();
    expect(await loadSendAsIdentities(NYLAS_ACCOUNT)).toEqual({
      identities: [mailboxIdentity(NYLAS_ACCOUNT)],
      aliasesSupported: false,
      partial: false,
    });
    expect(calls).toEqual([]);
    expect(mailboxIdentity({ email: 'a@b.example', displayName: ' ' })).not.toHaveProperty('displayName');
  });

  test('a direct Google mailbox lists Gmail; the primary without a name gets the account name', async () => {
    googleList(gmailSendAsIdentities([{ ...PRIMARY, displayName: '' }, WORK]));
    const list = await loadSendAsIdentities(GOOGLE_ACCOUNT);
    expect(list.aliasesSupported).toBe(true);
    expect(list.partial).toBe(false);
    expect(list.identities[0]).toMatchObject({ email: 'ann@gmail.com', displayName: 'Ann Lee' });
    googleList([]);
    expect((await loadSendAsIdentities(GOOGLE_ACCOUNT)).identities).toEqual([
      mailboxIdentity(GOOGLE_ACCOUNT),
    ]);
  });

  test('a failed Gmail list gives the mailbox address only, marked partial', async () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      __setSendAsDepsForTest({
        listGmailSendAs: async () => {
          throw new Error('quota');
        },
      });
      expect(await loadSendAsIdentities(GOOGLE_ACCOUNT)).toEqual({
        identities: [mailboxIdentity(GOOGLE_ACCOUNT)],
        aliasesSupported: true,
        partial: true,
      });
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  test('a reply default reads Delivered-To from Gmail only when nothing else matched', async () => {
    const headerReads: unknown[] = [];
    googleList(identities, {
      getHeaders: (async (input: unknown) => {
        headerReads.push(input);
        return { 'delivered-to': 'ann@work.example' };
      }) as any,
    });
    const anchor = { _id: 'm1', from: 'bob@x.example', to: 'list@x.example', cc: '', headers: {} };
    expect((await defaultSendAsFor('user-1', GOOGLE_ACCOUNT, identities, anchor))?.email).toBe(
      'Ann@Work.example',
    );
    expect(headerReads).toEqual([{ userId: 'user-1', account: 'acct-1', messageId: 'm1' }]);
    // A stored Delivered-To that matches needs no read.
    const stored = { ...anchor, headers: { 'delivered-to': 'ann@gmail.com' } };
    expect((await defaultSendAsFor('user-1', GOOGLE_ACCOUNT, identities, stored))?.email).toBe(
      'ann@gmail.com',
    );
    expect(headerReads).toHaveLength(1);
    // A mailbox with one address needs no read either.
    const single = [mailboxIdentity(GOOGLE_ACCOUNT)];
    expect((await defaultSendAsFor('user-1', GOOGLE_ACCOUNT, single, anchor))?.email).toBe('ann@gmail.com');
    expect(headerReads).toHaveLength(1);
    // No match anywhere: Gmail's default address.
    googleList();
    expect((await defaultSendAsFor('user-1', GOOGLE_ACCOUNT, identities, anchor))?.email).toBe(
      'Ann@Work.example',
    );
    expect((await defaultSendAsFor('user-1', GOOGLE_ACCOUNT, identities, null))?.email).toBe(
      'Ann@Work.example',
    );
  });

  test('the page gives the reply default for an anchor and survives a missing anchor', async () => {
    const anchors: unknown[] = [];
    googleList(
      gmailSendAsIdentities([
        { ...PRIMARY, isDefault: true },
        { ...WORK, isDefault: false },
      ]),
      {
        resolveAnchor: (async (input: any) => {
          anchors.push(input);
          if (input.messageId === 'gone') throw new Error('missing');
          return { _id: 'm1', from: 'bob@x.example', to: 'ann@work.example', cc: '', headers: {} };
        }) as any,
      },
    );
    const reply = await loadSendAsPage({
      userId: 'user-1',
      account: GOOGLE_ACCOUNT,
      messageId: 'm1',
      threadId: 't1',
    });
    expect(reply).toMatchObject({
      accountId: 'acct-1',
      aliasesSupported: true,
      partial: false,
      defaultAddress: 'Ann@Work.example',
    });
    expect(anchors).toEqual([{ account: 'acct-1', messageId: 'm1', threadId: 't1', userId: 'user-1' }]);
    const missing = await loadSendAsPage({ userId: 'user-1', account: GOOGLE_ACCOUNT, messageId: 'gone' });
    expect(missing.defaultAddress).toBe('ann@gmail.com');
    const fresh = await loadSendAsPage({ userId: 'user-1', account: GOOGLE_ACCOUNT });
    expect(fresh.defaultAddress).toBe('ann@gmail.com');
    expect(anchors).toHaveLength(2);
    const nylas = await loadSendAsPage({ userId: 'user-1', account: NYLAS_ACCOUNT });
    expect(nylas).toMatchObject({ aliasesSupported: false, defaultAddress: 'ann@outlook.example' });
  });

  test('a partial page selects the mailbox address', async () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      __setSendAsDepsForTest({
        listGmailSendAs: async () => {
          throw new Error('quota');
        },
      });
      const page = await loadSendAsPage({ userId: 'user-1', account: GOOGLE_ACCOUNT });
      expect(page).toMatchObject({ partial: true, defaultAddress: 'ann@gmail.com' });
    } finally {
      warn.mockRestore();
    }
  });
});

describe('compose From resolution', () => {
  test('a named usable address goes out, in the case Gmail lists it', async () => {
    googleList();
    expect(
      await resolveComposeFrom({ userId: 'u', account: 'acct-1', fromAddress: ' ann@work.EXAMPLE ' }),
    ).toEqual({
      fromAddress: 'Ann@Work.example',
      selfAddresses: ['ann@gmail.com', 'Ann@Work.example', 'side@club.example'],
    });
  });

  test('an unknown, unverified, or malformed address is refused before any send', async () => {
    googleList();
    await expect(
      resolveComposeFrom({ userId: 'u', account: 'acct-1', fromAddress: 'x@y.example' }),
    ).rejects.toMatchObject({
      code: 'from_unknown',
    });
    await expect(
      resolveComposeFrom({ userId: 'u', account: 'acct-1', fromAddress: 'side@club.example' }),
    ).rejects.toMatchObject({ code: 'from_unverified' });
    await expect(
      resolveComposeFrom({ userId: 'u', account: 'acct-1', fromAddress: 'Ann <ann@work.example>' }),
    ).rejects.toMatchObject({ code: 'from_unknown' });
  });

  test('without a named address, a reply uses the anchor and a new message the default', async () => {
    googleList(
      gmailSendAsIdentities([
        { ...PRIMARY, isDefault: true },
        { ...WORK, isDefault: false },
      ]),
    );
    const anchor = { _id: 'm1', from: 'bob@x.example', to: 'ann@work.example', cc: '', headers: {} };
    expect((await resolveComposeFrom({ userId: 'u', account: 'acct-1', anchor })).fromAddress).toBe(
      'Ann@Work.example',
    );
    expect((await resolveComposeFrom({ userId: 'u', account: 'acct-1' })).fromAddress).toBe('ann@gmail.com');
  });

  test('a Nylas mailbox sends only from its own address and names no From', async () => {
    googleList();
    expect(await resolveComposeFrom({ userId: 'u', account: 'acct-2' })).toEqual({
      selfAddresses: ['ann@outlook.example'],
    });
    expect(
      await resolveComposeFrom({ userId: 'u', account: 'acct-2', fromAddress: 'ANN@outlook.example' }),
    ).toEqual({ selfAddresses: ['ann@outlook.example'] });
    await expect(
      resolveComposeFrom({ userId: 'u', account: 'acct-2', fromAddress: 'ann@work.example' }),
    ).rejects.toMatchObject({ code: 'from_unsupported', statusCode: 400 });
  });

  test('a mailbox that is not connected passes the address on; the send fails with its own message', async () => {
    googleList();
    expect(await resolveComposeFrom({ userId: 'u', account: 'gone', fromAddress: 'a@b.example' })).toEqual({
      fromAddress: 'a@b.example',
      selfAddresses: [],
    });
    expect(await resolveComposeFrom({ userId: 'u', account: 'gone' })).toEqual({ selfAddresses: [] });
  });

  test('when the lists cannot load, only the mailbox address can be named', async () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      __setSendAsDepsForTest({
        getAccount: (async () => GOOGLE_ACCOUNT) as any,
        listGmailSendAs: async () => {
          throw new Error('quota');
        },
      });
      expect(await resolveComposeFrom({ userId: 'u', account: 'acct-1' })).toEqual({
        selfAddresses: ['ann@gmail.com'],
      });
      expect(
        await resolveComposeFrom({ userId: 'u', account: 'acct-1', fromAddress: 'ANN@gmail.com' }),
      ).toEqual({ fromAddress: 'ann@gmail.com', selfAddresses: ['ann@gmail.com'] });
      await expect(
        resolveComposeFrom({ userId: 'u', account: 'acct-1', fromAddress: 'ann@work.example' }),
      ).rejects.toBeInstanceOf(SendAsUnavailableError);

      __setSendAsDepsForTest({
        getAccount: (async () => {
          throw new Error('Convex down');
        }) as any,
      });
      expect(await resolveComposeFrom({ userId: 'u', account: 'acct-1' })).toEqual({ selfAddresses: [] });
      const unavailable = await resolveComposeFrom({
        userId: 'u',
        account: 'acct-1',
        fromAddress: 'ann@work.example',
      }).catch((error) => error);
      expect(unavailable).toBeInstanceOf(SendAsUnavailableError);
      expect(unavailable.statusCode).toBe(503);
    } finally {
      warn.mockRestore();
    }
  });
});
