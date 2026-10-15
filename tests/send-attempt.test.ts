import { describe, expect, test } from 'bun:test';
import { sendAttemptFields } from '../components/thread/InlineComposer';
import { parseAllowSendRefusal, sendRetryFields } from '../lib/mail/allow-send';

/* The id a send carries (CodeRabbit 4287727556): a retry after a send
 * permission keeps the refused send's id, because the server bound the
 * "once" token to it; a send with an open refusal reuses that id; any other
 * send gets a fresh outbox id. */

const refusal = parseAllowSendRefusal(409, {
  ok: false,
  code: 'needs_allow',
  grant: 'send',
  sendId: 'outbox:1b4e28ba-2fa1-11d2-883f-0016d3cca427',
  domains: ['bramble-press.example.com'],
  allow: [
    { itemId: 'secure_tax_id', itemLabel: 'Tax ID', fieldLabels: ['Social security number'], domains: [] },
  ],
  error: 'A sealed file needs your permission for this send.',
})!;
const fresh = () => 'outbox:fresh';

describe('the id of a send', () => {
  test('a retry posts the refused send id and the token', () => {
    const retry = sendRetryFields(refusal, { ok: true, scope: 'once', allowToken: 'tok_1', expiresAt: 1 });
    // The choice clears the refusal before the retry runs: the id comes from the retry itself.
    expect(sendAttemptFields(retry, null, fresh)).toEqual({ pendingId: refusal.sendId, allowToken: 'tok_1' });
  });

  test('a retry after "always" posts the same id with no token', () => {
    const retry = sendRetryFields(refusal, { ok: true, scope: 'always' });
    expect(sendAttemptFields(retry, null, fresh)).toEqual({ pendingId: refusal.sendId });
  });

  test('a send with an open refusal reuses its id; any other send gets a fresh id', () => {
    expect(sendAttemptFields({}, refusal, fresh)).toEqual({ pendingId: refusal.sendId });
    expect(sendAttemptFields({}, null, fresh)).toEqual({ pendingId: 'outbox:fresh' });
    expect(sendAttemptFields({ allowToken: 'tok_2' }, null, fresh)).toEqual({
      pendingId: 'outbox:fresh',
      allowToken: 'tok_2',
    });
  });
});
