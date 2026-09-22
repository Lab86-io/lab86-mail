import { contentRoutes } from '@/lib/content/http';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const { GET, POST } = contentRoutes();
