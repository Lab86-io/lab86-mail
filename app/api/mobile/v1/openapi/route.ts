import { mobileOpenAPIV1 } from '@/lib/mobile/v1/openapi';

export const dynamic = 'force-static';

export function GET() {
  return Response.json(mobileOpenAPIV1(), {
    headers: { 'cache-control': 'public, max-age=3600, immutable' },
  });
}
