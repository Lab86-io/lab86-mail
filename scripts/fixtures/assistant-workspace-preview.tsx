/** The actual AssistantWorkspace frame and AssistantLauncher around a
 * synthetic page and a synthetic chat. No network, no account data. The chat
 * header mirrors the labels AIBar renders so the verify script exercises the
 * same controls. Query: ?open=1 ?presentation=split|full ?mobile=1|0
 * ?theme=dark ?rotate=<ms>. */
import { History, Maximize2, Minimize2, PanelLeftClose, PanelLeftOpen, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { type AssistantPresentation, AssistantWorkspace } from '../../components/shell/AssistantWorkspace';
import { AssistantLauncher } from '../../components/shell/ShellActions';
import { Button } from '../../components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '../../components/ui/dropdown-menu';
import { TooltipProvider } from '../../components/ui/tooltip';

const params = new URLSearchParams(location.search);
if (params.get('theme') === 'dark') document.documentElement.classList.add('dark');
const rotateMs = Number(params.get('rotate')) || undefined;

declare global {
  interface Window {
    assistantPreview: {
      pageClicks: number;
      pageMounts: number;
      chatMounts: number;
      ticks: number;
      setOpen: (open: boolean) => void;
      setPresentation: (presentation: AssistantPresentation) => void;
      state: () => { open: boolean; presentation: AssistantPresentation; mobile: boolean };
    };
  }
}
window.assistantPreview = {
  pageClicks: 0,
  pageMounts: 0,
  chatMounts: 0,
  ticks: 0,
  setOpen: () => {},
  setPresentation: () => {},
  state: () => ({ open: false, presentation: 'corner', mobile: false }),
};

const SUBJECTS = ['Venue contract', 'Dentist before the trip', 'Q3 numbers', 'Lease renewal'];

function SyntheticPage() {
  const [filter, setFilter] = useState('');
  useEffect(() => {
    window.assistantPreview.pageMounts += 1;
  }, []);
  const rows = Array.from(
    { length: 40 },
    (_, index) => `Thread ${index + 1} · ${SUBJECTS[index % 4]}`,
  ).filter((row) => row.toLowerCase().includes(filter.toLowerCase()));
  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex shrink-0 items-center gap-3 border-b border-[var(--color-border)] px-4 py-2.5">
        <h1 className="font-display text-[17px] font-semibold">Mail</h1>
        <input
          aria-label="Filter threads"
          placeholder="Filter"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          className="h-8 rounded-[var(--radius-control)] border border-[var(--color-control-border)] bg-[var(--color-bg-elevated)] px-2 text-[12.5px]"
        />
      </header>
      <div data-page-list="" className="scrollable min-h-0 flex-1 overflow-y-auto">
        <ul>
          {rows.map((row) => (
            <li key={row}>
              <button
                type="button"
                onClick={() => {
                  window.assistantPreview.pageClicks += 1;
                }}
                className="flex w-full items-center justify-between border-b border-[var(--color-list-divider)] px-4 py-2 text-left text-[13px] hover:bg-[var(--color-bg-subtle)]"
              >
                <span>{row}</span>
                <span className="text-[11px] text-[var(--color-text-faint)]">9:41</span>
              </button>
            </li>
          ))}
        </ul>
      </div>
      <div className="shrink-0 border-t border-[var(--color-border)] p-3">
        <textarea
          aria-label="Draft reply"
          placeholder="Draft reply"
          rows={2}
          className="w-full resize-none rounded-[var(--radius-control)] border border-[var(--color-control-border)] bg-[var(--color-bg-elevated)] p-2 text-[13px]"
        />
      </div>
    </div>
  );
}

