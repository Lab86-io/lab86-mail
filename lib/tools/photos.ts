import { z } from 'zod';
import { getPhotoFromCache, setPhotoCache } from '../store/photos';
import { companyLogoUrl, resolvePhotoUrl } from './photo-resolution';
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
  async handler({ account, emails }, ctx) {
    const out: Record<string, string | null> = {};
    const seen = new Set<string>();

    for (const raw of emails) {
      const email = (raw || '').trim().toLowerCase();
      if (!email || seen.has(email)) continue;
      seen.add(email);

      const logoUrl = companyLogoUrl(email);
      const cached = await getPhotoFromCache(email).catch(() => null);
      out[email] = cached?.url || null;
      if (!cached?.url && (!cached || logoUrl)) {
        const url = await resolvePhotoUrl({
          userId: ctx.userId,
          account,
          email,
        }).catch(() => logoUrl);
        out[email] = url;
        await setPhotoCache(email, url).catch(() => undefined);
      }
    }

    return { photos: out };
  },
});
