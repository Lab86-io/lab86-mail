import { createSecureDetailsRoutes } from '@/lib/secure/routes';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const routes = createSecureDetailsRoutes();

export async function PUT(req: Request, { params }: { params: Promise<{ itemId: string }> }) {
  return routes.update(req, (await params).itemId);
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ itemId: string }> }) {
  return routes.remove((await params).itemId);
}
