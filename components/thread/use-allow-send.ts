'use client';

// The send permission for a sealed file, through the identity check
// (lib/mail/allow-send.ts). The app's composers pass the function this hook
// returns; the dev harness passes none and the composer posts without the
// check.

import { useReverification } from '@clerk/nextjs';
import { useCallback } from 'react';
import {
  ALLOW_SEND_COPY,
  type AllowSendAnswer,
  type AllowSendBody,
  AllowSendError,
  postAllowSendOrCheck,
} from '@/lib/mail/allow-send';

export type AllowSendFn = (body: AllowSendBody) => Promise<AllowSendAnswer>;

export function useAllowSend(): AllowSendFn {
  const withCheck = useReverification(postAllowSendOrCheck);
  return useCallback(
    async (body: AllowSendBody) => {
      const result = await withCheck(body);
      if (result && 'ok' in result && result.ok) return result;
      // The user closed the check: nothing was allowed.
      throw new AllowSendError(ALLOW_SEND_COPY.cancelled, 403, 'verify_identity');
    },
    [withCheck],
  );
}

/** The plain function for hosts without Clerk: no identity check. */
export async function allowSendWithoutCheck(body: AllowSendBody): Promise<AllowSendAnswer> {
  const result = await postAllowSendOrCheck(body);
  if (result && 'ok' in result && result.ok) return result;
  throw new AllowSendError(ALLOW_SEND_COPY.cancelled, 403, 'verify_identity');
}
