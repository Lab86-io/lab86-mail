import { createSecureDetailsRoutes } from '@/lib/secure/routes';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Passwords and IDs (docs/albatross-secure-store.md). No response holds a value.

const routes = createSecureDetailsRoutes();

export async function GET() {
  return routes.list();
}

export async function POST(req: Request) {
  return routes.create(req);
}
