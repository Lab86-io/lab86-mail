import { cn } from '@/lib/utils';

export function Kbd({ children, className }: { children: React.ReactNode; className?: string }) {
  return <kbd className={cn('font-mono', className)}>{children}</kbd>;
}
