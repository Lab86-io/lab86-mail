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

function calendarInstant(value: unknown) {
  const date = new Date(Number(value));
  return Number.isFinite(date.getTime()) ? date.toISOString() : 'an unrecorded time';
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
  const people = (rows: unknown): string[] =>
    Array.isArray(rows)
      ? rows
          .slice(0, 30)
          .flatMap((person) =>
            typeof person === 'string'
              ? [clean(person, 150)]
              : [clean(person?.email, 150), clean(person?.name || person?.display_name, 150)],
          )
          .filter(Boolean)
      : [];
  const make = (
    value: Partial<Observation> & { source: string; title: string; text: string },
    suffix = '',
  ): Observation => {
    const result = { ...base, topics: [], ...value, key: `${table}:${sourceId}${suffix}`, sourceVersion: '' };
    result.title = clean(result.title, 240);
    result.text = clean(result.text);
    result.topics = [...new Set(result.topics)].slice(0, 40);
    result.sourceVersion = fingerprint(
      JSON.stringify([result.title, result.text, result.topics, result.pinned, result.url]),
    );
    return result;
  };
  if (table === 'aiOperations') {
    const target = row.target || {};
    const source =
      target.kind === 'document'
        ? 'documents'
        : ['mail', 'calendar'].includes(row.surface) && target.accountId
          ? `${row.surface}:${target.accountId}`
          : ['tasks', 'albatross'].includes(row.surface)
            ? 'work'
            : null;
    if (!source || !['applied', 'undoing', 'undone', 'undo_failed'].includes(row.status)) return [];
    const state =
      row.status === 'undone'
        ? 'The recorded action was undone.'
        : row.status === 'undoing'
          ? 'Undo is in progress; reversal is not yet confirmed.'
          : row.status === 'undo_failed'
            ? 'An undo attempt failed; current external state may need verification.'
            : 'The server recorded the action as applied.';
    return [
      make({
        source,
        accountId: target.accountId,
        title: `Action receipt · ${row.tool}`,
        text: `${state} Tool: ${row.tool}. Recorded description (reference data): ${row.summary}. A saved draft is not sent mail; creating a task is not completing it; a calendar mutation is not attendance. This receipt confirms the tool operation, not the entire Work outcome.`,
        topics: [
          ...topic('operation', row._id),
          ...topic('work', target.workId || (target.kind === 'albatrossIntent' ? target.id : undefined)),
          ...topic('area', target.areaId),
          ...topic('document', target.kind === 'document' ? target.id : undefined),
          ...(target.threadId && target.accountId ? [`mail:${target.accountId}:${target.threadId}`] : []),
          ...(target.kind === 'calendarEvent' && target.accountId
            ? [`event:${target.accountId}:${target.id}`]
            : []),
        ],
        occurredAt: row.undoneAt || row.updatedAt || row.createdAt,
      }),
    ];
  }
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
    const questionIds = new Set<string>();
    return [
      make({
        source: 'work',
        title: row.title || row.rawText,
        text: `Outcome you requested: ${row.rawText}. Recorded Work state: ${state}.`,
        topics: workTopics,
        pinned: !['done', 'archived', 'released'].includes(state),
        trust: 'reported',
      }),
      ...(row.questions || [])
        .filter((question: any) => question.id && question.answer)
        .filter((question: any) => {
          const id = String(question.id);
          if (questionIds.has(id)) return false;
          questionIds.add(id);
          return true;
        })
        .slice(0, 24)
        .map((question: any) =>
          make(
            {
              source: 'work',
              title: `Your decision · ${row.title || row.rawText}`,
              text: `Planning question (reference data): ${question.prompt}. Your answer: ${question.answer}. This records your stated choice, not completion of an action.`,
              topics: workTopics,
              trust: 'reported',
              occurredAt: question.answeredAt || row.updatedAt || row.createdAt,
            },
            `:answer:${question.id}`,
          ),
        ),
      ...(row.pendingPlanId || row.latestPlanId
        ? [
            make(
              {
                source: 'work',
                title: `Plan prepared · ${row.title || row.rawText}`,
                text: `Albatross saved a proposed plan for the requested outcome: ${row.rawText}. Plan record: ${row.pendingPlanId || row.latestPlanId}. Generated steps are proposals, not proof that anything was done or that you accepted the plan.`,
                topics: workTopics,
              },
              ':plan',
            ),
          ]
        : []),
      ...(row.stepProgress || []).slice(0, 60).map((step: any) =>
        make(
          {
            source: 'work',
            title: step.title,
            text: `Recorded step completion: ${step.title}.${step.note ? ` Your note: ${step.note}` : ''} Recorded by: ${step.source}. This settles the step, not necessarily the entire outcome.`,
            topics: workTopics,
            occurredAt: step.completedAt,
            // The ledger permits user-entered source labels; only an operation
            // receipt independently verifies an applied external action.
            trust: 'reported',
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
        text: `Calendar record: ${row.title}. Starts ${calendarInstant(row.startAt)}; ends ${calendarInstant(row.endAt)}. Status: ${row.status || 'scheduled'}. ${row.description || ''} This is a calendar record, not proof of attendance.`,
        topics: [
          `event:${row.accountId}:${row.providerEventId}`,
          ...people(row.participants),
          ...people(row.organizer ? [row.organizer] : []),
        ],
      }),
    ];
  if (table === 'mcpItems')
    return [
      make({
        source: `mcp:${row.connectionId}`,
        title: row.title,
        text: `${row.server} ${row.kind}: ${row.title}. State: ${row.state || 'unspecified'}. ${people(row.raw?.attendees).length ? `Participants: ${people(row.raw?.attendees).join(', ')}. ` : ''}${row.summary || ''}`,
        occurredAt: row.updatedAtSource || row.updatedAt,
        topics: [
          row.repository && `repo:${row.repository}`,
          row.author,
          `${row.server}:${row.externalId}`,
          ...people(row.raw?.attendees),
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
