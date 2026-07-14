import { beforeEach, describe, expect, test } from 'bun:test';
import {
  apexDomain,
  candidateLogoUrls,
  INITIALS_VERDICT,
  isAcceptableLogo,
  LOGO_CACHE_KEY_PREFIX,
  MIN_GOOGLE_S2_NATURAL_SIZE,
  MIN_LOGO_NATURAL_SIZE,
  peekSenderLogo,
  probeImageElement,
  readStoredVerdict,
  resetSenderLogoCacheForTest,
  resolveSenderLogo,
  senderLogoDomain,
  type VerdictStorage,
  verdictStorageKey,
  writeStoredVerdict,
} from '../lib/mail/sender-logo';

function memoryStorage(): VerdictStorage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => {
      data.set(key, value);
    },
    removeItem: (key) => {
      data.delete(key);
    },
  };
}

beforeEach(() => {
  resetSenderLogoCacheForTest();
});

describe('senderLogoDomain', () => {
  test('company senders map to their domain', () => {
    expect(senderLogoDomain('billing@stripe.com')).toBe('stripe.com');
    expect(senderLogoDomain('news@Updates.Spotify.com')).toBe('updates.spotify.com');
  });
  test('personal mailboxes never get a company logo', () => {
    expect(senderLogoDomain('friend@gmail.com')).toBe('');
    expect(senderLogoDomain('friend@icloud.com')).toBe('');
    expect(senderLogoDomain('friend@mail.outlook.com')).toBe('');
  });
  test('microsoft infrastructure domains borrow the parent brand', () => {
    expect(senderLogoDomain('no-reply@microsoftonline.com')).toBe('microsoft.com');
    expect(senderLogoDomain('alerts@contoso.onmicrosoft.com')).toBe('microsoft.com');
    expect(senderLogoDomain('drive-shares@googlemail.com')).toBe('google.com');
  });
  test('reserved, local, and invalid domains resolve to nothing', () => {
    expect(senderLogoDomain('a@example.com')).toBe('');
    expect(senderLogoDomain('a@dev.localhost')).toBe('');
    expect(senderLogoDomain('a@printer.local')).toBe('');
    expect(senderLogoDomain('a@nodots')).toBe('');
    expect(senderLogoDomain('')).toBe('');
    expect(senderLogoDomain(null)).toBe('');
    expect(senderLogoDomain('a@bad_domain.com')).toBe('');
  });
});

describe('apexDomain', () => {
  test('collapses subdomains to the registrable brand domain', () => {
    expect(apexDomain('news.stripe.com')).toBe('stripe.com');
    expect(apexDomain('stripe.com')).toBe('stripe.com');
    expect(apexDomain('a.b.mailer.example.io')).toBe('example.io');
  });
  test('keeps two-part public suffixes intact', () => {
    expect(apexDomain('news.bbc.co.uk')).toBe('bbc.co.uk');
    expect(apexDomain('shop.myer.com.au')).toBe('myer.com.au');
  });
});

describe('candidateLogoUrls', () => {
  test('empty domain yields no candidates', () => {
    expect(candidateLogoUrls('')).toEqual([]);
  });
  test('orders server proxy first, then DDG, then Google s2', () => {
    const urls = candidateLogoUrls('stripe.com');
    expect(urls).toEqual([
      '/api/logos/stripe.com',
      'https://icons.duckduckgo.com/ip3/stripe.com.ico',
      'https://www.google.com/s2/favicons?sz=128&domain=stripe.com',
    ]);
  });
  test('direct fallbacks use the apex domain for subdomain senders', () => {
    const urls = candidateLogoUrls('updates.spotify.com');
    expect(urls[0]).toBe('/api/logos/updates.spotify.com');
    expect(urls[1]).toBe('https://icons.duckduckgo.com/ip3/spotify.com.ico');
    expect(urls[2]).toBe('https://www.google.com/s2/favicons?sz=128&domain=spotify.com');
  });
});

