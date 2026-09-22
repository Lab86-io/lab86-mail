import { redirect } from 'next/navigation';

// The brief_ready notification deep link is `/brief?id=<reportId>` on every
// platform. On the web the shell owns the Today view, so this route only
// forwards the edition id to the shell's `?brief=` parameter (brief round
// 2026-09-22).
export const dynamic = 'force-dynamic';

export default async function BriefRedirectPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const raw = params.id;
  const id = (Array.isArray(raw) ? raw[0] : raw || '').trim().slice(0, 240);
  const target = new URLSearchParams({ view: 'today' });
  if (id) target.set('brief', id);
  redirect(`/?${target.toString()}`);
}
