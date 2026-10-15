import { createSecureDetailsRoutes } from '@/lib/secure/routes';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// A send grant: "Allow for this send" or "Always for mail to <domain>" for a
// filled PDF with a saved value (lib/secure/send-grants.ts).

const routes = createSecureDetailsRoutes();

export async function POST(req: Request) {
  return routes.allowSend(req);
}
