export const ONBOARDING_DISMISSED_STORAGE_KEY = 'lab86-mail-onboarding-dismissed-v1';

export function shouldRedirectToWelcome({
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
