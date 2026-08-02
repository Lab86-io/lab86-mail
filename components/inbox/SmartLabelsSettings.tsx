'use client';

import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { callTool } from '@/lib/api-client';

// Moved out of the navigation rail: configuring smart labels is settings work,
// not a place to navigate to. The dialog itself is unchanged.
export function SmartLabelsSettings({
  open,
  onOpenChange,
  labels,
  onChanged,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  labels: any[];
  onChanged: () => void;
}) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [positive, setPositive] = useState('');
  const [negative, setNegative] = useState('');
  const [previewItems, setPreviewItems] = useState<any[]>([]);
  const { data: rulesData } = useQuery({
    queryKey: ['smart-rules', open],
    queryFn: async () =>
      callTool<{ rules: any[]; corrections: any[] }>('list_smart_rules', { correctionLimit: 20 }),
    enabled: open,
  });
  const createLabel = useMutation({
    mutationFn: async () =>
      callTool('create_smart_label', {
        name,
        description,
        positiveExamples: [positive],
        negativeExamples: [negative],
      }),
    onSuccess: () => {
      setName('');
      setDescription('');
      setPositive('');
      setNegative('');
      setPreviewItems([]);
      onChanged();
    },
  });
  const previewLabel = useMutation({
    mutationFn: async () =>
      callTool<{ items: any[] }>('preview_smart_label', {
        name,
        description,
        positiveExamples: [positive],
        negativeExamples: [negative],
        max: 8,
      }),
    onSuccess: (res) => setPreviewItems(res.items || []),
  });
  const toggleLabel = useMutation({
    mutationFn: async ({ id, enabled }: { id: string; enabled: boolean }) =>
      callTool('update_smart_label', { id, enabled }),
    onSuccess: onChanged,
  });
  const disableRule = useMutation({
    mutationFn: async (id: string) => callTool('set_smart_rule_enabled', { id, enabled: false }),
    onSuccess: onChanged,
  });
  const deleteLabel = useMutation({
    mutationFn: async (id: string) => callTool('delete_smart_label', { id }),
    onSuccess: onChanged,
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[84vh] !max-w-5xl overflow-y-auto">
        <DialogTitle>Smart Labels</DialogTitle>
        <div className="grid gap-6 md:grid-cols-2">
          <section className="space-y-2">
            <h3 className="text-[13px] font-semibold">Create custom label</h3>
            <div className="grid gap-2">
              <label htmlFor="smart-label-name" className="sr-only">
                Name
              </label>
              <input
                id="smart-label-name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="Name"
                className="h-9 rounded-md border bg-background px-2 text-[13px]"
              />
              <label htmlFor="smart-label-description" className="sr-only">
                Description
              </label>
              <textarea
                id="smart-label-description"
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                placeholder="What should this label match?"
                className="min-h-20 rounded-md border bg-background px-2 py-2 text-[13px]"
              />
              <label htmlFor="smart-label-positive" className="sr-only">
                Positive example
              </label>
              <input
                id="smart-label-positive"
                value={positive}
                onChange={(event) => setPositive(event.target.value)}
                placeholder="Positive example"
                className="h-9 rounded-md border bg-background px-2 text-[13px]"
              />
              <label htmlFor="smart-label-negative" className="sr-only">
                Negative example
              </label>
              <input
                id="smart-label-negative"
                value={negative}
                onChange={(event) => setNegative(event.target.value)}
                placeholder="Negative example"
                className="h-9 rounded-md border bg-background px-2 text-[13px]"
              />
              <div className="flex gap-2">
                <button
                  type="button"
                  disabled={previewLabel.isPending || !name || !description || !positive || !negative}
                  onClick={() => previewLabel.mutate()}
                  className="h-9 flex-1 rounded-md border border-[var(--color-border)] px-3 text-[13px] disabled:opacity-50"
                >
                  {previewLabel.isPending ? 'Previewing...' : 'Preview matches'}
                </button>
                <button
                  type="button"
                  disabled={createLabel.isPending || !name || !description || !positive || !negative}
                  onClick={() => createLabel.mutate()}
                  className="h-9 flex-1 rounded-md bg-[var(--color-accent)] px-3 text-[13px] text-[var(--color-accent-foreground)] disabled:opacity-50"
                >
                  {createLabel.isPending ? 'Saving...' : 'Create label'}
                </button>
              </div>
              {previewItems.length ? (
                <div className="space-y-1 rounded-md border border-[var(--color-border)] p-2">
                  <div className="text-[11px] font-medium text-[var(--color-text-muted)]">
                    Preview matches
                  </div>
                  {previewItems.map((item) => (
                    <div key={`${item.account}:${item._id}`} className="text-[12px]">
                      <div className="line-clamp-1 font-medium">{item.subject || '(no subject)'}</div>
                      <div className="line-clamp-1 text-[var(--color-text-muted)]">
                        {item.fromAddress || item.from || item.snippet}
                      </div>
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
          </section>

          <div className="space-y-5">
            <section className="space-y-2">
              <h3 className="text-[13px] font-semibold">Custom labels</h3>
              <div className="space-y-2">
                {labels.map((label) => (
                  <div key={label._id} className="rounded-md border p-2">
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-[13px]">{label.name}</span>
                      <Badge variant="outline">{label.enabled ? 'enabled' : 'disabled'}</Badge>
                      <button
                        type="button"
                        onClick={() => toggleLabel.mutate({ id: label._id, enabled: !label.enabled })}
                        className="ml-auto rounded border px-2 py-1 text-[11px]"
                      >
                        {label.enabled ? 'Disable' : 'Enable'}
                      </button>
                      <button
                        type="button"
                        onClick={() => deleteLabel.mutate(label._id)}
                        className="rounded border px-2 py-1 text-[11px] text-[var(--color-danger)]"
                      >
                        Delete
                      </button>
                    </div>
                    <p className="mt-1 line-clamp-2 text-[12px] text-[var(--color-text-muted)]">
                      {label.description}
                    </p>
                  </div>
                ))}
              </div>
            </section>

            <section className="space-y-2">
              <h3 className="text-[13px] font-semibold">Recent rules</h3>
              <div className="space-y-2">
                {(rulesData?.rules || []).slice(0, 12).map((rule) => (
                  <div key={rule._id} className="flex items-center gap-2 rounded-md border p-2 text-[12px]">
                    <span className="font-medium">{rule.name}</span>
                    <span className="text-[var(--color-text-muted)]">
                      {rule.scope}: {rule.match}
                    </span>
                    <button
                      type="button"
                      onClick={() => disableRule.mutate(rule._id)}
                      className="ml-auto rounded border px-2 py-1 text-[11px]"
                    >
                      Disable
                    </button>
                  </div>
                ))}
              </div>
            </section>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
