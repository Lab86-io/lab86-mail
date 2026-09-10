/** Actual Mail rows and controls; deterministic synthetic mail, no account API. */
import { Search } from 'lucide-react';
import { ThemeProvider } from 'next-themes';
import { Fragment, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { InboxDateGroup, InboxThreadRow, type ThreadRow } from '../../components/inbox/Inbox';
import { AccountScopePopover } from '../../components/shell/Rail';
import { ThemePanel } from '../../components/shell/ThemePanel';
import { Button } from '../../components/ui/button';
import { InputGroup, InputGroupAddon, InputGroupInput } from '../../components/ui/input-group';
import { TooltipProvider } from '../../components/ui/tooltip';

const accounts = [
  {
    accountId: 'personal',
    email: 'personal@example.test',
    displayName: 'Personal',
    provider: 'google',
    authed: true,
  },
  { accountId: 'work', email: 'work@example.test', displayName: 'Work', provider: 'google', authed: true },
];
const rows: Array<ThreadRow & { image: 'loaded' | 'initials' | 'broken'; day: string }> = [
  {
    _id: 'loaded',
    account: 'work',
    from: 'Studio North',
    subject: 'A clearer place to work',
    snippet: 'A clearer place to work — Notes for our next design review.',
    unread: true,
    image: 'loaded',
    day: 'Today',
  },
  {
    _id: 'initials',
    account: 'personal',
    from: 'Alex Morgan',
    subject: 'Coffee tomorrow?',
    snippet: 'I found a place around the corner. Does ten work for you?',
    unread: true,
    image: 'initials',
    day: 'Today',
  },
  {
    _id: 'broken',
    account: 'personal',
    from: 'River Studio',
    subject: 'The next chapter',
    snippet: 'Sharing the final outline and the open questions from yesterday.',
    unread: false,
    image: 'broken',
    day: 'Yesterday',
  },
  {
    _id: 'encoded',
    account: 'work',
    from: 'Quinn Park',
    subject: 'It&#39;s &quot;ready&quot;',
    snippet:
      'It&#39;s &quot;ready&quot; — You&#39;re invited &amp; welcome. &lt;script&gt;window.__mailSnippetRan=true&lt;/script&gt;',
    unread: false,
    image: 'initials',
    day: 'Yesterday',
  },
];

function AppearancePreview() {
  const [visible, setVisible] = useState(true);
  return (
    <ThemeProvider attribute="class" defaultTheme="light" enableSystem={false}>
      <main className="min-h-dvh bg-[var(--color-bg)] p-3 text-[var(--color-text)] sm:p-8">
        <div className="mx-auto max-w-2xl">
          <h1 className="font-display text-2xl">Appearance foundations</h1>
          <p className="mt-1 text-xs text-[var(--color-text-muted)]">
            Actual inline settings · local synthetic preferences · no account requests
          </p>
          <Button className="my-4" variant="outline" onClick={() => setVisible((value) => !value)}>
            {visible ? 'Leave Appearance' : 'Return to Appearance'}
          </Button>
          {visible ? <ThemePanel inline /> : <p>Another settings section</p>}
        </div>
      </main>
    </ThemeProvider>
  );
}

function MailPreview() {
  const [accountFilter, setAccountFilter] = useState<string[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [action, setAction] = useState('Ready');
  const [recovered, setRecovered] = useState(false);
  const [query, setQuery] = useState('');
  const visibleRows = rows.filter(
    (row) =>
      (!accountFilter.length || accountFilter.includes(row.account || '')) &&
      `${row.from} ${row.subject} ${row.snippet}`.toLowerCase().includes(query.toLowerCase()),
  );
  const toggle = (id: string) =>
    setSelected((current) =>
      current.includes(id) ? current.filter((entry) => entry !== id) : [...current, id],
    );
  return (
    <TooltipProvider>
      <main className="min-h-dvh bg-[var(--color-bg)] p-3 text-[var(--color-text)] sm:p-8">
        <div className="mx-auto max-w-5xl">
          <header className="mb-5 flex flex-wrap items-center justify-between gap-3">
            <div>
              <h1 className="font-display text-2xl">Mail foundations</h1>
              <p className="mt-1 text-xs text-[var(--color-text-muted)]">
                Synthetic mail · actual row components · no account requests
              </p>
            </div>
            <Button variant="outline" size="sm" onClick={() => setRecovered(true)}>
              Recover failed image
            </Button>
          </header>
          <section
            aria-label="Mail workspace"
            className="overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-elevated)]"
          >
            <header
              data-mail-filter-header="Mail filters"
              className="flex items-center gap-2 border-b border-[var(--color-border)] px-3 py-2.5"
            >
              <AccountScopePopover
                accounts={accounts}
                accountFilter={accountFilter}
                setAccountFilter={setAccountFilter}
                indexingCount={0}
              />
              <InputGroup className="flex-1">
                <InputGroupAddon>
                  <Search size={16} />
                </InputGroupAddon>
                <InputGroupInput
                  aria-label="Search synthetic mail"
                  placeholder="Search your mail, or ask in your own words"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                />
              </InputGroup>
            </header>
            <div data-mail-results>
              {visibleRows.map((item, index) => (
                <Fragment key={item._id}>
                  {index === 0 || visibleRows[index - 1].day !== item.day ? (
                    <InboxDateGroup label={item.day} />
                  ) : null}
                  <InboxThreadRow
                    item={item}
                    rowId={item._id}
                    rowAccount={item.account || ''}
                    senderEmail=""
                    providerPhotoUrl={
                      item.image === 'loaded' || (item.image === 'broken' && recovered)
                        ? '/synthetic-avatar.svg'
                        : item.image === 'broken'
                          ? '/missing-avatar.png'
                          : null
                    }
                    showAccount
                    accountLabel={item.account === 'work' ? 'Work mailbox' : 'Personal mailbox'}
                    selected={selected.includes(item._id)}
                    active={active === item._id}
                    selecting={selected.length > 0}
                    onSelectRange={(id) => {
                      setSelected(
                        visibleRows
                          .slice(0, visibleRows.findIndex((row) => row._id === id) + 1)
                          .map((row) => row._id),
                      );
                      setAction(`Range selected: ${id}`);
                    }}
                    onToggleSelect={toggle}
                    onOpen={(_account, id) => {
                      setActive(id);
                      setAction(`Opened: ${id}`);
                    }}
                    onPrefetch={() => {}}
                    onApplyLabels={() => setAction('Labels opened')}
                    onArchive={(id) => setAction(`Archived: ${id}`)}
                    onTrash={(id) => setAction(`Deleted: ${id}`)}
                    onCorrect={(_row, correction) => setAction(`Correction: ${correction}`)}
                    onUndoLast={() => setAction('Undo requested')}
                    customLabels={[]}
                  />
                </Fragment>
              ))}
            </div>
          </section>
          <p role="status" className="mt-4 text-xs text-[var(--color-text-muted)]">
            {action}
          </p>
          <p data-fixture-selection className="mt-1 text-xs text-[var(--color-text-muted)]">
            Selected: {selected.join(', ') || 'none'}
          </p>
        </div>
      </main>
    </TooltipProvider>
  );
}

createRoot(document.getElementById('root')!).render(
  new URLSearchParams(location.search).get('view') === 'appearance' ? <AppearancePreview /> : <MailPreview />,
);
