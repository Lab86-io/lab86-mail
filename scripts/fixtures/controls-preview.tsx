/** Actual controls, synthetic context. No auth, network or account data. */
import { Calendar, CheckCircle, FileText, Inbox, Settings } from 'lucide-react';
import { type CSSProperties, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { AssistantLauncher, RailPrimaryActions } from '../../components/shell/ShellActions';
import { MessageDraft } from '../../components/tool-ui/message-draft/message-draft';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { InputGroup, InputGroupAddon, InputGroupInput } from '../../components/ui/input-group';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../components/ui/select';
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
} from '../../components/ui/sidebar';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../../components/ui/tabs';
import { Textarea } from '../../components/ui/textarea';
import { Toggle } from '../../components/ui/toggle';
import { TooltipProvider } from '../../components/ui/tooltip';

function Preview() {
  const [action, setAction] = useState('Ready');
  const [view, setView] = useState('Files');
  const [layout, setLayout] = useState('list');
  return (
    <TooltipProvider>
      <SidebarProvider style={{ '--sidebar-width': '224px' } as CSSProperties}>
        <Sidebar collapsible="icon" className="rail-wash font-display">
          <SidebarHeader className="gap-3">
            <div className="flex h-9 items-center justify-between px-1 group-data-[collapsible=icon]:justify-center">
              <span className="group-data-[collapsible=icon]:hidden">
                <span className="block text-[17px] font-semibold leading-none">Albatross</span>
                <span className="text-[10.5px] text-[var(--color-text-muted)]">by Lab86</span>
              </span>
              <SidebarTrigger title="Toggle navigation rail" />
            </div>
            <RailPrimaryActions
              captureLabel="Get this off my mind"
              searchShortcut="⌘F"
              onCapture={() => setAction('Capture opened')}
              onSearch={() => setAction('Search opened')}
            />
          </SidebarHeader>
          <SidebarContent>
            <SidebarGroup>
              <SidebarMenu>
                {[
                  [FileText, 'Today'],
                  [CheckCircle, 'Albatrosses'],
                  [Inbox, 'Mail'],
                  [Calendar, 'Calendar'],
                  [FileText, 'Files'],
                ].map(([Icon, label]) => {
                  const Glyph = Icon as typeof FileText;
                  return (
                    <SidebarMenuItem key={String(label)}>
                      <SidebarMenuButton
                        tooltip={String(label)}
                        isActive={view === label}
                        className="rail-selection"
                        onClick={() => setView(String(label))}
                      >
                        <Glyph aria-hidden />
                        <span>{String(label)}</span>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  );
                })}
              </SidebarMenu>
            </SidebarGroup>
          </SidebarContent>
          <SidebarFooter>
            <div className="flex items-center gap-2 p-1">
              <div className="rail-profile">
                <button
                  type="button"
                  aria-label="Profile"
                  className="cl-userButtonTrigger"
                  onClick={() => setAction('Profile opened')}
                >
                  <span className="cl-userButtonAvatarBox block bg-[var(--color-accent-soft)]">
                    <svg
                      viewBox="0 0 24 24"
                      role="img"
                      aria-label="Synthetic avatar"
                      className="cl-userButtonAvatarImage text-[var(--color-accent)]"
                    >
                      <rect width="24" height="24" fill="currentColor" />
                      <circle cx="12" cy="9" r="4" fill="white" />
                      <circle cx="12" cy="25" r="10" fill="white" />
                    </svg>
                  </span>
                </button>
              </div>
              <span className="text-xs text-[var(--color-text-muted)] group-data-[collapsible=icon]:hidden">
                Personal workspace
              </span>
            </div>
          </SidebarFooter>
        </Sidebar>
        <main className="h-dvh min-w-0 flex-1 overflow-auto bg-[var(--color-bg)] text-[var(--color-text)]">
          <header className="flex min-h-16 items-center gap-3 border-b border-[var(--color-border)] px-5">
            <SidebarTrigger className="md:hidden" />
            <h1 className="text-[15px] font-semibold">{view}</h1>
            <Button variant="ghost" size="icon" aria-label="Settings" className="ml-auto">
              <Settings />
            </Button>
          </header>
          <div className="mx-auto max-w-3xl space-y-7 px-5 py-8 pb-28">
            <div>
              <h2 className="font-display text-3xl tracking-tight">A place for your work.</h2>
              <p className="mt-2 text-sm text-[var(--color-text-muted)]">
                Documents, ideas, and the next thing to do.
              </p>
            </div>
            <section
              aria-label="Control examples"
              className="space-y-5 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-elevated)] p-5"
            >
              <div className="flex flex-wrap items-center gap-2">
                <Button onClick={() => setAction('Create clicked')}>New document</Button>
                <Button variant="outline" onClick={() => setAction('Upload clicked')}>
                  Upload files
                </Button>
                <Button variant="secondary">Save for later</Button>
                <Button variant="ghost">More</Button>
                <Button variant="outline" disabled>
                  Unavailable
                </Button>
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <label htmlFor="preview-name" className="space-y-2 text-xs">
                  Name
                  <Input id="preview-name" aria-label="Name" placeholder="Untitled document" />
                </label>
                <div className="space-y-2 text-xs">
                  <span>Location</span>
                  <Select defaultValue="library">
                    <SelectTrigger aria-label="Location" className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="library">Your library</SelectItem>
                      <SelectItem value="drive">Google Drive</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <InputGroup>
                <InputGroupAddon>
                  <FileText className="size-4" />
                </InputGroupAddon>
                <InputGroupInput aria-label="Find a file" placeholder="Find a file…" />
              </InputGroup>
              <Textarea aria-label="Notes" placeholder="What is this document for?" />
              <div className="flex flex-wrap items-center gap-3">
                <Tabs value={layout} onValueChange={setLayout}>
                  <TabsList>
                    <TabsTrigger value="list">List</TabsTrigger>
                    <TabsTrigger value="grid">Grid</TabsTrigger>
                  </TabsList>
                  <TabsContent value={layout} className="sr-only">
                    {layout} selected
                  </TabsContent>
                </Tabs>
                <Toggle variant="outline" aria-label="Show recent only">
                  Recent only
                </Toggle>
              </div>
              <Input disabled aria-label="Read only example" value="Synced from your drive" readOnly />
              <Input aria-invalid="true" aria-label="Invalid example" placeholder="A document needs a name" />
            </section>
            <MessageDraft
              id="draft-fixture"
              channel="email"
              to={['alex@example.test']}
              subject="Project update"
              body="Here is the draft for your review."
              onEdit={() => setAction('Draft opened for editing')}
            />
            <p role="status" className="text-xs text-[var(--color-text-muted)]">
              {action}
            </p>
          </div>
          <AssistantLauncher placement="corner" shortcut="⌘K" onOpen={() => setAction('Assistant opened')} />
        </main>
      </SidebarProvider>
    </TooltipProvider>
  );
}
createRoot(document.getElementById('root')!).render(<Preview />);