function SyntheticChat({
  open,
  presentation,
  setPresentation,
  onClose,
}: {
  open: boolean;
  presentation: AssistantPresentation;
  setPresentation: (presentation: AssistantPresentation) => void;
  onClose: () => void;
}) {
  const [ticks, setTicks] = useState(0);
  const [input, setInput] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    window.assistantPreview.chatMounts += 1;
    const timer = window.setInterval(() => setTicks((n) => n + 1), 500);
    return () => window.clearInterval(timer);
  }, []);
  useEffect(() => {
    window.assistantPreview.ticks = ticks;
  }, [ticks]);
  // AIBar focuses its composer the same way once the panel opens.
  useEffect(() => {
    if (open) requestAnimationFrame(() => textareaRef.current?.focus());
  }, [open]);
  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col">
      <header className="flex shrink-0 items-center justify-between gap-2 border-b border-[var(--color-list-divider)] px-4 py-3">
        <div className="flex min-w-0 items-center gap-2 text-[13px]">
          <span aria-hidden className="size-4 rounded-full bg-[var(--color-accent-soft)]" />
          <span className="font-medium">Albatross</span>
        </div>
        <div className="flex items-center gap-0.5">
          {presentation !== 'corner' ? (
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={presentation === 'full' ? 'Show current page' : 'Focus on chat'}
              onClick={() => setPresentation(presentation === 'full' ? 'split' : 'full')}
              className="hidden md:inline-flex"
            >
              {presentation === 'full' ? (
                <PanelLeftOpen className="size-4" />
              ) : (
                <PanelLeftClose className="size-4" />
              )}
            </Button>
          ) : null}
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={presentation === 'corner' ? 'Expand chat beside this page' : 'Return to corner chat'}
            onClick={() => setPresentation(presentation === 'corner' ? 'split' : 'corner')}
            className="hidden md:inline-flex"
          >
            {presentation === 'corner' ? <Maximize2 className="size-4" /> : <Minimize2 className="size-4" />}
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon-sm" title="Chat history">
                <History className="size-3.5" />
                <span className="sr-only">Chat history</span>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuLabel>Previous chats</DropdownMenuLabel>
              <DropdownMenuItem>Venue contract</DropdownMenuItem>
              <DropdownMenuItem>Trip planning</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <Button variant="ghost" size="icon-sm" title="Close (⌘K)" onClick={onClose}>
            <X className="size-3.5" />
            <span className="sr-only">Close</span>
          </Button>
        </div>
      </header>
      <div className="scrollable min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-4 text-[13px]">
        <p className="ml-auto w-fit max-w-[80%] rounded-[var(--radius-control)] bg-[var(--color-accent-soft)] px-3 py-2">
          What did Sarah say about the venue?
        </p>
        <p className="max-w-[88%] leading-relaxed">
          Sarah confirmed the venue holds 120 and asked for the deposit by Friday. Want me to draft the reply?
        </p>
        <p data-stream-tick="" className="text-[11px] text-[var(--color-text-faint)]">
          Streaming · tick {ticks}
        </p>
      </div>
      <div className="shrink-0 border-t border-[var(--color-list-divider)] p-3">
        <textarea
          ref={textareaRef}
          aria-label="Message Albatross"
          placeholder="Ask, or hold a thought"
          rows={2}
          value={input}
          onChange={(event) => setInput(event.target.value)}
          className="w-full resize-none rounded-[var(--radius-control)] border border-[var(--color-control-border)] bg-[var(--color-bg)] p-2 text-[13px]"
        />
      </div>
    </div>
  );
}

function Preview() {
  const [open, setOpen] = useState(params.get('open') === '1');
  const [presentation, setPresentation] = useState<AssistantPresentation>(
    (params.get('presentation') as AssistantPresentation | null) || 'corner',
  );
  const [mobile, setMobile] = useState(() =>
    params.has('mobile') ? params.get('mobile') === '1' : window.innerWidth < 768,
  );
  useEffect(() => {
    if (params.has('mobile')) return;
    const query = window.matchMedia('(max-width: 767px)');
    const sync = () => setMobile(query.matches);
    query.addEventListener('change', sync);
    return () => query.removeEventListener('change', sync);
  }, []);
  // The store opens the chat whenever a presentation is chosen; mirror that.
  const choosePresentation = (next: AssistantPresentation) => {
    setPresentation(next);
    setOpen(true);
  };
  useEffect(() => {
    window.assistantPreview.setOpen = setOpen;
    window.assistantPreview.setPresentation = choosePresentation;
    window.assistantPreview.state = () => ({ open, presentation, mobile });
  });
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setOpen((value) => !value);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);
  return (
    <TooltipProvider delayDuration={350}>
      <div className="flex h-dvh overflow-hidden bg-[var(--color-bg)] text-[var(--color-text)]">
        <nav
          aria-label="Navigation rail"
          className="rail-wash hidden w-14 shrink-0 border-r border-[var(--color-border)] md:block"
        />
        <main className="app-paper relative flex h-dvh min-w-0 flex-1 flex-col overflow-hidden">
          <AssistantWorkspace
            open={open}
            presentation={presentation}
            onPresentationChange={choosePresentation}
            onClose={() => setOpen(false)}
            mobile={mobile}
            assistant={
              <SyntheticChat
                open={open}
                presentation={presentation}
                setPresentation={choosePresentation}
                onClose={() => setOpen(false)}
              />
            }
          >
            <div className="relative flex h-full min-h-0 min-w-0 flex-col overflow-hidden">
              <SyntheticPage />
            </div>
          </AssistantWorkspace>
          {open ? null : (
            <AssistantLauncher
              placement="corner"
              shortcut="⌘K"
              onOpen={() => setOpen(true)}
              rotateMs={rotateMs}
            />
          )}
        </main>
      </div>
    </TooltipProvider>
  );
}

createRoot(document.getElementById('root') as HTMLElement).render(<Preview />);
