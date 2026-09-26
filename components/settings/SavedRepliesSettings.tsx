'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { toast } from 'sonner';
import {
  MailSettingsCard,
  MailSettingsGroupTitle,
  MailSettingsNote,
} from '@/components/settings/mail-settings-ui';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { callTool } from '@/lib/api-client';

export interface SavedReplyRow {
  id: string;
  name: string;
  body: string;
  createdAt: number;
  updatedAt: number;
}

export const SAVED_REPLIES_QUERY_KEY = ['saved-replies'] as const;

export function useSavedReplies(enabled = true) {
  return useQuery({
    queryKey: SAVED_REPLIES_QUERY_KEY,
    queryFn: async () => (await callTool<{ replies: SavedReplyRow[] }>('list_saved_replies', {})).replies,
    staleTime: 60_000,
    enabled,
  });
}

/** Named snippets for the composer and the assistant (FEATURES item 11). */
export function SavedRepliesSettings() {
  const replies = useSavedReplies();
  const [editing, setEditing] = useState<string | 'new' | null>(null);
  const rows = replies.data || [];
  return (
    <section>
      <MailSettingsGroupTitle aside={rows.length ? `${rows.length} saved` : undefined}>
        Saved replies
      </MailSettingsGroupTitle>
      <MailSettingsCard>
        {replies.isLoading ? (
          <p className="px-4 py-3 text-[12.5px] text-[var(--color-text-muted)]">Loading saved replies…</p>
        ) : replies.error ? (
          <p className="px-4 py-3 text-[12.5px] text-[var(--color-danger)]">
            Saved replies could not load. Reload to try again.
          </p>
        ) : null}
        {rows.map((reply) =>
          editing === reply.id ? (
            <SavedReplyForm key={reply.id} reply={reply} onDone={() => setEditing(null)} />
          ) : (
            <SavedReplyItem key={reply.id} reply={reply} onEdit={() => setEditing(reply.id)} />
          ),
        )}
        {editing === 'new' ? (
          <SavedReplyForm onDone={() => setEditing(null)} />
        ) : (
          <div className="px-4 py-3">
            <Button type="button" size="sm" variant="outline" onClick={() => setEditing('new')}>
              New saved reply
            </Button>
            {!rows.length && !replies.isLoading ? (
              <span className="ml-3 text-[12px] text-[var(--color-text-muted)]">
                Write an answer you give often, once.
              </span>
            ) : null}
          </div>
        )}
      </MailSettingsCard>
      <MailSettingsNote>
        Insert a saved reply from the composer. When you ask Albatross to draft a reply, it can use your saved
        replies and change the details to fit the thread.
      </MailSettingsNote>
    </section>
  );
}

function SavedReplyItem({ reply, onEdit }: { reply: SavedReplyRow; onEdit: () => void }) {
  const queryClient = useQueryClient();
  const remove = useMutation({
    mutationFn: async () => callTool('delete_saved_reply', { id: reply.id }),
    onSuccess: () => {
      queryClient.setQueryData<SavedReplyRow[]>(SAVED_REPLIES_QUERY_KEY, (current) =>
        (current || []).filter((item) => item.id !== reply.id),
      );
      toast.success(`Deleted "${reply.name}"`);
    },
    onError: (error: Error) => toast.error(error.message || 'Could not delete the saved reply.'),
  });
  return (
    <div className="flex items-start gap-3 px-4 py-3">
      <div className="min-w-0 flex-1">
        <p className="text-[13px] font-medium">{reply.name}</p>
        <p className="mt-0.5 line-clamp-2 whitespace-pre-line text-[12px] text-[var(--color-text-muted)]">
          {reply.body}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        <Button type="button" size="xs" variant="outline" onClick={onEdit}>
          Edit
        </Button>
        <Button
          type="button"
          size="xs"
          variant="outline"
          disabled={remove.isPending}
          onClick={() => remove.mutate()}
        >
          {remove.isPending ? 'Deleting…' : 'Delete'}
        </Button>
      </div>
    </div>
  );
}

function SavedReplyForm({ reply, onDone }: { reply?: SavedReplyRow; onDone: () => void }) {
  const queryClient = useQueryClient();
  const [name, setName] = useState(reply?.name || '');
  const [body, setBody] = useState(reply?.body || '');
  const save = useMutation({
    mutationFn: async () =>
      callTool<{ reply: SavedReplyRow }>('save_saved_reply', {
        ...(reply ? { id: reply.id } : {}),
        name,
        body,
      }),
    onSuccess: ({ reply: saved }) => {
      queryClient.setQueryData<SavedReplyRow[]>(SAVED_REPLIES_QUERY_KEY, (current) =>
        [...(current || []).filter((item) => item.id !== saved.id), saved].sort((a, b) =>
          a.name.localeCompare(b.name),
        ),
      );
      toast.success(reply ? 'Saved reply updated' : 'Saved reply added');
      onDone();
    },
    onError: (error: Error) => toast.error(error.message || 'Could not save the reply.'),
  });
  return (
    <form
      className="space-y-2 px-4 py-3"
      onSubmit={(event) => {
        event.preventDefault();
        save.mutate();
      }}
    >
      <Input
        value={name}
        maxLength={80}
        onChange={(event) => setName(event.target.value)}
        placeholder="Name, for example: Meeting times"
        aria-label="Saved reply name"
        className="h-8 text-[13px]"
      />
      <Textarea
        value={body}
        maxLength={5000}
        rows={4}
        onChange={(event) => setBody(event.target.value)}
        placeholder="The text to insert"
        aria-label="Saved reply text"
        className="min-h-24 resize-y text-[13px]"
      />
      <div className="flex items-center justify-between gap-3">
        <span className="text-[11px] tabular-nums text-[var(--color-text-faint)]">{body.length}/5000</span>
        <div className="flex items-center gap-1.5">
          <Button type="button" size="sm" variant="ghost" onClick={onDone}>
            Cancel
          </Button>
          <Button type="submit" size="sm" disabled={!name.trim() || !body.trim() || save.isPending}>
            {save.isPending ? 'Saving…' : 'Save'}
          </Button>
        </div>
      </div>
    </form>
  );
}
