import type { AnyTool } from './registry';
import {
  listAccounts,
  searchThreads,
  getThread,
  getMessage,
  listLabels,
  listAttachments,
  recentThreadsCached,
  listAccountThreads,
} from './mail';
import {
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
} from './mail-mutate';
import {
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
} from './compose';
import {
  summarizeThread,
  triageThread,
  draftReply,
  bulkTriage,
  extractActionItems,
  translateThread,
  preSendCritique,
  nlSearch,
} from './ai';
import { remember, recall, forget, listMemories } from './memories';
import { calendarFreeBusy, calendarSuggestTimes, calendarCreateEvent } from './calendar';
import { contactLookup, expandAlias } from './contacts';
import { browserbaseSearch, browserbaseFetch } from './web';
import { logAction, listAuditEntries } from './audit-tools';
import {
  uiFocusThread,
  uiSetQuery,
  uiOpenCompose,
  uiOpenReply,
  uiToast,
  uiCloseBar,
  uiSwitchAccount,
} from './ui-tools';

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
