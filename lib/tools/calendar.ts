import { z } from 'zod';
import { defineTool } from './registry';
import { runGogJson } from '../gog/pool';

export const calendarFreeBusy = defineTool({
  name: 'calendar_free_busy',
  description: 'Query free/busy windows for an account between two ISO timestamps.',
  category: 'calendar',
  mutating: false,
  input: z.object({
    account: z.string(),
    fromIso: z.string(),
    toIso: z.string(),
  }),
  output: z.object({ busy: z.array(z.any()) }),
  async handler({ account, fromIso, toIso }) {
    const raw = await runGogJson<any>([
      '--account', account, '--json', 'calendar', 'freebusy',
      '--from', fromIso, '--to', toIso, '--no-input',
    ]).catch(() => null);
    return { busy: raw?.busy || raw?.calendars || [] };
  },
});

export const calendarSuggestTimes = defineTool({
  name: 'calendar_suggest_times',
  description: 'Suggest meeting times within a date window given a duration.',
  category: 'calendar',
  mutating: false,
  input: z.object({
    account: z.string(),
    fromIso: z.string(),
    toIso: z.string(),
    durationMinutes: z.number().int().min(15).max(480).default(30),
    count: z.number().int().min(1).max(10).default(3),
  }),
  output: z.object({ suggestions: z.array(z.object({ startIso: z.string(), endIso: z.string() })) }),
  async handler({ account, fromIso, toIso, durationMinutes, count }) {
    const raw = await runGogJson<any>([
      '--account', account, '--json', 'calendar', 'suggest',
      '--from', fromIso, '--to', toIso,
      '--duration', String(durationMinutes),
      '--count', String(count),
      '--no-input',
    ]).catch(() => null);
    return {
      suggestions: (raw?.suggestions || raw?.slots || []).map((s: any) => ({
        startIso: s.startIso || s.start || s.start_time,
        endIso: s.endIso || s.end || s.end_time,
      })),
    };
  },
});

export const calendarCreateEvent = defineTool({
  name: 'calendar_create_event',
  description: 'Create a calendar event with optional video conferencing.',
  category: 'calendar',
  mutating: true,
  input: z.object({
    account: z.string(),
    title: z.string(),
    startIso: z.string(),
    endIso: z.string(),
    attendees: z.array(z.string()).default([]),
    description: z.string().optional(),
    withMeet: z.boolean().default(false),
  }),
  output: z.object({ ok: z.boolean(), eventId: z.string().optional(), htmlLink: z.string().optional() }),
  async handler({ account, title, startIso, endIso, attendees, description, withMeet }) {
    const args = [
      '--account', account, '--json', 'calendar', 'events', 'create',
      '--title', title, '--start', startIso, '--end', endIso, '--no-input',
    ];
    if (description) args.push('--description', description);
    for (const a of attendees) args.push('--attendee', a);
    if (withMeet) args.push('--with-meet');
    const raw = await runGogJson<any>(args, { timeoutMs: 60_000 }).catch(() => null);
    return { ok: !!raw, eventId: raw?.id, htmlLink: raw?.htmlLink };
  },
});
