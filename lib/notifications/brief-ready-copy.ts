/** What the morning edition holds, as far as the caller knows. */
export interface BriefReadyParts {
  weather?: boolean;
  events?: number;
  tasks?: number;
  intent?: boolean;
}

function joinList(items: string[]) {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/**
 * The push line when the edition has no lede. It names only the parts that
 * exist, so it never promises weather or an intent the brief does not have
 * (BRF-14). This is the morning brief, so the intent is for today.
 */
export function briefReadyFallbackBody(parts: BriefReadyParts = {}): string {
  const items: string[] = [];
  if (parts.weather) items.push('the weather');
  if (parts.events) items.push(`${parts.events} ${parts.events === 1 ? 'event' : 'events'} on your calendar`);
  if (parts.tasks) items.push(`${parts.tasks} ${parts.tasks === 1 ? 'task' : 'tasks'} due`);
  if (parts.intent) items.push('what you said you want to get done today');
  if (!items.length) return 'Your brief for today is ready to read.';
  return `Today’s brief has ${joinList(items)}.`;
}
