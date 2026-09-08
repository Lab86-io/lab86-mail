import { Suspense } from 'react';
import { NarrativePage } from '@/components/narrative/Narrative';

export default function Page() {
  return (
    <Suspense fallback={<p>Loading narrative…</p>}>
      <NarrativePage />
    </Suspense>
  );
}
