import {
  bulkTriage,
  draftReply,
  extractActionItems,
  nlSearch,
  preSendCritique,
  summarizeThread,
  translateThread,
  triageThread,
} from './ai';
import { listAuditEntries, logAction } from './audit-tools';
import { calendarCreateEvent, calendarFreeBusy, calendarSuggestTimes } from './calendar';
import {
  cancelScheduled,
  deleteDraftTool,
  forwardMessage,
  listDraftsTool,
  replyAllMessage,
  replyMessage,
  saveDraftTool,
  scheduleSend,
  sendMessage,
  undoSend,
  updateDraft,
} from './compose';
import { contactLookup, expandAlias } from './contacts';
import {
  getMessage,
  getThread,
  listAccounts,
  listAccountThreads,
  listAttachments,
  listLabels,
  recentThreadsCached,
  searchThreads,
} from './mail';
import {
  addLabel,
  archiveThread,
  createLabel,
  markRead,
  markUnread,
  muteThread,
  removeLabel,
  restoreFromTrash,
  snoozeThreadTool,
  starMessage,
  trashThread,
  unsnoozeThreadTool,
  unstarMessage,
} from './mail-mutate';
import { forget, listMemories, recall, remember } from './memories';
import { resolvePhotos } from './photos';
import type { AnyTool } from './registry';
import {
  uiCloseBar,
  uiFocusThread,
  uiOpenCompose,
  uiOpenReply,
  uiSetQuery,
  uiSwitchAccount,
  uiToast,
} from './ui-tools';
import { browserbaseFetch, browserbaseSearch } from './web';

const allTools: AnyTool[] = [
  listAccounts,
  searchThreads,
  getThread,
  getMessage,
  listLabels,
  listAttachments,
  recentThreadsCached,
  listAccountThreads,
  archiveThread,
  trashThread,
  restoreFromTrash,
  markRead,
  markUnread,
  starMessage,
  unstarMessage,
  addLabel,
  removeLabel,
  createLabel,
  muteThread,
  snoozeThreadTool,
  unsnoozeThreadTool,
  sendMessage,
  replyMessage,
  replyAllMessage,
  forwardMessage,
  saveDraftTool,
  updateDraft,
  deleteDraftTool,
  listDraftsTool,
  scheduleSend,
  cancelScheduled,
  undoSend,
  summarizeThread,
  triageThread,
  draftReply,
  bulkTriage,
  extractActionItems,
  translateThread,
  preSendCritique,
  nlSearch,
  remember,
  recall,
  forget,
  listMemories,
  calendarFreeBusy,
  calendarSuggestTimes,
  calendarCreateEvent,
  contactLookup,
  expandAlias,
  resolvePhotos,
  browserbaseSearch,
  browserbaseFetch,
  logAction,
  listAuditEntries,
  // UI tools — server returns ack, client intercepts for the real mutation.
  uiFocusThread,
  uiSetQuery,
  uiOpenCompose,
  uiOpenReply,
  uiToast,
  uiCloseBar,
  uiSwitchAccount,
];

export const TOOLS: Record<string, AnyTool> = Object.fromEntries(allTools.map((t) => [t.name, t]));

export function listToolMetadata() {
  return allTools.map((t) => ({
    name: t.name,
    description: t.description,
    category: t.category,
    mutating: t.mutating,
  }));
}

export function getTool(name: string): AnyTool | null {
  return TOOLS[name] || null;
}
