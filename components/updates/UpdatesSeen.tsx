'use client';

import { useEffect } from 'react';
import { markUpdatesSeen } from '@/lib/updates/seen';

export function UpdatesSeen({ latestId }: { latestId?: string }) {
  useEffect(() => {
    if (latestId) markUpdatesSeen(latestId);
  }, [latestId]);
  return null;
}
