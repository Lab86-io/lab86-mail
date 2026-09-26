'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { settingsRequest } from '@/components/settings/JevSection';
import { classifierForServedModel } from '@/lib/classifier/catalog';
import { type JevAssessment, jevReason } from '@/lib/jev/contract';

export function JevMailDetails({ assessment }: { assessment?: JevAssessment | null }) {
  const settings = useQuery({
    queryKey: ['jev-settings'],
    queryFn: () => settingsRequest(),
    staleTime: 60_000,
    enabled: Boolean(assessment),
  });
  if (!assessment || settings.data?.preferences.showExplanations === false) return null;
  const evidence = [
    ...assessment.obligations.map((item) => ({ kind: item.kind, ...item.evidence })),
    ...(assessment.changeEvidence ? [{ kind: 'change', ...assessment.changeEvidence }] : []),
  ];
  return (
    <details className="mb-4 rounded-[var(--radius-control)] border border-[var(--color-border)] bg-[var(--color-bg-subtle)] px-3 py-2 text-xs">
      <summary className="cursor-pointer leading-relaxed text-[var(--color-text-muted)]">
        {jevReason(assessment)}
      </summary>
      <div className="mt-3 space-y-3">
        <p className="text-[var(--color-text-muted)]">
          {classifierForServedModel(assessment.model)?.label || assessment.model} · {assessment.purpose} ·{' '}
          {assessment.status === 'uncertain' ? 'More context may be needed' : 'Classified'}
        </p>
        {evidence.map((item) => (
          <blockquote
            key={`${item.kind}:${item.messageId}`}
            className="border-l-2 border-[var(--color-border)] pl-3"
          >
            <p className="mb-1 font-medium">
              {item.kind === 'reply'
                ? 'Reply request'
                : item.kind === 'action'
                  ? 'Required action'
                  : item.kind === 'waiting'
                    ? 'Expected response or work'
                    : 'Meaningful change'}
            </p>
            <p className="whitespace-pre-wrap text-[var(--color-text-muted)]">{item.text}</p>
          </blockquote>
        ))}
        <Link href="/settings?tab=jev" className="inline-block underline">
          Classification settings and Brief corrections
        </Link>
      </div>
    </details>
  );
}
