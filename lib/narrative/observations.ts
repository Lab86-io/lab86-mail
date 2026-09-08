import { cleanNarrativeText as clean, nextNarrativeDay, safeNarrativeUrl } from './core';

export interface Observation {
  key: string;
  source: string;
  sourceTable: string;
  sourceId: string;
  sourceVersion: string;
  title: string;
  text: string;
  topics: string[];
  trust: 'observed' | 'reported';
  occurredAt: number;
  pinned: boolean;
  url?: string;
  accountId?: string;
}

export function fingerprint(value: string) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index++)
    hash = Math.imul(hash ^ value.charCodeAt(index), 16777619);
  return (hash >>> 0).toString(36);
}

/** Only source assertions are observed here. No model is allowed to upgrade activity to completion. */
export function observationsForRow(table: string, row: any): Observation[] {
  const sourceId = String(row._id);
  const base = {
    sourceTable: table,
    sourceId,
    accountId: row.accountId,
    occurredAt: row.updatedAt ?? row.createdAt,
    pinned: false,
    trust: 'observed' as const,
    url: safeNarrativeUrl(row.url || row.htmlLink),
  };
  const topic = (kind: string, id: unknown) => (id ? [`${kind}:${id}`] : []);
  const workTopics = [...topic('work', row._id), ...topic('area', row.primaryAreaId || row.areaId)];
  const make = (
    value: Partial<Observation> & { source: string; title: string; text: string },
    suffix = '',
  ): Observation => {
    const result = { ...base, topics: [], ...value, key: `${table}:${sourceId}${suffix}`, sourceVersion: '' };
    result.title = clean(result.title, 240);
    result.text = clean(result.text);
    result.sourceVersion = fingerprint(
      JSON.stringify([result.title, result.text, result.topics, result.pinned, result.url]),
    );
    return result;
  };
  if (table === 'albatrossDailyCheckins') {
    const entries: Observation[] = [];
    if (row.responseText)
      entries.push(
        make(
          {
            source: 'checkins',
            title: `Reflection · ${row.localDate}`,
            text: `Your reflection for ${row.localDate}: ${row.responseText}`,
            occurredAt: row.reflectionAnsweredAt || row.answeredAt || row.updatedAt,
            trust: 'reported',
          },
          ':reflection',
        ),
      );
    if (row.tomorrowIntentText)
      entries.push(
        make(
          {
            source: 'checkins',
            title: `Your intention for ${nextNarrativeDay(row.localDate)}`,
            text: `On ${row.localDate}, you said you wanted to do this on ${nextNarrativeDay(row.localDate)}: ${row.tomorrowIntentText}`,
            occurredAt: row.tomorrowIntentAnsweredAt || row.answeredAt || row.updatedAt,
            trust: 'reported',
            topics: (row.tomorrowWorkIds || []).map((id: string) => `work:${id}`),
          },
          ':intention',
        ),
      );
    return entries;
  }
  if (table === 'albatrossIntents') {
    const state = row.workState || row.status;
    return [
      make({
        source: 'work',
        title: row.title || row.rawText,
        text: `Outcome you requested: ${row.rawText}. Recorded Work state: ${state}.`,
        topics: workTopics,
        pinned: !['done', 'archived', 'released'].includes(state),
        trust: 'reported',
      }),
      ...(row.stepProgress || []).slice(0, 60).map((step: any) =>
        make(
          {
            source: 'work',
            title: step.title,
            text: `Recorded step completion: ${step.title}.${step.note ? ` Your note: ${step.note}` : ''} Recorded by: ${step.source}. This settles the step, not necessarily the entire outcome.`,
            topics: workTopics,
            occurredAt: step.completedAt,
            trust: step.source === 'user' ? 'reported' : 'observed',
          },
          `:step:${step.identity}`,
        ),
      ),
    ];
  }
  if (table === 'areas')
    return [
      make({
        source: 'areas',
        title: row.name,
        text: `Area: ${row.name}. ${row.description || ''} Status: ${row.status}.`,
        topics: topic('area', row._id),
        pinned: row.status === 'active',
        trust: 'reported',
      }),
    ];
  if (table === 'areaFacts')
    return ['rejected', 'superseded'].includes(row.status)
      ? []
      : [
          make({
            source: 'areas',
            title: row.key || row.kind || 'Area context',
            text: `${row.status === 'verified' ? 'Verified' : 'Candidate, not confirmed'} Area context: ${row.text || row.value || row.fact || JSON.stringify(row.valueJson || '')}`,
            topics: topic('area', row.areaId),
          }),
        ];
  if (table === 'mailCorpusThreads')
    return [
      make({
        source: `mail:${row.accountId}`,
        title: row.subject,
        text: `Email conversation: ${row.subject}. Latest sender: ${row.fromAddress}. Latest excerpt: ${row.snippet}`,
        occurredAt: row.lastDate,
        topics: [`mail:${row.accountId}:${row.providerThreadId}`, row.fromAddress].filter(Boolean),
      }),
    ];
  if (table === 'calendarEvents')
    return [
      make({
        source: `calendar:${row.accountId}`,
        title: row.title,
        text: `Calendar record: ${row.title}. Starts ${new Date(row.startAt).toISOString()}; ends ${new Date(row.endAt).toISOString()}. Status: ${row.status || 'scheduled'}. ${row.description || ''} This is a calendar record, not proof of attendance.`,
        topics: [`event:${row.accountId}:${row.providerEventId}`],
      }),
    ];
  if (table === 'mcpItems')
    return [
      make({
        source: `mcp:${row.connectionId}`,
        title: row.title,
        text: `${row.server} ${row.kind}: ${row.title}. State: ${row.state || 'unspecified'}. ${row.summary || ''}`,
        occurredAt: row.updatedAtSource || row.updatedAt,
        topics: [
          row.repository && `repo:${row.repository}`,
          row.author,
          `${row.server}:${row.externalId}`,
        ].filter(Boolean),
      }),
    ];
  if (table === 'documents')
    return row.archivedAt
      ? []
      : [
          make({
            source: 'documents',
            title: row.title,
            text: `File updated: ${row.title}. Type: ${row.kind}. Revision: ${row.currentRevision}. This is file metadata; read the source for its content.`,
            topics: [`document:${row.documentId}`],
            url: safeNarrativeUrl(row.google?.webUrl),
          }),
        ];
  if (table === 'userDocs' && row.kind === 'chatSession') {
    return (row.doc?.messages || [])
      .filter((message: any) => message.role === 'user')
      .slice(-80)
      .flatMap((message: any, index: number) => {
        const text = clean(
          typeof message.content === 'string'
            ? message.content
            : (message.parts || [])
                .filter((part: any) => part.type === 'text')
                .map((part: any) => part.text || '')
                .join(' '),
        );
        if (!text) return [];
        const date = Date.parse(message.createdAt || '');
        return [
          {
            ...make(
              {
                source: 'chat',
                title: row.doc.title || 'Conversation',
                text: `You said: ${text}`,
                topics: [
                  ...topic('work', row.doc.scope?.workId),
                  ...topic('area', row.doc.scope?.areaId),
                  `chat:${row.key}`,
                ],
                trust: 'reported',
                occurredAt: Number.isFinite(date) ? date : row.createdAt,
              },
              `:message:${message.id || fingerprint(text) || index}`,
            ),
            key: `turn:${message.id || `${row.key}:${fingerprint(text)}`}`,
          },
        ];
      });
  }
  return [];
}
