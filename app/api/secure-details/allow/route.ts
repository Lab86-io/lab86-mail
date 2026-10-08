import { createSecureDetailsRoutes } from '@/lib/secure/routes';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// The answer to an allow_secure handoff: "Allow once", "Always on this site",
// or "Do not allow". The run continues with the answer.

const routes = createSecureDetailsRoutes();

export async function POST(req: Request) {
  return routes.allow(req);
}
