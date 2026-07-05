// Pure state logic for the navigation rail's hover-expand behavior.
// No React, no DOM — bun:test-able in isolation (components/ui/sidebar.tsx
// consumes it).
//
// The contract:
// - 'pinned'    — the user explicitly expanded the rail; hover changes nothing.
// - 'peek'      — the rail is collapsed but the pointer is over it (or focus is
//                 inside it, for keyboard users): it floats expanded over the
//                 content without reflowing the panel layout.
// - 'collapsed' — icons only.

export type RailHoverState = 'collapsed' | 'peek' | 'pinned';

export function railHoverState(railOpen: boolean, hovering: boolean, focused: boolean): RailHoverState {
  if (railOpen) return 'pinned';
  if (hovering || focused) return 'peek';
  return 'collapsed';
}
