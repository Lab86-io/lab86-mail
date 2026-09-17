'use client';

import { ThoughtChain, ThoughtChainStep, ThoughtChainTrigger } from '@/components/odysseyui/thought-chain';
import type { ToolActivity } from '@/lib/albatross/teach-ui';

export function ToolActivityRow({ activity, className }: { activity: ToolActivity; className?: string }) {
  return (
    <ThoughtChain className={className}>
      <ThoughtChainStep
        status={activity.state === 'running' ? 'active' : activity.state === 'failed' ? 'failed' : 'done'}
      >
        <ThoughtChainTrigger expandable={false}>{activity.text}</ThoughtChainTrigger>
      </ThoughtChainStep>
    </ThoughtChain>
  );
}
