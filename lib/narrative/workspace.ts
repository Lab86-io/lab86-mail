import { z } from 'zod';
import { WORK_SHAPES, type WorkShape } from '@/lib/albatross/work-shape';
import { safeExternalUrl } from '@/lib/shared/url';
import { cleanNarrativeText, type NarrativeEntry } from './core';

// The model chooses content, never executable UI, URLs, entity IDs, or tools.
export const workspaceCompositionSchema = z
  .object({
    threads: z
      .array(
        z
          .object({
            title: z.string().trim().min(1).max(100),
            summary: z.string().trim().min(1).max(360),
            sourceIds: z
              .array(z.string().regex(/^E\d+$/))
              .min(1)
              .max(4),
            nextStep: z.string().trim().min(1).max(200),
          })
          .strict(),
      )
      .min(1)
      .max(3),
  })
  .strict();
export type WorkspaceComposition = z.infer<typeof workspaceCompositionSchema>;
export interface WorkspaceWork {
  shape?: WorkShape;
  id: string;
  title: string;
  state: string;
  guided: boolean;
  nextStep?: string;
}
export interface WorkspaceSource {
  id: string;
  title: string;
  excerpt: string;
  kind: 'meeting' | 'development' | 'mail' | 'conversation' | 'work' | 'intention' | 'file' | 'context';
  occurredAt: number;
  trust: NarrativeEntry['trust'];
  href: string;
  originalUrl?: string;
}
export interface WorkspaceThread {
  id: string;
  title: string;
  summary: string;
  nextStep: string;
  sources: WorkspaceSource[];
  work?: WorkspaceWork;
}
export interface NarrativeWorkspace {
  enabled: boolean;
  stamp: string;
  mode: 'generated' | 'evidence' | 'empty';
  threads: WorkspaceThread[];
}
// Validate successful HTTP payloads too: a proxy's 200/{} is not a workspace.
export const workspaceResponseSchema = z.object({
  enabled: z.boolean(),
  stamp: z.string(),
  mode: z.enum(['generated', 'evidence', 'empty']),
  threads: z
    .array(
      z.object({
        id: z.string().min(1),
        title: z.string(),
        summary: z.string(),
        nextStep: z.string(),
        sources: z
          .array(
            z.object({
              id: z.string().min(1),
              title: z.string(),
              excerpt: z.string(),
              kind: z.enum([
                'meeting',
                'development',
                'mail',
                'conversation',
                'work',
                'intention',
                'file',
                'context',
              ]),
              occurredAt: z.number().finite(),
              trust: z.enum(['observed', 'reported', 'inferred']),
              href: z.string().startsWith('/narrative?id='),
              originalUrl: z
                .string()
                .refine((value) => !!safeExternalUrl(value))
                .optional(),
            }),
          )
          .min(1)
          .max(4),
        work: z
          .object({
            id: z.string().min(1),
            title: z.string(),
            state: z.string(),
            guided: z.boolean(),
            shape: z.enum(WORK_SHAPES).optional(),
            nextStep: z.string().optional(),
          })
          .optional(),
      }),
    )
    .max(3),
});
/** The connected tool of an `mcp:<connectionId>` source: connection ids start with the server. */
function connectedServer(source: string): string {
  return source.startsWith('mcp:') ? (source.slice(4).split(/[_:]/u)[0] ?? '') : '';
}

function workspaceKind(entry: NarrativeEntry, hint: string): WorkspaceSource['kind'] {
  if (entry.source === 'work') return 'work';
  if (entry.source === 'checkins') return 'intention';
  // A connected item takes its kind from its tool, not from words in its title.
  switch (connectedServer(entry.source)) {
    case 'granola':
      return 'meeting';
    case 'github':
    case 'bitbucket':
      return 'development';
    case 'jira':
      // An Atlassian sign-in holds Jira issues and Confluence pages.
      return /\/wiki\//u.test(entry.url || '') ? 'file' : 'development';
    case 'slack':
      return 'conversation';
  }
  if (/granola|calendar:/.test(hint)) return 'meeting';
  if (/github|bitbucket/.test(hint)) return 'development';
  if (entry.source.startsWith('mail:')) return 'mail';
  if (entry.source === 'documents' || entry.source.startsWith('files:')) return 'file';
  return 'context';
}

