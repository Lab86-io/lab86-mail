declare module 'dropcap.js';

interface Window {
  Dropcap: {
    layout(element: HTMLElement, heightInLines: number, baselinePosition?: number): void;
  };
}
