import { describe, expect, test } from 'bun:test';
import { highResolutionArtUrl } from '../lib/mail/daily-art';

describe('daily art image URLs', () => {
  test('uses higher-resolution public museum derivatives when available', () => {
    expect(highResolutionArtUrl('https://images.metmuseum.org/CRDImages/dp/web-large/DP815958.jpg')).toBe(
      'https://images.metmuseum.org/CRDImages/dp/original/DP815958.jpg',
    );
    expect(highResolutionArtUrl('https://openaccess-cdn.clevelandart.org/1972.47/1972.47_web.jpg')).toBe(
      'https://openaccess-cdn.clevelandart.org/1972.47/1972.47_print.jpg',
    );
  });

  test('leaves already-sized IIIF URLs alone', () => {
    expect(
      highResolutionArtUrl(
        'https://www.artic.edu/iiif/2/1e452e34-3a2b-0dca-35c3-c7236c612985/full/1686,/0/default.jpg',
      ),
    ).toContain('/full/1686,/0/default.jpg');
  });
});
