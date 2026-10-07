'use client';

// Settings, Personal details (docs/albatross-thread.md, S21 to S24): the
// facts Albatross types into forms, each with where it came from. Add, change,
// or delete each one in place. The server refuses passwords, card numbers, and
// ID numbers; the refusal shows under the row. The list is the same shape the
// dev harness and the tests render without a server (`PersonalDetailsList`).

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { toast } from 'sonner';
import { FormFieldInput } from '@/components/ai-elements/form-question-card';
import {
  fetchPersonalDetails,
  PERSONAL_DETAILS_QUERY_KEY,
  usePersonalDetails,
} from '@/components/ai-elements/use-personal-details';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  type FormField,
  type FormFieldValue,
  PERSONAL_DETAIL_LABELS,
  type PersonalDetailsResponse,
  type PersonalDetailView,
  personalDetailValueSchema,
} from '@/lib/albatross/thread-contract';
import {
  accountNameHint,
  detailSourceLine,
  PERSONAL_DETAILS_COPY,
  personalDetailRows,
  savedCountLine,
} from '@/lib/albatross/thread-view';
import { SectionHeading, SettingsCard, SettingsNote, SettingsRow } from './primitives';

const FIELD_KIND: Record<string, FormField['kind']> = {
  name: 'name',
  email: 'email',
  phone: 'phone',
  home_address: 'address',
  emergency_contact: 'contact',
};

const INVALID: Record<string, string> = {
  name: 'Type the first and last name.',
  email: 'Type an email address.',
  phone: 'Type a phone number with at least 7 digits.',
  home_address: 'Complete the street, city, state, and postal code.',
  emergency_contact: 'Type the name and the phone number.',
};

export interface DetailSaveError {
  key: string;
  message: string;
}

export interface PersonalDetailsListProps {
  response: PersonalDetailsResponse | null;
  accountName?: string | null;
  loading?: boolean;
  loadError?: string | null;
  busyKey?: string | null;
  /** The last save error, under its row. */
  error?: DetailSaveError | null;
  onSave: (key: string, value: unknown, label?: string) => Promise<boolean>;
  onDelete: (key: string, label: string) => void;
  timeZone?: string;
}

