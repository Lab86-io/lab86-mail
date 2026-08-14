import { describe, expect, test } from 'bun:test';
import { matchingProofId, rankWorkForProof } from '../lib/albatross/proof-match';

describe('proof matching', () => {
  test('uses the only outstanding requirement without inventing a second choice', () => {
    expect(matchingProofId([{ id: 'receipt', what: 'The payment receipt arrived' }], 'Confirmation')).toBe(
      'receipt',
    );
  });

  test('chooses the named requirement supported by the message', () => {
    expect(
      matchingProofId(
        [
          { id: 'charge', what: 'The purchase was charged' },
          { id: 'confirmation', what: 'The order confirmation arrived' },
        ],
        'Your order confirmation and tracking details',
      ),
    ).toBe('confirmation');
  });

  test('ranks likely Work using subject and snippet text', () => {
    const ranked = rankWorkForProof(
      [
        { _id: 'lease', title: 'Renew the apartment lease' },
        {
          _id: 'passport',
          title: 'Renew passport',
          proofs: [{ id: 'confirmation', what: 'Passport application confirmation arrived' }],
        },
      ],
      'Passport application confirmation – reference 1234',
    );
    expect(ranked.map((row) => row._id)).toEqual(['passport']);
  });

  test('does not offer unrelated open Work as proof', () => {
    expect(
      rankWorkForProof(
        [{ _id: 'lease', title: 'Renew the apartment lease' }],
        'Your grocery delivery is outside',
      ),
    ).toEqual([]);
  });
});
