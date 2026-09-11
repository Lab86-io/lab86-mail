/** Fictional local review data. Never written to an account or backend. */
import type { NarrativeWorkspace } from '../../lib/narrative/workspace';
import { letterBriefDocumentFixture } from '../../lib/shared/brief-document-fixtures';

export const previewNow = Date.now();
const todayAt = (hour: number) => {
  const date = new Date(previewNow);
  date.setHours(hour, 0, 0, 0);
  return date.getTime();
};
export const previewNarrative = {
  enabled: true,
  entry: {
    _id: 'preview-brief',
    updatedAt: previewNow,
    model: 'fictional-preview',
    sourceIds: ['studio', 'maya', 'weekend'],
    text: 'Give the studio proposal your first clear hour. Everything else today can fit around it.\n\nMaya has sent the revised schedule for the North House launch. The direction looks settled; the open question is whether photography can finish before the copy review on Friday. A short reply confirming the sequence would let the team book the shoot.\n\nYou have a planning conversation at 10 and a design review at 2. There is a useful stretch between them for the proposal, followed by a quieter afternoon. The sample calendar below leaves that space open rather than filling it with suggested tasks.\n\nAway from work, the cabin booking is confirmed and the train tickets are in your inbox. Nothing needs attention there today. Keep Friday afternoon light if you want to leave early.',
  },
};
export const previewReport = {
  _id: 'fictional-daily-brief',
  kind: 'morning',
  generatedAt: previewNow,
  title: 'A little room to move · Fictional preview',
  narrative: previewNarrative.entry.text,
  sections: {},
  stats: { scannedThreads: 40, trackedThreads: 3, needsReply: 2, dueSoon: 1, noise: 12 },
  status: 'ready',
  artifactStatus: 'ready',
  artifactSource: 'document-v2',
  document: {
    ...letterBriefDocumentFixture,
    title: 'A little room to move · Fictional preview',
    timezone: 'America/New_York',
    generatedAt: previewNow,
    regions: letterBriefDocumentFixture.regions
      .filter((region) => ['lede', 'week-ahead'].includes(region.id))
      .map((region) =>
        region.id === 'week-ahead'
          ? {
              ...region,
              summary: 'Friday has one review, then the weekend is yours.',
              tree: {
                kind: 'text',
                emphasis: 'standard',
                tone: 'neutral',
                role: 'body',
                text: 'Friday: copy review at 11, then an open afternoon. Your cabin booking is confirmed for the weekend. This entire edition is fictional data for local design review.',
              },
            }
          : region,
      ),
  },
};
export const previewWorkspace: NarrativeWorkspace = {
  enabled: true,
  stamp: 'f'.repeat(64),
  mode: 'generated',
  threads: [
    {
      id: 'studio',
      title: 'Make room for the studio proposal',
      summary: 'Maya’s revised schedule is ready. The photography date is the remaining decision.',
      nextStep: 'Review the schedule and reply to Maya.',
      sources: [
        {
          id: 'maya',
          title: 'North House · revised schedule',
          excerpt: 'Can we finish photography before Friday’s review?',
          kind: 'mail',
          occurredAt: previewNow - 3600000,
          trust: 'observed',
          href: '/narrative?id=maya',
        },
      ],
    },
    {
      id: 'weekend',
      title: 'The weekend is already arranged',
      summary: 'Cabin and train are confirmed. There is nothing else to book today.',
      nextStep: 'Leave Friday afternoon open.',
      sources: [
        {
          id: 'cabin',
          title: 'Cabin booking confirmed',
          excerpt: 'Your two-night stay is confirmed.',
          kind: 'mail',
          occurredAt: previewNow - 86400000,
          trust: 'observed',
          href: '/narrative?id=cabin',
        },
      ],
    },
  ],
};
export const previewWeather = {
  asOf: previewNow,
  weather: {
    location: 'Rochester, NY · Sample',
    timezone: 'America/New_York',
    unit: '°F',
    current: { temp: 71, condition: 'Partly cloudy', conditionCode: 'partly-cloudy', high: 75, low: 56 },
    daily: [
      { day: 'Today', condition: 'partly-cloudy', high: 75, low: 56, precipChance: 15 },
      { day: 'Fri', condition: 'clear', high: 77, low: 57, precipChance: 5 },
      { day: 'Sat', condition: 'rain', high: 68, low: 55, precipChance: 65 },
    ],
    source: 'Sample forecast',
  },
};
const calendar = {
  _id: 'preview-calendar',
  providerCalendarId: 'preview-calendar',
  accountId: 'fixture',
  name: 'Studio calendar',
  isPrimary: true,
  readOnly: false,
  hidden: false,
};
export const previewQueryResults: Record<string, unknown> = {
  'calendarData:liveCalendars': {
    calendars: [calendar],
    syncStates: [
      { accountId: 'fixture', status: 'idle', lastSyncedAt: previewNow - 60_000, updatedAt: previewNow },
    ],
  },
  'calendarData:liveEvents': [
    {
      providerEventId: 'planning',
      providerCalendarId: calendar.providerCalendarId,
      accountId: 'fixture',
      title: 'North House planning',
      startAt: todayAt(10),
      endAt: todayAt(11),
      allDay: false,
      readOnly: true,
    },
    {
      providerEventId: 'review',
      providerCalendarId: calendar.providerCalendarId,
      accountId: 'fixture',
      title: 'Studio design review',
      startAt: todayAt(14),
      endAt: todayAt(15),
      allDay: false,
      readOnly: true,
    },
  ],
  'boards:listDueCards': [],
};

import type { CloudFileItem } from '../../lib/files/providers';

export const previewFiles: (CloudFileItem & { documentId: string; documentKind: 'doc' })[] = [
  'North House proposal',
  'Planning conversation',
  'Cabin weekend',
].map((name, index) => ({
  id: `preview-file-${index}`,
  documentId: `preview-document-${index}`,
  documentKind: 'doc',
  name,
  provider: 'albatross',
  isFolder: false,
  mimeType: 'text/plain',
  modifiedAt: Date.now() - index * 86_400_000,
  owner: 'Local preview',
}));
