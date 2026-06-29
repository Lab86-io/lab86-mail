import { NextResponse } from 'next/server';
import { companyLogoCandidatesForDomain, logoDomainForEmail } from '@/lib/tools/photo-resolution';

export const runtime = 'nodejs';

const SAFE_RASTER_IMAGE_MIME_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/webp',
  'image/avif',
  'image/gif',
  'image/bmp',
  'image/x-icon',
  'image/vnd.microsoft.icon',
]);

export async function GET(_request: Request, { params }: { params: Promise<{ domain: string }> }) {
  const { domain: rawDomain } = await params;
  const domain = logoDomainForEmail(decodeURIComponent(rawDomain || ''));
  const candidates = companyLogoCandidatesForDomain(domain);
  let sawTransientFailure = false;
  for (const url of candidates) {
    try {
      const response = await fetch(url, {
        headers: { accept: 'image/avif,image/webp,image/png,image/svg+xml,image/*,*/*;q=0.8' },
        signal: AbortSignal.timeout(1800),
      });
      if (isTransientLogoStatus(response.status)) sawTransientFailure = true;
      if (!response.ok) continue;
      const contentType = (response.headers.get('content-type') || '').toLowerCase();
      const mimeType = contentType.split(';', 1)[0].trim();
      if (!isSafeRasterImageMime(mimeType)) continue;
      return new NextResponse(response.body, {
        status: 200,
        headers: {
          'content-type': mimeType,
          'cache-control': 'public, max-age=604800, stale-while-revalidate=2592000',
          'x-content-type-options': 'nosniff',
        },
      });
    } catch {
      sawTransientFailure = true;
      // Try the next source.
    }
  }
  if (sawTransientFailure) {
    return new NextResponse(null, {
      status: 502,
      headers: { 'cache-control': 'no-store' },
    });
  }
  return new NextResponse(null, {
    status: 404,
    headers: { 'cache-control': 'public, max-age=86400, stale-while-revalidate=604800' },
  });
}

function isTransientLogoStatus(status: number) {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

function isSafeRasterImageMime(mimeType: string) {
  return SAFE_RASTER_IMAGE_MIME_TYPES.has(mimeType);
}
