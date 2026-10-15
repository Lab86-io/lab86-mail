import { CURRENT_PRODUCT_RELEASE } from '@/lib/updates/release';

export const dynamic = 'force-dynamic';

export function GET() {
  return Response.json(CURRENT_PRODUCT_RELEASE, {
    headers: { 'Cache-Control': 'private, no-store, max-age=0' },
  });
}
