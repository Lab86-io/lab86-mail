import { isAlbatrossEnabled } from '@/lib/hosted/controls';
import { isClerkConfigured } from '@/lib/hosted/env';
import { ClientPage } from './client-page';

export const dynamic = 'force-dynamic';

export default function HomePage() {
  return <ClientPage albatrossEnabled={isAlbatrossEnabled()} clerkEnabled={isClerkConfigured()} />;
}
