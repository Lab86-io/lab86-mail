/** Back off quickly enough to help tomorrow, but never hot-loop a broken dependency. */
export function checkinRetryDelayMs(attempts: number) {
  const exponent = Math.min(Math.max(Math.floor(attempts) - 1, 0), 5);
  return Math.min(60 * 60_000, 2 ** exponent * 2 * 60_000);
}
