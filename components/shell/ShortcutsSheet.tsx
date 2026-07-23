'use client';

import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { useClientStore } from '@/lib/client-state';

export const SHORTCUTS: [string[], string][] = [
  [['u', 'esc'], 'Close thread'],
  [['e'], 'Archive'],
  [['#'], 'Trash'],
  [['c'], 'Compose'],
  [['/'], 'Focus search'],
  [['s'], 'Summarize current thread'],
  [['t'], 'Triage current thread'],
  [['g', 'i'], 'Go to Inbox'],
  [['g', 'u'], 'Go to Unread'],
  [['g', 's'], 'Go to Sent'],
  [['⌘', 'K'], 'AI command bar'],
  [['⌘', 'P'], 'Command palette'],
  [['?'], 'This sheet'],
];

export function ShortcutsSheet() {
  const open = useClientStore((s) => s.shortcutsOpen);
  const setOpen = useClientStore((s) => s.setShortcutsOpen);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="max-w-[520px]">
        <DialogTitle>Keyboard shortcuts</DialogTitle>
        <DialogDescription className="sr-only">
          Keyboard shortcuts for navigating and acting on mail.
        </DialogDescription>
        <div className="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-[13px]">
          {SHORTCUTS.map(([keys, label]) => (
            <div key={label} className="contents">
              <div className="flex items-center gap-1">
                {keys.map((k) => (
                  <kbd key={k}>{k}</kbd>
                ))}
              </div>
              <div className="text-[var(--color-text-muted)]">{label}</div>
            </div>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
