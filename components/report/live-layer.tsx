'use client';

import { createContext, type ReactNode, useContext } from 'react';

/**
 * The live layer of Today (docs/research/needs-you-web-2-design-2026-11-02.md).
 * Today provides it; the brief canvas renders `node` under the masthead of
 * the current edition and, while `hideNeedsYou` is true, leaves out the
 * stored Needs you lane so that nothing shows twice. Old editions and users
 * outside the flag never see a layer: the provider gives none.
 */
export interface BriefLiveLayerValue {
  node: ReactNode;
  hideNeedsYou: boolean;
  /**
   * The live page takes the place of the stored stories. Past editions keep
   * the letter: they never see a layer.
   */
  replacesDocument?: boolean;
}

export const BriefLiveLayer = createContext<BriefLiveLayerValue | null>(null);

export function useBriefLiveLayer(): BriefLiveLayerValue | null {
  return useContext(BriefLiveLayer);
}
