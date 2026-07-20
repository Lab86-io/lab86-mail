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

// Acting on a tray suggestion. Accepting an event suggestion downloads the
// ICS from the source email, parses it, and creates the event through the
// normal undoable mutation path; nothing happens until this endpoint runs.
export async function POST(req: NextRequest) {
  try {
    const user = await requireCurrentUser();
    await enforceUserRateLimit({
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
      await convexMutation(suggestionsApi.resolve, {
        userId: user.userId,
        suggestionId,
        status: 'dismissed',
      });
      return NextResponse.json({ ok: true });
    }

    const suggestion = await convexQuery<any>(suggestionsApi.get, { userId: user.userId, suggestionId });
    if (!suggestion || suggestion.status !== 'pending') {
      return NextResponse.json({ ok: false, error: 'Suggestion is no longer pending.' }, { status: 409 });
    }

    if (suggestion.kind === 'event') {
      const { accountId, messageId, attachmentId, event } = suggestion.payload || {};
      const account = await convexQuery<any>(accountsApi.getConnectedAccount, {
        userId: user.userId,
        accountId,
      });
      if (!account || account.status !== 'connected') {
        return NextResponse.json({ ok: false, error: 'Source account is not connected.' }, { status: 409 });
      }
      let eventInput: {
        title: string;
        startAt: number;
        endAt: number;
        allDay: boolean;
        description?: string;
        location?: string;
      } | null = null;
      if (attachmentId && messageId) {
        const stream = await requireNylas().attachments.download({
          identifier: account.grantId,
          attachmentId,
          queryParams: { messageId } as any,
        });
        const ics = await new Response(stream as any).text();
        const [parsed] = parseIcsEvents(ics);
        if (parsed) eventInput = parsed;
      } else if (event) {
        const startAt = Number(event.startAt);
        const endAt = Number(event.endAt);
        if (
          String(event.title || '').trim() &&
          Number.isFinite(startAt) &&
          Number.isFinite(endAt) &&
          endAt > startAt &&
          endAt - startAt <= 31 * 86_400_000
        ) {
          eventInput = {
            title: String(event.title).trim().slice(0, 300),
            startAt,
            endAt,
            allDay: event.allDay === true,
            description: `Created from email by Albatross. ${String(event.reason || '').trim()}`.trim(),
            location: String(event.location || '').trim() || undefined,
          };
        }
      }
      if (!eventInput) {
        return NextResponse.json(
          { ok: false, error: 'Could not read a safe event from this email.' },
          { status: 422 },
        );
      }
      const created = await createCalendarEvent({
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
      await convexMutation(suggestionsApi.resolve, {
        userId: user.userId,
        suggestionId,
        status: 'accepted',
      });
      return NextResponse.json({ ok: true, eventId: created.eventId, title: eventInput.title });
    }

    return NextResponse.json({ ok: false, error: `Unsupported kind: ${suggestion.kind}` }, { status: 400 });
  } catch (err: any) {
    if (err instanceof RateLimitError) return rateLimitJson(err);
    if (err instanceof AuthRequiredError) {
      return NextResponse.json({ ok: false, error: err.message }, { status: 401 });
    }
    console.error('[suggestions] act failed:', err?.message || err);
    return NextResponse.json({ ok: false, error: err?.message || 'Action failed.' }, { status: 500 });
  }
}