export function PersonalDetailsList({
  response,
  accountName,
  loading,
  loadError,
  busyKey,
  error,
  onSave,
  onDelete,
  timeZone,
}: PersonalDetailsListProps) {
  const [editing, setEditing] = useState<string | 'new' | null>(null);
  const rows = personalDetailRows(response, PERSONAL_DETAIL_LABELS);
  return (
    <section data-slot="personal-details">
      <SectionHeading
        title={PERSONAL_DETAILS_COPY.title}
        blurb={PERSONAL_DETAILS_COPY.blurb}
        aside={response ? savedCountLine(response.details) : undefined}
      />
      <SettingsCard>
        {loading ? (
          <p className="px-4 py-3 text-[12.5px] text-[var(--color-text-muted)]">
            {PERSONAL_DETAILS_COPY.loading}
          </p>
        ) : loadError ? (
          <p className="px-4 py-3 text-[12.5px] text-[var(--color-danger)]">{loadError}</p>
        ) : null}
        {rows.map((row) =>
          editing === row.key ? (
            <DetailEditor
              key={row.key}
              detailKey={row.key}
              label={row.label}
              detail={row.detail}
              busy={busyKey === row.key}
              error={error?.key === row.key ? error.message : null}
              onSave={async (value, label) => {
                const ok = await onSave(row.key, value, label);
                if (ok) setEditing(null);
              }}
              onCancel={() => setEditing(null)}
            />
          ) : (
            <SettingsRow
              key={row.key}
              label={row.label}
              description={
                row.detail ? (
                  <span data-slot="detail-value">{row.detail.display}</span>
                ) : (
                  <span className="text-[var(--color-text-faint)]">{PERSONAL_DETAILS_COPY.notSaved}</span>
                )
              }
              hint={
                row.detail ? (
                  <span data-slot="detail-source">
                    {detailSourceLine(row.detail, { timeZone })}
                    {accountNameHint(row.detail, accountName) ? (
                      <> · {accountNameHint(row.detail, accountName)}</>
                    ) : null}
                  </span>
                ) : undefined
              }
              control={
                <>
                  {error?.key === row.key ? (
                    <span className="text-[11.5px] text-[var(--color-danger)]">{error.message}</span>
                  ) : null}
                  <Button type="button" size="xs" variant="outline" onClick={() => setEditing(row.key)}>
                    {row.detail ? PERSONAL_DETAILS_COPY.change : PERSONAL_DETAILS_COPY.add}
                  </Button>
                  {row.detail?.saved ? (
                    <Button
                      type="button"
                      size="xs"
                      variant="outline"
                      disabled={busyKey === row.key}
                      onClick={() => onDelete(row.key, row.label)}
                    >
                      {PERSONAL_DETAILS_COPY.delete}
                    </Button>
                  ) : null}
                </>
              }
            />
          ),
        )}
        {editing === 'new' ? (
          <DetailEditor
            detailKey="custom"
            label=""
            detail={null}
            busy={busyKey === 'custom'}
            error={error?.key === 'custom' ? error.message : null}
            onSave={async (value, label) => {
              const ok = await onSave('custom', value, label);
              if (ok) setEditing(null);
            }}
            onCancel={() => setEditing(null)}
          />
        ) : (
          <div className="flex flex-wrap items-center gap-3 px-4 py-3">
            <Button type="button" size="sm" variant="outline" onClick={() => setEditing('new')}>
              {PERSONAL_DETAILS_COPY.addDetail}
            </Button>
            <span className="text-[12px] text-[var(--color-text-muted)]">
              {PERSONAL_DETAILS_COPY.addDetailHint}
            </span>
          </div>
        )}
      </SettingsCard>
      <SettingsNote>{PERSONAL_DETAILS_COPY.note}</SettingsNote>
    </section>
  );
}

function DetailEditor({
  detailKey,
  label,
  detail,
  busy,
  error,
  onSave,
  onCancel,
}: {
  detailKey: string;
  label: string;
  detail: PersonalDetailView | null;
  busy: boolean;
  error: string | null;
  onSave: (value: unknown, label?: string) => Promise<void>;
  onCancel: () => void;
}) {
  const id = useId();
  const custom = detailKey === 'custom' || detailKey.startsWith('custom:');
  const kind = custom ? 'text' : FIELD_KIND[detailKey];
  const [value, setValue] = useState<FormFieldValue | undefined>(() => {
    if (!detail) return undefined;
    if (custom) return (detail.value as { value: string }).value;
    return detail.value as FormFieldValue;
  });
  const [customLabel, setCustomLabel] = useState(() =>
    detail && custom ? (detail.value as { label: string }).label : label,
  );
  const [localError, setLocalError] = useState<string | null>(null);
  const field: FormField = { id: detailKey.replace(/[^a-z0-9_]/g, '_'), label: label || 'Value', kind };

  const submit = async () => {
    if (custom) {
      const text = typeof value === 'string' ? value.trim() : '';
      if (!customLabel.trim() || !text) {
        setLocalError('Type a label and a value.');
        return;
      }
      await onSave(text, customLabel.trim());
      return;
    }
    const parsed = personalDetailValueSchema(detailKey as never).safeParse(value);
    if (!parsed.success) {
      setLocalError(INVALID[detailKey] ?? 'Check this value.');
      return;
    }
    await onSave(parsed.data);
  };

  return (
    <div data-slot="detail-editor" className="px-4 py-3">
      <p className="text-[13px] font-medium">{label || PERSONAL_DETAILS_COPY.addDetail}</p>
      <div className="mt-2 flex flex-col gap-2 sm:max-w-md">
        {custom ? (
          <Input
            aria-label="Label"
            placeholder="Label, for example Employer"
            value={customLabel}
            onChange={(event) => setCustomLabel(event.target.value)}
            className="h-8 text-[12.5px]"
          />
        ) : null}
        <FormFieldInput
          id={id}
          field={field}
          value={value}
          disabled={busy}
          error={localError ?? error ?? undefined}
          onChange={(next) => {
            setLocalError(null);
            setValue(next);
          }}
        />
        {localError || error ? (
          <p role="alert" className="text-[11.5px] text-[var(--color-danger)]">
            {localError || error}
          </p>
        ) : null}
      </div>
      <div className="mt-3 flex items-center gap-2">
        <Button type="button" size="sm" disabled={busy} onClick={() => void submit()}>
          {busy ? PERSONAL_DETAILS_COPY.saving : PERSONAL_DETAILS_COPY.save}
        </Button>
        <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={onCancel}>
          {PERSONAL_DETAILS_COPY.cancel}
        </Button>
      </div>
    </div>
  );
}

