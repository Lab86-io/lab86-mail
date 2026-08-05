'use client';

import { FirstBurden } from '@/components/hosted/FirstBurden';
import { DotGridGlow } from '@/components/ui/dot-grid-glow';

export default function WelcomePage() {
  return (
    <main className="app-paper relative grid min-h-dvh place-items-center px-4 py-10">
      <DotGridGlow />
      <div className="relative z-10 flex w-full justify-center">
        <FirstBurden />
      </div>
    </main>
  );
}
