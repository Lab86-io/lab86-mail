import { createMobileNeedsYouActionPost } from '@/lib/mobile/v1/needs-you';
import { mobileNeedsYouDefaults } from '../shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// POST /api/mobile/v1/needs-you/[id] with an ObligationAction: ObligationActionResponse.
export const POST = createMobileNeedsYouActionPost(mobileNeedsYouDefaults);
