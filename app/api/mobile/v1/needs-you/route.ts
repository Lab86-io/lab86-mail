import { createMobileNeedsYouGet } from '@/lib/mobile/v1/needs-you';
import { mobileNeedsYouDefaults } from './shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// GET /api/mobile/v1/needs-you: NeedsYouSnapshot (lib/mobile/v1/needs-you.ts).
export const GET = createMobileNeedsYouGet(mobileNeedsYouDefaults);
