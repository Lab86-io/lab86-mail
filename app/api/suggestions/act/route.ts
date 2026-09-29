import { NextRequest, NextResponse } from 'next/server';
import { describeModelError } from '@/lib/ai/log-error';
import { AttachmentTooLargeError, readMailAttachmentBytes } from '@/lib/attachments/mail-files';
import { AuthRequiredError, requireCurrentUser } from '@/lib/auth/current-user';
import { parseIcsEvents } from '@/lib/calendar/ics';
import { createCalendarEvent } from '@/lib/calendar/mutate';
import { api, convexMutation, convexQuery } from '@/lib/hosted/convex';
import { isUsableTimezone } from '@/lib/mail/brief-timezone';
import { enforceUserRateLimit, RateLimitError, rateLimitJson } from '@/lib/rate-limit';
import { truncateText } from '@/lib/shared/text';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** An ICS invitation is small. The route reads no larger file into memory. */
export const ICS_MAX_BYTES = 1024 * 1024;

const suggestionsApi = api.suggestions;
const accountsApi = api.accounts;

interface SuggestionActDependencies {
  requireCurrentUser: typeof requireCurrentUser;
  enforceUserRateLimit: typeof enforceUserRateLimit;
  convexMutation: typeof convexMutation;
  convexQuery: typeof convexQuery;
  readMailAttachmentBytes: typeof readMailAttachmentBytes;
  createCalendarEvent: typeof createCalendarEvent;
  reportUnexpectedError: (error: unknown) => void;
}

const defaultDependencies: SuggestionActDependencies = {
  requireCurrentUser,
  enforceUserRateLimit,
  convexMutation,
  convexQuery,
  readMailAttachmentBytes,
  createCalendarEvent,
  reportUnexpectedError: (error) => console.error('[suggestions] act failed:', describeModelError(error)),
};

interface SafeSuggestedEvent {
  title: string;
  startAt: number;
  endAt: number;
  allDay: boolean;
  description?: string;
  location?: string;
  timezone?: string;
}

export function safeSuggestedEvent(
  event: Record<string, unknown> | null | undefined,
): SafeSuggestedEvent | null {
  if (!event) return null;
  const title = String(event.title || '').trim();
  const startAt = Number(event.startAt);
  const endAt = Number(event.endAt);
  if (
    !title ||
    !Number.isFinite(startAt) ||
    !Number.isFinite(endAt) ||
    endAt <= startAt ||
    endAt - startAt > 31 * 86_400_000
  ) {
    return null;
  }
  const description = String(event.description || '').trim();
  const location = String(event.location || '').trim();
  return {
    title: truncateText(title, 300),
    startAt,
    endAt,
    allDay: event.allDay === true,
    description: truncateText(description, 10_000) || undefined,
    location: location.slice(0, 500) || undefined,
    ...(typeof event.timezone === 'string' && event.timezone ? { timezone: event.timezone } : {}),
  };
}

// Acting on a tray suggestion. Accepting an event suggestion downloads the
// ICS from the source email, parses it, and creates the event through the
// normal undoable mutation path; nothing happens until this endpoint runs.
export function createSuggestionActPost(deps: SuggestionActDependencies = defaultDependencies) {
  return async function suggestionActPost(req: NextRequest) {
    try {
      const user = await deps.requireCurrentUser();
      await deps.enforceUserRateLimit({
        userId: user.userId,
        key: 'suggestion_act',
        limit: 60,
        windowMs: 10 * 60_000,
      });
      const body = await req.json().catch(() => ({}));
      // The web and native clients send the device zone. A write without a zone
      // lands in UTC, and a series then moves by an hour at DST.
      const headerTimezone = req.headers.get('x-user-timezone') || undefined;
      const userTimezone = isUsableTimezone(headerTimezone) ? headerTimezone : undefined;
      const suggestionId = String(body.suggestionId || '');
      const action = body.action === 'accept' ? 'accept' : body.action === 'dismiss' ? 'dismiss' : null;
      if (!suggestionId || !action) {
        return NextResponse.json({ ok: false, error: 'suggestionId and action required' }, { status: 400 });
      }

      if (action === 'dismiss') {
        await deps.convexMutation(suggestionsApi.resolve, {
          userId: user.userId,
          suggestionId,
          status: 'dismissed',
        });
        return NextResponse.json({ ok: true });
      }

      const suggestion = await deps.convexQuery<any>(suggestionsApi.get, {
        userId: user.userId,
        suggestionId,
      });
      if (!suggestion || suggestion.status !== 'pending') {
        return NextResponse.json({ ok: false, error: 'Suggestion is no longer pending.' }, { status: 409 });
      }

      if (suggestion.kind === 'event') {
        const { accountId, messageId, attachmentId, event } = suggestion.payload || {};
        const account = await deps.convexQuery<any>(accountsApi.getConnectedAccount, {
          userId: user.userId,
          accountId,
        });
        if (!account || account.status !== 'connected') {
          return NextResponse.json({ ok: false, error: 'Source account is not connected.' }, { status: 409 });
        }
        let eventInput: SafeSuggestedEvent | null = null;
        if (attachmentId && messageId) {
          // Our encrypted storage first; else the provider, and the file is stored.
          const file = await deps.readMailAttachmentBytes(
            { userId: user.userId, account: accountId, messageId, attachmentId },
            { fill: 'always', maxBytes: ICS_MAX_BYTES },
          );
          const ics = file ? new TextDecoder().decode(file.bytes) : '';
          const [parsed] = parseIcsEvents(ics, { timezone: userTimezone });
          eventInput = safeSuggestedEvent(parsed as unknown as Record<string, unknown>);
        } else if (event) {
          eventInput = safeSuggestedEvent({
            ...event,
            description: `Created from email by Albatross. ${String(event.reason || '').trim()}`.trim(),
          });
        }
        if (!eventInput) {
          return NextResponse.json(
            { ok: false, error: 'Could not read a safe event from this email.' },
            { status: 422 },
          );
        }
        const created = await deps.createCalendarEvent({
          userId: user.userId,
          accountId,
          title: eventInput.title,
          startAt: eventInput.startAt,
          endAt: eventInput.endAt,
          allDay: eventInput.allDay,
          description: eventInput.description,
          location: eventInput.location,
          timezone: eventInput.timezone || userTimezone,
          notifyParticipants: false,
        });
        await deps.convexMutation(suggestionsApi.resolve, {
          userId: user.userId,
          suggestionId,
          status: 'accepted',
        });
        return NextResponse.json({ ok: true, eventId: created.eventId, title: eventInput.title });
      }

      return NextResponse.json({ ok: false, error: `Unsupported kind: ${suggestion.kind}` }, { status: 400 });
    } catch (err) {
      if (err instanceof RateLimitError) return rateLimitJson(err);
      if (err instanceof AuthRequiredError) {
        return NextResponse.json({ ok: false, error: err.message }, { status: 401 });
      }
      if (err instanceof AttachmentTooLargeError) {
        return NextResponse.json({ ok: false, error: 'The calendar file is too large.' }, { status: 422 });
      }
      deps.reportUnexpectedError(err);
      return NextResponse.json({ ok: false, error: 'Action failed.' }, { status: 500 });
    }
  };
}

export const POST = createSuggestionActPost();
