import { createMobileNeedsYouAlbatrossPost } from '@/lib/mobile/v1/needs-you';
import { mobileNeedsYouDefaults } from '../../shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// POST /api/mobile/v1/needs-you/[id]/albatross ("Start in Albatross"): ObligationAlbatrossResponse.
export const POST = createMobileNeedsYouAlbatrossPost(mobileNeedsYouDefaults);
