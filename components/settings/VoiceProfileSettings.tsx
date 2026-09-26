'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import {
  MailSettingsCard,
  MailSettingsGroupTitle,
  MailSettingsNote,
  MailSettingsRow,
} from '@/components/settings/mail-settings-ui';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { callTool } from '@/lib/api-client';
import type { VoiceLength, VoiceProfile } from '@/lib/mail/voice-profile';

type VoiceState = { profile: VoiceProfile | null; nextLearnAt: number | null };
type LearnResult = {
  status: 'learned' | 'too_soon' | 'edited' | 'not_enough_mail';
  profile: VoiceProfile | null;
  nextLearnAt?: number;
  sampleCount?: number;
};

export const VOICE_QUERY_KEY = ['voice-profile'] as const;

function dayLabel(ms: number) {
  return new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

/** The line under the heading: where the card came from. */
export function voiceSourceLine(profile: VoiceProfile | null) {
  if (!profile) return 'Not learned yet';
  if (profile.source === 'edited' && profile.editedAt) return `Edited ${dayLabel(profile.editedAt)}`;
  if (profile.learnedAt)
    return `Learned from ${profile.sampleCount} sent ${profile.sampleCount === 1 ? 'email' : 'emails'} on ${dayLabel(profile.learnedAt)}`;
  return 'Set by you';
}

/** What a learn attempt says back to the user. */
export function learnResultMessage(result: LearnResult): { kind: 'success' | 'info'; text: string } {
  switch (result.status) {
    case 'learned':
      return { kind: 'success', text: 'Albatross learned how you write' };
    case 'too_soon':
      return {
        kind: 'info',
        text: `Albatross learns at most once a week. You can learn again on ${dayLabel(result.nextLearnAt ?? Date.now())}.`,
      };
    case 'edited':
      return { kind: 'info', text: 'Your edits are kept. Choose Replace my edits to learn again.' };
    default:
      return {
        kind: 'info',
        text: `Albatross needs at least 5 sent emails to learn how you write. It found ${result.sampleCount ?? 0}.`,
      };
  }
}

/** The "How you write" card (FEATURES item 16). */
export function VoiceProfileSettings() {
  const queryClient = useQueryClient();
  const voice = useQuery({
    queryKey: VOICE_QUERY_KEY,
    queryFn: async () => callTool<VoiceState>('get_voice_profile', {}),
    staleTime: 60_000,
  });
  const profile = voice.data?.profile ?? null;
  const [form, setForm] = useState({
    greeting: '',
    signOff: '',
    length: 'short' as VoiceLength,
    tone: '',
    notes: '',
  });
  const [confirmReplace, setConfirmReplace] = useState(false);
  useEffect(() => {
    setForm({
      greeting: profile?.greeting ?? '',
      signOff: profile?.signOff ?? '',
      length: profile?.length ?? 'short',
      tone: profile?.tone ?? '',
      notes: profile?.notes ?? '',
    });
  }, [profile]);
  const dirty =
    form.greeting !== (profile?.greeting ?? '') ||
    form.signOff !== (profile?.signOff ?? '') ||
    form.length !== (profile?.length ?? 'short') ||
    form.tone !== (profile?.tone ?? '') ||
    form.notes !== (profile?.notes ?? '');

  const save = useMutation({
    mutationFn: async () => callTool<{ profile: VoiceProfile }>('update_voice_profile', form),
    onSuccess: ({ profile: next }) => {
      queryClient.setQueryData<VoiceState>(VOICE_QUERY_KEY, (current) => ({
        profile: next,
        nextLearnAt: current?.nextLearnAt ?? null,
      }));
      toast.success('Saved how you write');
    },
    onError: (error: Error) => toast.error(error.message || 'Could not save.'),
  });
  const learn = useMutation({
    mutationFn: async (replaceEdited: boolean) =>
      callTool<LearnResult>('learn_voice_profile', { replaceEdited }),
    onSuccess: (result) => {
      setConfirmReplace(false);
      const message = learnResultMessage(result);
      if (message.kind === 'success') toast.success(message.text);
      else toast.message(message.text);
      void queryClient.invalidateQueries({ queryKey: VOICE_QUERY_KEY });
    },
    onError: (error: Error) => toast.error(error.message || 'Could not learn from your sent mail.'),
  });
  const waitUntil = voice.data?.nextLearnAt ?? null;
  const edited = profile?.source === 'edited';

  return (
    <section>
      <MailSettingsGroupTitle aside={voice.isLoading ? undefined : voiceSourceLine(profile)}>
        How you write
      </MailSettingsGroupTitle>
      {voice.error ? (
        <p className="text-[12.5px] text-[var(--color-danger)]">
          This card could not load. Reload to try again.
        </p>
      ) : (
        <MailSettingsCard>
          <MailSettingsRow
            id="voice-greeting"
            label="Greeting"
            description="How you open. {name} becomes the recipient's first name."
          >
            <Input
              id="voice-greeting"
              value={form.greeting}
              maxLength={80}
              placeholder="Hi {name},"
              onChange={(event) => setForm((value) => ({ ...value, greeting: event.target.value }))}
              className="h-8 max-w-80 text-[13px]"
            />
          </MailSettingsRow>
          <MailSettingsRow
            id="voice-signoff"
            label="Sign-off"
            description="How you close. When a mailbox signature is on, drafts leave your name to the signature."
          >
            <Textarea
              id="voice-signoff"
              value={form.signOff}
              maxLength={120}
              rows={2}
              placeholder={'Best,\nJakob'}
              onChange={(event) => setForm((value) => ({ ...value, signOff: event.target.value }))}
              className="min-h-14 max-w-80 resize-y text-[13px]"
            />
          </MailSettingsRow>
          <MailSettingsRow
            label="Length"
            description={
              profile?.typicalWords
                ? `Your sent mail runs about ${profile.typicalWords} words.`
                : 'How long your replies usually are.'
            }
            control={
              <Select
                value={form.length}
                onValueChange={(length) => setForm((value) => ({ ...value, length: length as VoiceLength }))}
              >
                <SelectTrigger size="sm" className="w-32" aria-label="Reply length">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent align="end">
                  <SelectItem value="short">Short</SelectItem>
                  <SelectItem value="medium">Medium</SelectItem>
                  <SelectItem value="long">Long</SelectItem>
                </SelectContent>
              </Select>
            }
          />
          <MailSettingsRow id="voice-tone" label="Tone" description="A few words on how you sound.">
            <Input
              id="voice-tone"
              value={form.tone}
              maxLength={240}
              placeholder="Warm and direct, short sentences"
              onChange={(event) => setForm((value) => ({ ...value, tone: event.target.value }))}
              className="h-8 text-[13px]"
            />
          </MailSettingsRow>
          <MailSettingsRow
            id="voice-notes"
            label="Anything else"
            description="Albatross keeps this when it learns again."
          >
            <Textarea
              id="voice-notes"
              value={form.notes}
              maxLength={500}
              rows={2}
              placeholder="Never use exclamation marks. Say “thanks” rather than “thank you”."
              onChange={(event) => setForm((value) => ({ ...value, notes: event.target.value }))}
              className="min-h-14 resize-y text-[13px]"
            />
          </MailSettingsRow>
          <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
            <div className="flex items-center gap-2">
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={learn.isPending || Boolean(waitUntil)}
                onClick={() => {
                  if (edited && !confirmReplace) {
                    setConfirmReplace(true);
                    return;
                  }
                  learn.mutate(edited);
                }}
              >
                {learn.isPending
                  ? 'Reading your sent mail…'
                  : confirmReplace
                    ? 'Replace my edits'
                    : profile?.learnedAt
                      ? 'Learn again'
                      : 'Learn from my sent mail'}
              </Button>
              {waitUntil ? (
                <span className="text-[11.5px] text-[var(--color-text-faint)]">
                  Next time on {dayLabel(waitUntil)}
                </span>
              ) : confirmReplace ? (
                <span className="text-[11.5px] text-[var(--color-text-muted)]">
                  Learning again replaces your greeting, sign-off, length, and tone.
                </span>
              ) : null}
            </div>
            <Button type="button" size="sm" disabled={!dirty || save.isPending} onClick={() => save.mutate()}>
              {save.isPending ? 'Saving…' : 'Save'}
            </Button>
          </div>
        </MailSettingsCard>
      )}
      <MailSettingsNote>
        Albatross reads up to 50 of your recent sent emails, at most once a week, and keeps only this card.
        Drafts from the Draft a reply button and from the assistant use it.
      </MailSettingsNote>
    </section>
  );
}
