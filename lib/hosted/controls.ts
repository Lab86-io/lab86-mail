export function envFlag(name: string) {
  const value = process.env[name];
  return value === '1' || value === 'true' || value === 'yes';
}

export function isLab86AiDisabled() {
  return envFlag('LAB86_DISABLE_LAB86_AI');
}

export function isUserOpenRouterKeyRequired() {
  return envFlag('LAB86_REQUIRE_USER_OPENROUTER_KEY');
}

export function isSubscriptionServiceDisabled() {
  return envFlag('LAB86_DISABLE_SUBSCRIPTIONS');
}

export function isOutboundSendDisabled() {
  return envFlag('LAB86_DISABLE_OUTBOUND_SEND');
}

export function isPublicSignupDisabled() {
  return envFlag('LAB86_DISABLE_PUBLIC_SIGNUP');
}

export function assertOutboundSendEnabled() {
  if (isOutboundSendDisabled()) {
    throw new Error('Outbound sending is temporarily disabled.');
  }
}

export function isStagingHost(host: string) {
  return host.split(':')[0].toLowerCase() === 'mail-staging.lab86.io';
}

export function isStagingRuntime(host?: string | null) {
  return (
    process.env.RAILWAY_ENVIRONMENT_NAME === 'development' ||
    process.env.NODE_ENV === 'development' ||
    Boolean(host && isStagingHost(host)) ||
    envFlag('LAB86_MAIL_REQUIRE_BASIC_AUTH')
  );
}
