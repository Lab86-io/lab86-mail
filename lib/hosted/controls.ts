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

export function isDevelopmentRuntime() {
  return process.env.NODE_ENV === 'development' || envFlag('LAB86_DEVELOPMENT_MODE');
}
