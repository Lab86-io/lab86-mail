'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import {
  MailSettingsCard,
  MailSettingsGroupTitle,
  MailSettingsNote,
  MailSettingsRow,
} from '@/components/settings/mail-settings-ui';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { callTool } from '@/lib/api-client';

export interface SignatureRow {
  accountId: string;
  email?: string;
  displayName?: string;
  enabled: boolean;
  text: string;
  html?: string;
  updatedAt: number;
}

export const SIGNATURES_QUERY_KEY = ['mail-signatures'] as const;

export function useSignatures(enabled = true) {
  return useQuery({
    queryKey: SIGNATURES_QUERY_KEY,
    queryFn: async () => (await callTool<{ signatures: SignatureRow[] }>('list_signatures', {})).signatures,
    staleTime: 60_000,
    enabled,
  });
}

/** One signature for each mailbox, added when mail goes out (FEATURES item 11). */
export function SignatureSettings() {
  const signatures = useSignatures();
  const rows = signatures.data || [];
  const on = rows.filter((row) => row.enabled && row.text.trim()).length;
  return (
    <section>
      <MailSettingsGroupTitle aside={rows.length ? `${on} of ${rows.length} on` : undefined}>
        Signatures
      </MailSettingsGroupTitle>
      {signatures.isLoading ? (
        <p className="text-[12.5px] text-[var(--color-text-muted)]">Loading signatures…</p>
      ) : signatures.error ? (
        <p className="text-[12.5px] text-[var(--color-danger)]">
          Signatures could not load. Reload to try again.
        </p>
      ) : rows.length ? (
        <MailSettingsCard>
          {rows.map((row) => (
            <SignatureEditor key={row.accountId} row={row} />
          ))}
        </MailSettingsCard>
      ) : (
        <p className="text-[12.5px] text-[var(--color-text-muted)]">
          Connect a mailbox to give it a signature.
        </p>
      )}
      <MailSettingsNote>
        Albatross adds the signature below new mail, replies, and forwards from that mailbox, on the web, on
        iPhone, on Mac, and in drafts it sends for you. You can leave it off for one message in the composer.
      </MailSettingsNote>
    </section>
  );
}

function SignatureEditor({ row }: { row: SignatureRow }) {
  const queryClient = useQueryClient();
  const [text, setText] = useState(row.text);
  const [html, setHtml] = useState(row.html || '');
  const [enabled, setEnabled] = useState(row.enabled);
  const [showHtml, setShowHtml] = useState(Boolean(row.html));
  useEffect(() => {
    setText(row.text);
    setHtml(row.html || '');
    setEnabled(row.enabled);
  }, [row.text, row.html, row.enabled]);
  const dirty = text !== row.text || html !== (row.html || '') || enabled !== row.enabled;
  const save = useMutation({
    mutationFn: async (next: { enabled: boolean }) =>
      callTool<{ signature: SignatureRow }>('set_signature', {
        account: row.accountId,
        enabled: next.enabled,
        text,
        ...(html.trim() ? { html } : {}),
      }),
    onSuccess: (result) => {
      queryClient.setQueryData<SignatureRow[]>(SIGNATURES_QUERY_KEY, (current) =>
        (current || []).map((item) =>
          item.accountId === row.accountId ? { ...item, ...result.signature } : item,
        ),
      );
      toast.success('Signature saved');
    },
    onError: (error: Error) => {
      setEnabled(row.enabled);
      toast.error(error.message || 'Could not save the signature.');
    },
  });
  const id = `signature-${row.accountId}`;
  const mailbox = row.email || row.displayName || row.accountId;
  return (
    <MailSettingsRow
      id={`${id}-on`}
      label={mailbox}
      description={
        enabled && text.trim()
          ? 'Added below mail you send from this mailbox.'
          : 'Off. Mail from this mailbox goes out without a signature.'
      }
      control={
        <Switch
          id={`${id}-on`}
          checked={enabled}
          disabled={save.isPending || !text.trim()}
          aria-label={`Add the signature to mail from ${mailbox}`}
          onCheckedChange={(checked) => {
            setEnabled(checked);
            save.mutate({ enabled: checked });
          }}
        />
      }
    >
      <Textarea
        id={id}
        value={text}
        maxLength={2000}
        rows={3}
        onChange={(event) => setText(event.target.value)}
        placeholder={'Ann Lee\nExample Co.'}
        aria-label={`Signature for ${mailbox}`}
        className="min-h-20 resize-y text-[13px]"
      />
      {showHtml ? (
        <div className="mt-2">
          <p className="mb-1 text-[11.5px] text-[var(--color-text-muted)]">
            Formatted version (simple HTML: bold, italics, and links). Mail programs that show plain text use
            the version above.
          </p>
          <Textarea
            value={html}
            rows={3}
            maxLength={10000}
            onChange={(event) => setHtml(event.target.value)}
            placeholder={'<b>Ann Lee</b><br><a href="https://example.com">example.com</a>'}
            aria-label={`Formatted signature for ${mailbox}`}
            className="min-h-20 resize-y font-mono text-[12px]"
          />
        </div>
      ) : null}
      <div className="mt-2 flex items-center justify-between gap-3">
        <button
          type="button"
          onClick={() => setShowHtml((value) => !value)}
          className="text-[11.5px] text-[var(--color-text-muted)] underline-offset-2 hover:text-[var(--color-text)] hover:underline"
        >
          {showHtml ? 'Hide the formatted version' : 'Add a formatted version'}
        </button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={!dirty || save.isPending}
          onClick={() => save.mutate({ enabled: enabled && Boolean(text.trim()) })}
        >
          {save.isPending ? 'Saving…' : 'Save signature'}
        </Button>
      </div>
    </MailSettingsRow>
  );
}