async function readJson(res: Response) {
  const data = await res.json().catch(() => null);
  if (!res.ok || data?.ok === false) {
    const error = new Error(data?.error || `Request failed (${res.status})`) as Error & { code?: string };
    error.code = data?.code;
    throw error;
  }
  return data;
}

export function PersonalDetailsSection({ accountName }: { accountName?: string | null }) {
  const qc = useQueryClient();
  const query = usePersonalDetails();
  const [error, setError] = useState<DetailSaveError | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: async (input: { key: string; value: unknown; label?: string }) =>
      readJson(
        await fetch('/api/personal-details', {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(input),
        }),
      ),
  });
  const remove = useMutation({
    mutationFn: async (key: string) =>
      readJson(await fetch(`/api/personal-details?key=${encodeURIComponent(key)}`, { method: 'DELETE' })),
  });

  const refresh = async () => {
    const next = await fetchPersonalDetails().catch(() => null);
    if (next) qc.setQueryData(PERSONAL_DETAILS_QUERY_KEY, next);
    else void qc.invalidateQueries({ queryKey: PERSONAL_DETAILS_QUERY_KEY });
  };

  return (
    <PersonalDetailsList
      response={query.data ?? null}
      accountName={accountName}
      loading={query.isLoading}
      loadError={query.isError ? PERSONAL_DETAILS_COPY.loadError : null}
      busyKey={busyKey}
      error={error}
      onSave={async (key, value, label) => {
        setBusyKey(key);
        setError(null);
        try {
          await save.mutateAsync({ key, value, ...(label ? { label } : {}) });
          await refresh();
          toast.success(
            PERSONAL_DETAILS_COPY.saved(label || PERSONAL_DETAIL_LABELS[key as never] || 'Detail'),
          );
          return true;
        } catch (cause) {
          setError({ key, message: cause instanceof Error ? cause.message : 'Could not save this detail.' });
          return false;
        } finally {
          setBusyKey(null);
        }
      }}
      onDelete={(key, label) => {
        setBusyKey(key);
        setError(null);
        void remove
          .mutateAsync(key)
          .then(async () => {
            await refresh();
            toast.success(PERSONAL_DETAILS_COPY.deleted(label), {
              action: {
                label: 'Undo',
                onClick: () => {
                  void fetch('/api/personal-details', {
                    method: 'POST',
                    headers: { 'content-type': 'application/json' },
                    body: JSON.stringify({ action: 'undo', key }),
                  })
                    .then(readJson)
                    .then(async () => {
                      await refresh();
                      toast.success(PERSONAL_DETAILS_COPY.restored(label));
                    })
                    .catch((cause: Error) => toast.error(cause.message || 'Could not restore the detail.'));
                },
              },
            });
          })
          .catch((cause: Error) =>
            setError({ key, message: cause.message || 'Could not delete this detail.' }),
          )
          .finally(() => setBusyKey(null));
      }}
    />
  );
}
