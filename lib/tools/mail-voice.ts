import { z } from 'zod';
import {
  getVoiceProfile,
  learnVoiceProfile,
  nextLearnAt,
  updateVoiceProfile,
  type VoiceProfile,
} from '../mail/voice-profile';
import { defineTool } from './registry';

// The "How you write" card (FEATURES item 16) for Settings and native.

const LengthSchema = z.enum(['short', 'medium', 'long']);

const ProfileOutput = z
  .object({
    greeting: z.string(),
    signOff: z.string(),
    length: LengthSchema,
    typicalWords: z.number(),
    tone: z.string(),
    notes: z.string(),
    source: z.enum(['learned', 'edited']),
    sampleCount: z.number(),
    learnedAt: z.number().nullable(),
    editedAt: z.number().nullable(),
    model: z.string().optional(),
  })
  .nullable();

function requireUser(userId: string | null | undefined) {
  if (!userId) throw new Error('Sign in required.');
  return userId;
}

export const getVoiceProfileTool = defineTool({
  name: 'get_voice_profile',
  description:
    'Read how the user writes email: greeting, sign-off, typical length, and tone, learned from sent mail or edited by the user.',
  category: 'compose',
  mutating: false,
  input: z.object({}).optional(),
  output: z.object({ profile: ProfileOutput, nextLearnAt: z.number().nullable() }),
  async handler() {
    const profile = (await getVoiceProfile()) as VoiceProfile | null;
    return { profile, nextLearnAt: nextLearnAt(profile, Date.now()) };
  },
});

export const updateVoiceProfileTool = defineTool({
  name: 'update_voice_profile',
  description: 'Edit the "How you write" card. Learning from sent mail does not overwrite an edited card.',
  category: 'compose',
  mutating: true,
  risk: 'write_self',
  input: z.object({
    greeting: z.string().max(80).optional(),
    signOff: z.string().max(120).optional(),
    length: LengthSchema.optional(),
    tone: z.string().max(240).optional(),
    notes: z.string().max(500).optional(),
  }),
  output: z.object({ profile: ProfileOutput }),
  async handler(patch) {
    return { profile: await updateVoiceProfile(patch) };
  },
});

export const learnVoiceProfileTool = defineTool({
  name: 'learn_voice_profile',
  description:
    'Learn how the user writes from up to 50 recent sent messages. Runs at most once a week. An edited card is kept unless replaceEdited is true.',
  category: 'compose',
  mutating: true,
  risk: 'write_self',
  input: z.object({ replaceEdited: z.boolean().optional() }).optional(),
  output: z.object({
    status: z.enum(['learned', 'too_soon', 'edited', 'not_enough_mail']),
    profile: ProfileOutput,
    nextLearnAt: z.number().optional(),
    sampleCount: z.number().optional(),
  }),
  async handler(input, ctx) {
    const result = await learnVoiceProfile({
      userId: requireUser(ctx.userId),
      replaceEdited: input?.replaceEdited,
    });
    return result;
  },
});
