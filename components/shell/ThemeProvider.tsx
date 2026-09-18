'use client';

import { ThemeProvider as NextThemesProvider, type ThemeProviderProps } from 'next-themes';
import { BrowserThemeColor } from './BrowserThemeColor';

export function ThemeProvider({ children, ...props }: ThemeProviderProps) {
  return (
    <NextThemesProvider {...props}>
      <BrowserThemeColor />
      {children}
    </NextThemesProvider>
  );
}
