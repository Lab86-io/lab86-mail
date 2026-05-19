'use client';

import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { useClientStore } from '@/lib/client-state';
import { callTool } from '@/lib/api-client';

const editable = (el: EventTarget | null) => {
  if (!el || !(el instanceof HTMLElement)) return false;
  const tag = el.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  return el.isContentEditable;
};

export function ShortcutsBinding() {
  const account = useClientStore((s) => s.account);
  const setQuery = useClientStore((s) => s.setQuery);
  const setComposeOpen = useClientStore((s) => s.setComposeOpen);
  const setShortcutsOpen = useClientStore((s) => s.setShortcutsOpen);
  const setSelectedThread = useClientStore((s) => s.setSelectedThread);
  const selectedThreadId = useClientStore((s) => s.selectedThreadId);
  const paletteOpen = useClientStore((s) => s.paletteOpen);
  const setPaletteOpen = useClientStore((s) => s.setPaletteOpen);
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
          i: 'in:inbox newer_than:30d',
          u: 'is:unread newer_than:30d',
          s: 'in:sent newer_than:365d',
          d: 'in:drafts',
          t: 'in:trash newer_than:365d',
          a: '-in:trash newer_than:365d',
        };
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
          setComposeOpen(true);
          break;
        case '/':
          e.preventDefault();
          (document.querySelector('input[placeholder^="Gmail"]') as HTMLInputElement | null)?.focus();
          break;
        case '?':
          e.preventDefault();
          setShortcutsOpen(true);
          break;
        case 'u':
          if (selectedThreadId) {
            e.preventDefault();
            setSelectedThread(null);
          }
          break;
        case 'e':
          if (selectedThreadId) {
            e.preventDefault();
            await callTool('archive_thread', { account, threadId: selectedThreadId }).catch(() => undefined);
            toast.success('Archived');
            setSelectedThread(null);
            qc.invalidateQueries({ queryKey: ['search'] });
          }
          break;
        case '#':
          if (selectedThreadId) {
            e.preventDefault();
            await callTool('trash_thread', { account, threadId: selectedThreadId }).catch(() => undefined);
            toast.success('Trashed');
            setSelectedThread(null);
            qc.invalidateQueries({ queryKey: ['search'] });
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
            await callTool('triage_thread', { account, threadId: selectedThreadId }).catch(() => undefined);
            toast.success('Triaged');
            qc.invalidateQueries({ queryKey: ['search'] });
          }
          break;
        case 'Escape':
          if (paletteOpen) setPaletteOpen(false);
          else if (selectedThreadId) setSelectedThread(null);
          break;
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [account, selectedThreadId, paletteOpen, setQuery, setComposeOpen, setShortcutsOpen, setSelectedThread, setPaletteOpen, qc]);

  return null;
}
