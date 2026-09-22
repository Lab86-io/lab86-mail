/** Historical synthetic reproduction, valid only against commit e1e95b49.
 * Its assertions describe the former Brief scoring and lane caps, not current helpers.
 * Run only with e1e95b49 checked out: bun docs/research/jev-2026-09-21/mail-diagnostics.ts
 * Current regressions: tests/brief-score.test.ts and tests/jev-*.test.ts.
 * No model calls, mailbox access, or production writes.
 */
import { strict as assert } from 'node:assert';
import { briefScoreSignals, scoreBriefCandidate, selectBriefItems } from '../../../lib/mail/brief-score';
import { type CorpusMessageDocument, corpusMessagesToThreads } from '../../../lib/mail/search/local';
import { classifyThreadWithContext } from '../../../lib/mail/smart-categories';
import { type SearchTool, searchMail } from '../../../lib/search/global-search';

const base = {
  newestInboundTo: ['user@example.net'],
  selfAddresses: ['user@example.net'],
  counterparty: 'athletics@university.example',
  sentAllowlist: new Set(['professor@university.example', 'university.example']),
  outboundCount: 0,
  dueAts: [],
  now: 1_000,
};
const broadcastSignals = briefScoreSignals({ ...base, automated: true, bulkReasons: ['unsubscribe'] });
const broadcastScore = scoreBriefCandidate(broadcastSignals);
const selectedBroadcast = selectBriefItems(
  [{ key: 'account:broadcast', lane: 'know', score: broadcastScore, receivedAt: 200 }],
  7,
);
assert.equal(broadcastSignals.repliedBefore, true);
assert.equal(broadcastScore, 2);
assert.equal(selectedBroadcast.know.length, 1);

const misleadingPrimary = classifyThreadWithContext({
  _id: 'broadcast',
  subject: 'Join us for the game this weekend',
  fromAddress: 'University Athletics <athletics@university.example>',
  snippet: 'Tickets available now. Cheer on the team! Unsubscribe',
  bodyText: 'Tickets available now. Cheer on the team! Unsubscribe',
  labels: ['INBOX', 'CATEGORY_PERSONAL'],
  unread: true,
});
assert.equal(misleadingPrimary.primary, 'main');
assert.deepEqual(misleadingPrimary.secondary, ['needs_reply']);

const noReplyNeeded = classifyThreadWithContext({
  _id: 'thanks',
  subject: 'Re: Signed document',
  fromAddress: 'Alex <alex@example.org>',
  snippet: 'Thanks, I have everything. No reply needed.',
  bodyText: 'Thanks, I have everything. No reply needed.',
  labels: ['CATEGORY_PERSONAL'],
  unread: true,
});
assert.deepEqual(noReplyNeeded.secondary, ['needs_reply']);

const capped = selectBriefItems(
  [
    ...[10, 9, 8, 7].map((score, i) => ({
      key: `account:request${i + 1}`,
      lane: 'answer' as const,
      score,
      receivedAt: 100,
    })),
    { key: 'account:broadcast', lane: 'know' as const, score: 2, receivedAt: 200 },
  ],
  7,
);
assert.equal(capped.answer.length, 3);
assert.equal(capped.know.length, 1);
assert.equal(capped.overflow[0].key, 'account:request4');

const messages: CorpusMessageDocument[] = [
  {
    accountId: 'a',
    provider: 'google',
    providerMessageId: 'm1',
    providerThreadId: 'conversation',
    subject: 'University budget approval',
    from: 'alex@university.example',
    to: 'user@example.net',
    receivedAt: 100,
    snippet: 'The approved university budget is attached.',
    searchText: 'university budget approval',
    labels: [],
  },
  {
    accountId: 'a',
    provider: 'google',
    providerMessageId: 'm2',
    providerThreadId: 'broadcast',
    subject: 'University game Saturday',
    from: 'athletics@university.example',
    to: 'user@example.net',
    receivedAt: 200,
    snippet: 'University game promotion.',
    searchText: 'university game',
    labels: [],
  },
];
const threads = corpusMessagesToThreads(messages, 'a');
assert.equal(threads[0]._id, 'broadcast');
const upstreamRelevantFirst = [...threads].reverse();
const mockTool: SearchTool = async <T>() => ({ items: upstreamRelevantFirst }) as T;
const global = await searchMail('university', [{ accountId: 'a', email: 'user@example.net' }], mockTool);
assert.equal(global.items[0].id, 'mail:a:broadcast');

console.log(
  JSON.stringify(
    {
      scope: 'Synthetic current-helper reproductions; not the historical Syracuse incident.',
      passedAssertions: 11,
      domainInheritedBroadcast: {
        signals: broadcastSignals,
        score: broadcastScore,
        selected: selectedBroadcast.know.map((x) => x.key),
      },
      primaryTabBroadcast: misleadingPrimary,
      explicitlyNoReplyNeeded: noReplyNeeded,
      replyLaneCap: {
        budget: 7,
        answer: capped.answer.map((x) => x.key),
        know: capped.know.map((x) => x.key),
        overflow: capped.overflow.map((x) => x.key),
        used: capped.answer.length + capped.know.length + capped.today.length,
      },
      search: {
        suppliedRelevanceOrder: messages.map((x) => x.providerThreadId),
        localOutputOrder: threads.map((x) => x._id),
        globalInputOrder: upstreamRelevantFirst.map((x) => x._id),
        globalOutputOrder: global.items.map((x) => x.id),
      },
    },
    null,
    2,
  ),
);