export function workspaceSource(entry: NarrativeEntry): WorkspaceSource {
  const hint = `${entry.source} ${entry.title} ${entry.url || ''}`.toLowerCase();
  const kind = workspaceKind(entry, hint);
  return {
    id: entry._id,
    title: cleanNarrativeText(entry.title, 160),
    excerpt: cleanNarrativeText(entry.text, 240),
    kind,
    occurredAt: entry.occurredAt,
    trust: entry.trust,
    href: `/narrative?id=${encodeURIComponent(entry._id)}`,
    originalUrl: safeExternalUrl(entry.url || '') || undefined,
  };
}

export function workspaceCandidates(sources: NarrativeEntry[], brief: string, now = Date.now()) {
  const words = new Set(brief.toLowerCase().match(/[\p{L}\p{N}]{4,}/gu) || []);
  const score = (entry: NarrativeEntry) => {
    const matches = new Set(entry.title.toLowerCase().match(/[\p{L}\p{N}]{4,}/gu) || []);
    const relevance = [...matches].filter((word) => words.has(word)).length;
    return relevance * 3 + (entry.occurredAt >= now - 3 * 86_400_000 ? 5 : 0);
  };
  const sorted = sources
    .filter((e) => e.current && e.level === 'observation')
    .sort((a, b) => score(b) - score(a) || b.occurredAt - a.occurredAt);
  // Reserve a head from each source category before filling by relevance.
  const selected = new Map<string, NarrativeEntry>();
  const kinds = new Set<string>();
  for (const entry of sorted) {
    const kind = workspaceSource(entry).kind;
    if (!kinds.has(kind)) {
      selected.set(entry._id, entry);
      kinds.add(kind);
    }
  }
  for (const entry of sorted) {
    if (selected.size >= 10) break;
    selected.set(entry._id, entry);
  }
  return [...selected.values()];
}

export function evidenceComposition(entries: NarrativeEntry[]): WorkspaceComposition {
  const selected: WorkspaceComposition['threads'] = [];
  const used = new Set<string>();
  for (let index = 0; index < entries.length && selected.length < 3; index++) {
    const entry = entries[index];
    const group = entry.topics.find((t) => t.startsWith('work:')) || entry._id;
    if (used.has(group)) continue;
    used.add(group);
    selected.push({
      title: cleanNarrativeText(entry.title, 100),
      summary: cleanNarrativeText(entry.text, 360),
      sourceIds: [`E${index + 1}`],
      nextStep: 'Review the source and decide what needs your attention.',
    });
  }
  return { threads: selected };
}

export function hydrateWorkspace(
  composition: WorkspaceComposition,
  entries: NarrativeEntry[],
  works: WorkspaceWork[],
  stamp: string,
  mode: NarrativeWorkspace['mode'],
): NarrativeWorkspace {
  const aliases = new Map(entries.map((entry, index) => [`E${index + 1}`, entry]));
  const used = new Set<string>();
  const threads = composition.threads.map((thread) => {
    const sources = [...new Set(thread.sourceIds)].map((id) => {
      const entry = aliases.get(id);
      if (!entry) throw new Error('Unknown workspace evidence');
      return entry;
    });
    const id = sources[0]._id;
    if (used.has(id)) throw new Error('Duplicate workspace thread');
    used.add(id);
    // Work identity comes only from an owned live Work record, never AI output.
    const matchingWorks = works.filter((w) => sources.some((e) => e.topics.includes(`work:${w.id}`)));
    const work =
      matchingWorks.find((w) => !['done', 'released', 'archived'].includes(w.state)) || matchingWorks[0];
    return {
      id,
      title: cleanNarrativeText(thread.title, 100),
      summary: cleanNarrativeText(thread.summary, 360),
      nextStep: cleanNarrativeText(thread.nextStep, 200),
      sources: sources.map(workspaceSource),
      work,
    };
  });
  const active = threads.filter(
    (thread) => !thread.work || !['done', 'released', 'archived'].includes(thread.work.state),
  );
  return { enabled: true, stamp, mode: active.length ? mode : 'empty', threads: active };
}
