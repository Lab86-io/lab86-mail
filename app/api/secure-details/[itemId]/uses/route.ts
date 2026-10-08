import { createSecureDetailsRoutes } from '@/lib/secure/routes';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const routes = createSecureDetailsRoutes();

export async function GET(_req: Request, { params }: { params: Promise<{ itemId: string }> }) {
  return routes.uses((await params).itemId);
}
