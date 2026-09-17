import { NativeFilesWorkspace } from '@/components/files/NativeFilesWorkspace';
import { isClerkConfigured } from '@/lib/hosted/env';

export const dynamic = 'force-dynamic';

// Same editor, library, imports, revisions, AI, exports and provider operations
// as web; the native app supplies navigation around this surface.
export default function NativeFilesPage() {
  return <NativeFilesWorkspace clerkEnabled={isClerkConfigured()} />;
}
