export function showRailNotificationCenter(input: {
  albatrossEnabled: boolean;
  railCollapsed: boolean;
}): boolean {
  return input.albatrossEnabled && !input.railCollapsed;
}
