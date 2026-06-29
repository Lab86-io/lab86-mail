import { NextResponse } from 'next/server';
import { companyLogoCandidatesForDomain, logoDomainForEmail } from '@/lib/tools/photo-resolution';

export const runtime = 'nodejs';

export async function GET(_request: Request, { params }: { params: Promise<{ domain: string }> }) {
  const { domain: rawDomain } = await params;
  const domain = logoDomainForEmail(decodeURIComponent(rawDomain || ''));
  const candidates = companyLogoCandidatesForDomain(domain);
  for (const url of candidates) {
    try {
      const response = await fetch(url, {
        headers: { accept: 'image/avif,image/webp,image/png,image/svg+xml,image/*,*/*;q=0.8' },
        signal: AbortSignal.timeout(1800),
      });
      if (!response.ok) continue;
      const contentType = response.headers.get('content-type') || '';
      if (!contentType.startsWith('image/')) continue;
      return new NextResponse(response.body, {
        status: 200,
        headers: {
          'content-type': contentType,
          'cache-control': 'public, max-age=604800, stale-while-revalidate=2592000',
        },
      });
    } catch {
      // Try the next source.
    }
  }
  return new NextResponse(null, {
    status: 404,
    headers: { 'cache-control': 'public, max-age=86400, stale-while-revalidate=604800' },
  });
}
