import { isClerkConfigured } from '@/lib/hosted/env';
import { ClientPage } from './client-page';

export const dynamic = 'force-dynamic';

export default function HomePage() {
  return <ClientPage clerkEnabled={isClerkConfigured()} />;
}
