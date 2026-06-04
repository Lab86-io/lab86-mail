import { z } from 'zod';
import { getPhotoFromCache, setPhotoCache } from '../store/photos';
import { defineTool } from './registry';

export const resolvePhotos = defineTool({
  name: 'resolve_photos',
  description: 'Resolve cached profile photo URLs for a batch of email addresses.',
  category: 'contacts',
  mutating: false,
  input: z.object({
    account: z.string(),
    emails: z.array(z.string()).max(200),
  }),
  output: z.object({ photos: z.record(z.string(), z.string().nullable()) }),
  async handler({ emails }) {
    const out: Record<string, string | null> = {};
    const seen = new Set<string>();

    for (const raw of emails) {
      const email = (raw || '').trim().toLowerCase();
      if (!email || seen.has(email)) continue;
      seen.add(email);

      const cached = await getPhotoFromCache(email).catch(() => null);
      out[email] = cached?.url || null;
      if (!cached) await setPhotoCache(email, null).catch(() => undefined);
    }

    return { photos: out };
  },
});
