'use client';

import { useTheme } from 'next-themes';
import { useEffect, useState } from 'react';
import { buildUpdatePreview } from '@/lib/updates/preview';

export function UpdatePreview({
  html,
  title,
  interactive = false,
}: {
  html: string;
  title: string;
  interactive?: boolean;
}) {
  const { resolvedTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const appearance =
    mounted && (resolvedTheme === 'dark' || resolvedTheme === 'light') ? resolvedTheme : undefined;
  return (
    <iframe
      title={`Preview: ${title}`}
      srcDoc={buildUpdatePreview(html, title, appearance)}
      sandbox=""
      referrerPolicy="no-referrer"
      loading="lazy"
      tabIndex={interactive ? 0 : -1}
      className={`${interactive ? '' : 'pointer-events-none '}h-[320px] w-full border-0 sm:h-[260px]`}
    />
  );
}
