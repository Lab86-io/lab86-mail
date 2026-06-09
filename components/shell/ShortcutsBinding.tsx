'use client';

import { useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { toast } from 'sonner';
import { callTool } from '@/lib/api-client';
import { useClientStore } from '@/lib/client-state';

const editable = (el: EventTarget | null) => {
  if (!el || !(el instanceof HTMLElement)) return false;
  const tag = el.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  return el.isContentEditable;
};

export function ShortcutsBinding() {
  // Thread shortcuts (archive/trash/triage/summary) act on the open thread, so
  // they use that thread's concrete account, not the unified inbox marker.
  const threadAccount = useClientStore((s) => s.threadAccount);
  const inboxAccount = useClientStore((s) => s.account);
  const account = threadAccount || inboxAccount;
  const setQuery = useClientStore((s) => s.setQuery);
  const setSmartCategory = useClientStore((s) => s.setSmartCategory);
  const openComposeNew = useClientStore((s) => s.openComposeNew);
  const setShortcutsOpen = useClientStore((s) => s.setShortcutsOpen);
  const setSelectedThread = useClientStore((s) => s.setSelectedThread);
  const selectedThreadId = useClientStore((s) => s.selectedThreadId);
  const paletteOpen = useClientStore((s) => s.paletteOpen);
  const setPaletteOpen = useClientStore((s) => s.setPaletteOpen);
  const composeMode = useClientStore((s) => s.compose.mode);
  const closeCompose = useClientStore((s) => s.closeCompose);
  const qc = useQueryClient();

  useEffect(() => {
    let pendingG = 0;
    const handler = async (e: KeyboardEvent) => {
      if (editable(e.target)) return;
      // ⌘P / ctrl+P → palette
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'p') {
        e.preventDefault();
        setPaletteOpen(true);
        return;
      }
      // Let browser/OS editing shortcuts work everywhere: copy, paste, select
      // all, undo/redo, save, find, open link in new tab, etc. The single-key
      // mail shortcuts below are only for unmodified keys.
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      // ⌘K → AI bar (handled inside AIBar; let it through)
      // 'g' sequence
      if (e.key === 'g') {
        pendingG = Date.now();
        setTimeout(() => {
          pendingG = 0;
        }, 800);
        return;
      }
      if (pendingG && Date.now() - pendingG < 900) {
        const map: Record<string, string> = {
          u: 'is:unread newer_than:30d',
          s: 'in:sent newer_than:365d',
          d: 'in:drafts',
          t: 'in:trash newer_than:365d',
          a: '-in:trash newer_than:365d',
        };
        if (e.key === 'i') {
          e.preventDefault();
          setSmartCategory('main');
          pendingG = 0;
          return;
        }
        if (map[e.key]) {
          e.preventDefault();
          setQuery(map[e.key]);
          pendingG = 0;
          return;
        }
        pendingG = 0;
      }
      switch (e.key) {
        case 'c':
          e.preventDefault();
          openComposeNew();
          break;
        case '/':
          e.preventDefault();
          (document.querySelector('input[placeholder^="Ask for mail"]') as HTMLInputElement | null)?.focus();
          break;
        case '?':
          e.preventDefault();
          setShortcutsOpen(true);
          break;
        case 'u':
          if (composeMode || selectedThreadId) {
            e.preventDefault();
            closeCompose();
            setSelectedThread(null);
          }
          break;
        case 'e':
          if (selectedThreadId) {
            e.preventDefault();
            try {
              await callTool('archive_thread', { account, threadId: selectedThreadId });
              toast.success('Archived');
              setSelectedThread(null);
              qc.invalidateQueries({ queryKey: ['search'] });
            } catch {
              toast.error('Failed to archive thread');
            }
          }
          break;
        case '#':
          if (selectedThreadId) {
            e.preventDefault();
            try {
              await callTool('trash_thread', { account, threadId: selectedThreadId });
              toast.success('Trashed');
              setSelectedThread(null);
              qc.invalidateQueries({ queryKey: ['search'] });
            } catch {
              toast.error('Failed to trash thread');
            }
          }
          break;
        case 's':
          if (selectedThreadId) {
            e.preventDefault();
            qc.invalidateQueries({ queryKey: ['summary', account, selectedThreadId] });
          }
          break;
        case 't':
          if (selectedThreadId) {
            e.preventDefault();
            try {
              await callTool('triage_thread', { account, threadId: selectedThreadId });
              toast.success('Triaged');
              qc.invalidateQueries({ queryKey: ['search'] });
            } catch {
              toast.error('Failed to triage thread');
            }
          }
          break;
        case 'Escape':
          if (paletteOpen) setPaletteOpen(false);
          else if (composeMode) closeCompose();
          else if (selectedThreadId) setSelectedThread(null);
          break;
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [
    account,
    selectedThreadId,
    paletteOpen,
    composeMode,
    setQuery,
    setSmartCategory,
    openComposeNew,
    setShortcutsOpen,
    setSelectedThread,
    setPaletteOpen,
    closeCompose,
    qc,
  ]);

  return null;
}
