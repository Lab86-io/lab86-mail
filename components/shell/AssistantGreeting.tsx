'use client';

import { useUser } from '@clerk/nextjs';

export function assistantGreeting(phrase: string, userName?: string | null) {
  const firstName = userName?.trim().split(/\s+/)[0];
  if (!firstName || firstName.includes('@')) return phrase;
  const punctuation = phrase.match(/[.!?]$/)?.[0] || '';
  return `${punctuation ? phrase.slice(0, -1) : phrase}, ${firstName}${punctuation}`;
}

function Greeting({ phrase, userName }: { phrase: string; userName?: string | null }) {
  return (
    <h3
      data-assistant-greeting
      className="max-w-[360px] text-balance font-display text-[20px] font-normal leading-snug text-[var(--color-text)]"
    >
      {assistantGreeting(phrase, userName)}
    </h3>
  );
}
function SignedInGreeting({ phrase }: { phrase: string }) {
  const { user } = useUser();
  return <Greeting phrase={phrase} userName={user?.firstName || user?.fullName} />;
}
export function AssistantGreeting({
  phrase,
  clerkEnabled = false,
  userName,
}: {
  phrase: string;
  clerkEnabled?: boolean;
  userName?: string;
}) {
  return clerkEnabled ? (
    <SignedInGreeting phrase={phrase} />
  ) : (
    <Greeting phrase={phrase} userName={userName} />
  );
}
