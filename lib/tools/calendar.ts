import { z } from 'zod';
import { defineTool } from './registry';

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
  async handler() {
    return { busy: [] };
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
  async handler() {
    return { suggestions: [] };
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
  async handler() {
    throw new Error('Calendar creation is not wired to Nylas yet.');
  },
});
