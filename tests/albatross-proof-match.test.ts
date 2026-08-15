import { describe, expect, test } from 'bun:test';
import { matchingProofId, proofCandidatesForMail, rankWorkForProof } from '../lib/albatross/proof-match';

describe('proof matching', () => {
  test('requires a lexical reason even when only one requirement is outstanding', () => {
    expect(
      matchingProofId([{ id: 'receipt', what: 'The payment receipt arrived' }], 'Payment receipt attached'),
    ).toBe('receipt');
    expect(matchingProofId([{ id: 'receipt', what: 'The payment receipt arrived' }], 'Confirmation')).toBeNull();
  });

  test('ignores settled proofs and selects the supported outstanding requirement', () => {
    expect(
      matchingProofId(
        [
          { id: 'receipt', what: 'The payment receipt arrived', satisfiedAt: 100 },
          { id: 'delivery', what: 'The package delivery was confirmed' },
        ],
        'Your package delivery was confirmed',
      ),
    ).toBe('delivery');
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

  test('uses the shared ranking and proof-selection pipeline for mail candidates', () => {
    expect(
      proofCandidatesForMail(
        [
          {
            _id: 'passport',
            title: 'Renew passport',
            proofs: [{ id: 'confirmation', what: 'Passport application confirmation arrived' }],
          },
        ],
        'Your passport application confirmation arrived',
      ),
    ).toEqual([
      {
        work: {
          _id: 'passport',
          title: 'Renew passport',
          proofs: [{ id: 'confirmation', what: 'Passport application confirmation arrived' }],
        },
        proofId: 'confirmation',
        proofWhat: 'Passport application confirmation arrived',
      },
    ]);
  });
});
