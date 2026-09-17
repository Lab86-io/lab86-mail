'use client';

import { useEffect } from 'react';
import { FilesSurface } from '@/components/files/FilesSurface';
import { AIBarTrigger, AssistantChat } from '@/components/shell/AIBar';
import { AssistantWorkspace } from '@/components/shell/AssistantWorkspace';
import { TooltipProvider } from '@/components/ui/tooltip';
import { useIsMobile } from '@/hooks/use-mobile';
import { useClientStore } from '@/lib/client-state';

// The native shell owns navigation; keep the actual Files and assistant
// surfaces together so every editor's "Edit with Albatross" remains live.
export function NativeFilesWorkspace({ clerkEnabled }: { clerkEnabled: boolean }) {
  const mobile = useIsMobile();
  useEffect(() => {
    useClientStore.getState().setPrimaryView('files');
  }, []);
  const open = useClientStore((state) => state.aiBarOpen);
  const presentation = useClientStore((state) => state.assistantPresentation);
  const setPresentation = useClientStore((state) => state.setAssistantPresentation);
  const setOpen = useClientStore((state) => state.setAiBarOpen);
  const dirty = useClientStore((state) => state.assistantDocument?.dirty ?? false);
  useEffect(() => {
    const bridge = window as Window & {
      webkit?: { messageHandlers?: { albatrossEditor?: { postMessage: (body: unknown) => void } } };
    };
    bridge.webkit?.messageHandlers?.albatrossEditor?.postMessage({ type: 'editorState', dirty });
  }, [dirty]);
  return (
    <TooltipProvider>
      <main className="app-paper relative flex h-dvh min-w-0 flex-col overflow-hidden">
        <AssistantWorkspace
          open={open}
          presentation={presentation}
          onPresentationChange={setPresentation}
          onClose={() => setOpen(false)}
          mobile={mobile}
          assistant={<AssistantChat clerkEnabled={clerkEnabled} />}
        >
          <div className="h-full min-h-0 overflow-auto">
            <FilesSurface />
          </div>
        </AssistantWorkspace>
        <AIBarTrigger />
      </main>
    </TooltipProvider>
  );
}
