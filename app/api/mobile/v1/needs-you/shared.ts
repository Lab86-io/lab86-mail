import { requireCurrentUser } from '@/lib/auth/current-user';
import { api, convexQuery } from '@/lib/hosted/convex';
import type { MobileNeedsYouDependencies } from '@/lib/mobile/v1/needs-you';
import { type NeedsYouSnapshot, needsYouFlagFor } from '@/lib/obligations/contract';
import { enforceUserRateLimit } from '@/lib/rate-limit';
import { obligationAlbatrossDefaults } from '../../../obligations/[id]/albatross/shared';
import { obligationServiceDefaults } from '../../../obligations/shared';

// The real dependencies of the mobile Needs you routes: the same services as
// the web routes (app/api/obligations/**), with the mobile session.

export const mobileNeedsYouDefaults: MobileNeedsYouDependencies = {
  requireCurrentUser,
  enforceUserRateLimit,
  flag: (userId) => needsYouFlagFor(userId),
  snapshot: (userId) => convexQuery<NeedsYouSnapshot>(api.obligationViews.snapshotFor, { userId }),
  service: obligationServiceDefaults,
  albatross: obligationAlbatrossDefaults,
};
