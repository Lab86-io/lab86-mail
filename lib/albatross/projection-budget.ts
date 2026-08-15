export const INTERACTIVE_CARD_READ_BUDGET = 3_200;
export const RECOVERY_CARD_READ_BUDGET_PER_USER = 200;

/**
 * Keep a projection inside its database-read budget without returning a row
 * whose card-backed completion state is only partially known.
 *
 * Callers may order entries by product priority before selecting them, then
 * restore their presentation order afterward.
 */
export function selectCardCompleteProjection<T>(
  entries: readonly T[],
  cardIdsFor: (entry: T) => readonly string[],
  maxCardReads = INTERACTIVE_CARD_READ_BUDGET,
) {
  const items: T[] = [];
  const cardIds = new Set<string>();
  const budget = Math.max(0, Math.floor(maxCardReads));

  for (const entry of entries) {
    const entryCardIds = [...new Set(cardIdsFor(entry).filter(Boolean))];
    const additionalReads = entryCardIds.reduce((count, cardId) => count + (cardIds.has(cardId) ? 0 : 1), 0);
    if (cardIds.size + additionalReads > budget) continue;

    items.push(entry);
    for (const cardId of entryCardIds) cardIds.add(cardId);
  }

  return { items, cardIds: [...cardIds] };
}
