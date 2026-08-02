export const ONBOARDING_DISMISSED_STORAGE_KEY = 'lab86-mail-onboarding-dismissed-v1';

/**
 * A missing mailbox no longer locks the product. Albatross's promise is "tell
 * me what is weighing on you"; the door must not be "connect a mailbox first".
 * This decides whether to *offer* the setup screen, not whether to force it.
 */
export function shouldOfferWelcome({
  dismissed,
  hasAccounts,
  isLoading,
  isError,
}: {
  dismissed: boolean | null;
  hasAccounts: boolean;
  isLoading: boolean;
  isError: boolean;
}) {
  if (dismissed === null || isLoading || isError) return false;
  return !dismissed && !hasAccounts;
}

export function shouldExitWelcome({ hasAccounts, isLoading }: { hasAccounts: boolean; isLoading: boolean }) {
  return hasAccounts && !isLoading;
}
