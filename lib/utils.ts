import { type ClassValue, clsx } from 'clsx';
import { extendTailwindMerge } from 'tailwind-merge';

// Treat our shared corner utility like every built-in radius, so explicit
// circle/square overrides and component variants retain predictable precedence.
const twMerge = extendTailwindMerge({ extend: { theme: { radius: ['ui'] } } });

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
