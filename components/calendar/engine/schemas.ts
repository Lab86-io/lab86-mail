import { z } from 'zod/v4';

export const eventSchema = z.object({
  title: z.string().min(1, 'Title is required'),
  description: z.string(),
  startDate: z.date('Start date is required'),
  endDate: z.date('End date is required'),
  // The owning calendar (account) decides the color; '' = default calendar.
  calendarId: z.string(),
  repeat: z.enum(['none', 'daily', 'weekly', 'monthly']),
  // Comma-separated invitee emails; invitations send on create.
  attendees: z.string(),
});

export type TEventFormData = z.infer<typeof eventSchema>;
