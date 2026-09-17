import { NativeSessionBootstrap } from '@/components/files/NativeSessionBootstrap';
import { isClerkConfigured } from '@/lib/hosted/env';

export const dynamic = 'force-dynamic';

export default function NativeSessionPage() {
  if (!isClerkConfigured()) return <main className="p-6">Sign-in is not configured for this server.</main>;
  return <NativeSessionBootstrap />;
}
