import { PricingTable } from '@clerk/nextjs';

export default function PricingPage() {
  return (
    <main className="min-h-dvh bg-[var(--color-bg)] px-5 py-10 text-[var(--color-text)]">
      <section className="mx-auto max-w-4xl space-y-6">
        <h1 className="text-2xl font-semibold">Lab86 Mail</h1>
        <PricingTable />
      </section>
    </main>
  );
}