describe('isAcceptableLogo', () => {
  const at = (width: number, height: number, url = '/api/logos/stripe.com') =>
    isAcceptableLogo({ width, height, url });

  test('rejects the Google 16px default globe and the DDG 48px placeholder', () => {
    expect(at(16, 16, 'https://www.google.com/s2/favicons?sz=128&domain=x.com')).toBe(false);
    expect(at(48, 48, 'https://icons.duckduckgo.com/ip3/x.com.ico')).toBe(false);
  });
  test('rejects images below the 2x row size everywhere', () => {
    expect(at(MIN_LOGO_NATURAL_SIZE - 1, MIN_LOGO_NATURAL_SIZE - 1)).toBe(false);
    expect(at(32, 32)).toBe(false);
  });
  test('accepts crisp square-ish logos', () => {
    expect(at(MIN_LOGO_NATURAL_SIZE, MIN_LOGO_NATURAL_SIZE)).toBe(true);
    expect(at(128, 128)).toBe(true);
    expect(at(120, 60)).toBe(true);
  });
  test('holds Google s2 to a stricter size so upscaled favicons never ship', () => {
    const s2 = 'https://www.google.com/s2/favicons?sz=128&domain=stripe.com';
    expect(at(64, 64, s2)).toBe(false);
    expect(at(MIN_GOOGLE_S2_NATURAL_SIZE, MIN_GOOGLE_S2_NATURAL_SIZE, s2)).toBe(true);
    expect(at(128, 128, s2)).toBe(true);
  });
  test('rejects banner-shaped wordmarks and degenerate sizes', () => {
    expect(at(300, 60)).toBe(false);
    expect(at(60, 300)).toBe(false);
    expect(at(0, 0)).toBe(false);
    expect(at(Number.NaN, 128)).toBe(false);
  });
});

describe('verdict storage', () => {
  test('round-trips winning URLs under the versioned key', () => {
    const storage = memoryStorage();
    writeStoredVerdict('stripe.com', '/api/logos/stripe.com', storage);
    expect(storage.data.get(`${LOGO_CACHE_KEY_PREFIX}stripe.com`)).toBe('/api/logos/stripe.com');
    expect(readStoredVerdict('stripe.com', storage)).toBe('/api/logos/stripe.com');
    expect(verdictStorageKey('stripe.com')).toBe('lab86-logo-v1:stripe.com');
  });
  test('missing entries and missing storage read as null', () => {
    expect(readStoredVerdict('stripe.com', memoryStorage())).toBeNull();
    expect(readStoredVerdict('stripe.com', null)).toBeNull();
    expect(readStoredVerdict('', memoryStorage())).toBeNull();
  });
  test('storage write failures are swallowed', () => {
    const throwing: VerdictStorage = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
      removeItem: () => {},
    };
    expect(() => writeStoredVerdict('stripe.com', INITIALS_VERDICT, throwing)).not.toThrow();
    expect(readStoredVerdict('stripe.com', throwing)).toBeNull();
  });
});

