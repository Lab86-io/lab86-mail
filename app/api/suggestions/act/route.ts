import { NextRequest, NextResponse } from 'next/server';
import { AuthRequiredError, requireCurrentUser } from '@/lib/auth/current-user';
import { parseIcsEvents } from '@/lib/calendar/ics';
import { createCalendarEvent } from '@/lib/calendar/mutate';
import { api, convexMutation, convexQuery } from '@/lib/hosted/convex';
import { requireNylas } from '@/lib/nylas/client';
import { enforceUserRateLimit, RateLimitError, rateLimitJson } from '@/lib/rate-limit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const suggestionsApi = (api as any).suggestions;
const accountsApi = (api as any).accounts;

interface SuggestionActDependencies {
  requireCurrentUser: typeof requireCurrentUser;
  enforceUserRateLimit: typeof enforceUserRateLimit;
  convexMutation: typeof convexMutation;
  convexQuery: typeof convexQuery;
  requireNylas: typeof requireNylas;
  createCalendarEvent: typeof createCalendarEvent;
  reportUnexpectedError: (error: unknown) => void;
}

const defaultDependencies: SuggestionActDependencies = {
  requireCurrentUser,
  enforceUserRateLimit,
  convexMutation,
  convexQuery,
  requireNylas,
  createCalendarEvent,
  reportUnexpectedError: (error) => console.error('[suggestions] act failed:', error),
};

interface SafeSuggestedEvent {
  title: string;
  startAt: number;
  endAt: number;
  allDay: boolean;
  description?: string;
  location?: string;
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
    title: title.slice(0, 300),
    startAt,
    endAt,
    allDay: event.allDay === true,
    description: description.slice(0, 10_000) || undefined,
    location: location.slice(0, 500) || undefined,
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
          const stream = await deps.requireNylas().attachments.download({
            identifier: account.grantId,
            attachmentId,
            queryParams: { messageId } as any,
          });
          const ics = await new Response(stream as any).text();
          const [parsed] = parseIcsEvents(ics);
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
      deps.reportUnexpectedError(err);
      return NextResponse.json({ ok: false, error: 'Action failed.' }, { status: 500 });
    }
  };
}

export const POST = createSuggestionActPost();