describe('resolveSenderLogo', () => {
  test('accepts the first candidate that decodes at logo quality', async () => {
    const storage = memoryStorage();
    const probed: string[] = [];
    const url = await resolveSenderLogo('stripe.com', {
      probe: async (candidate) => {
        probed.push(candidate);
        return { width: 128, height: 128 };
      },
      storage,
    });
    expect(url).toBe('/api/logos/stripe.com');
    expect(probed).toEqual(['/api/logos/stripe.com']);
    expect(readStoredVerdict('stripe.com', storage)).toBe('/api/logos/stripe.com');
  });

  test('falls through placeholders and errors to the next candidate', async () => {
    const storage = memoryStorage();
    const sizes = new Map<string, { width: number; height: number } | null>([
      ['/api/logos/stripe.com', null], // 404 → error
      ['https://icons.duckduckgo.com/ip3/stripe.com.ico', { width: 48, height: 48 }], // placeholder
      ['https://www.google.com/s2/favicons?sz=128&domain=stripe.com', { width: 128, height: 128 }],
    ]);
    const url = await resolveSenderLogo('stripe.com', {
      probe: async (candidate) => sizes.get(candidate) ?? null,
      storage,
    });
    expect(url).toBe('https://www.google.com/s2/favicons?sz=128&domain=stripe.com');
  });

  test('a definitive miss persists the initials verdict', async () => {
    const storage = memoryStorage();
    const url = await resolveSenderLogo('tiny-favicon.com', {
      probe: async () => ({ width: 16, height: 16 }),
      storage,
    });
    expect(url).toBeNull();
    expect(readStoredVerdict('tiny-favicon.com', storage)).toBe(INITIALS_VERDICT);
    expect(peekSenderLogo('tiny-favicon.com', storage)).toBeNull();
  });

  test('an all-error run (offline) is not persisted across sessions', async () => {
    const storage = memoryStorage();
    const url = await resolveSenderLogo('offline.com', {
      probe: async () => {
        throw new Error('network down');
      },
      storage,
    });
    expect(url).toBeNull();
    expect(readStoredVerdict('offline.com', storage)).toBeNull();
  });

  test('memoizes per-domain: a second call never re-probes', async () => {
    const storage = memoryStorage();
    let probes = 0;
    const probe = async () => {
      probes += 1;
      return { width: 128, height: 128 };
    };
    await resolveSenderLogo('stripe.com', { probe, storage });
    const again = await resolveSenderLogo('stripe.com', { probe, storage });
    expect(again).toBe('/api/logos/stripe.com');
    expect(probes).toBe(1);
  });

  test('concurrent callers share one in-flight probe run', async () => {
    const storage = memoryStorage();
    let probes = 0;
    const probe = async () => {
      probes += 1;
      await new Promise((resolve) => setTimeout(resolve, 10));
      return { width: 128, height: 128 };
    };
    const [a, b] = await Promise.all([
      resolveSenderLogo('stripe.com', { probe, storage }),
      resolveSenderLogo('stripe.com', { probe, storage }),
    ]);
    expect(a).toBe('/api/logos/stripe.com');
    expect(b).toBe('/api/logos/stripe.com');
    expect(probes).toBe(1);
  });

  test('a stored verdict from a prior session resolves without probing', async () => {
    const storage = memoryStorage();
    storage.setItem(`${LOGO_CACHE_KEY_PREFIX}stripe.com`, '/api/logos/stripe.com');
    let probes = 0;
    const url = await resolveSenderLogo('stripe.com', {
      probe: async () => {
        probes += 1;
        return null;
      },
      storage,
    });
    expect(url).toBe('/api/logos/stripe.com');
    expect(probes).toBe(0);
  });

  test('empty domain short-circuits to initials', async () => {
    expect(await resolveSenderLogo('')).toBeNull();
    expect(peekSenderLogo('')).toBeNull();
  });
});

describe('peekSenderLogo', () => {
  test('unknown domains are undefined until resolved', () => {
    expect(peekSenderLogo('never-seen.com', memoryStorage())).toBeUndefined();
  });
  test('hydrates the in-memory verdict from storage', () => {
    const storage = memoryStorage();
    storage.setItem(`${LOGO_CACHE_KEY_PREFIX}stripe.com`, INITIALS_VERDICT);
    expect(peekSenderLogo('stripe.com', storage)).toBeNull();
    // Now cached in memory: storage is no longer consulted.
    expect(peekSenderLogo('stripe.com', memoryStorage())).toBeNull();
  });
});

describe('probeImageElement', () => {
  test('resolves null when no DOM Image constructor exists', async () => {
    expect(await probeImageElement('/api/logos/stripe.com')).toBeNull();
  });
});
