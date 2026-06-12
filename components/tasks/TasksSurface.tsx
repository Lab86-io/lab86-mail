'use client';

import { useMutation as useConvexMutation, useQuery_experimental as useConvexQuery } from 'convex/react';
import { CalendarClock, Link2, Mail, Plus, Share2, SquareKanban, Trash2, Users, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import type { DragEndEvent } from '@/components/kibo-ui/kanban';
import {
  KanbanBoard,
  KanbanCard,
  KanbanCards,
  KanbanHeader,
  KanbanProvider,
} from '@/components/kibo-ui/kanban';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { api } from '@/convex/_generated/api';
import { useClientStore } from '@/lib/client-state';
import { cn } from '@/lib/utils';

const boardsApi = (api as any).boards;

interface BoardCard {
  cardId: string;
  boardId: string;
  columnId: string;
  title: string;
  description?: string;
  labels?: string[];
  priority?: 'low' | 'medium' | 'high';
  dueAt?: number;
  completedAt?: number;
  order: number;
  source?: { kind: string; accountId?: string; threadId?: string; messageId?: string };
}

interface BoardPayload {
  boardId: string;
  title: string;
  role: 'owner' | 'member' | 'viewer';
  publicToken: string | null;
  columns: Array<{ columnId: string; name: string; order: number }>;
  cards: BoardCard[];
  members: Array<{ memberId: string; email: string; role: string; status: string }>;
}

export function TasksSurface() {
  const [selectedBoardId, setSelectedBoardId] = useState<string | null>(null);

  const boardsQuery = useConvexQuery({ query: boardsApi.listMyBoards, args: {} });
  const boards: any[] = boardsQuery.status === 'success' ? boardsQuery.data || [] : [];

  const ensureDefault = useConvexMutation(boardsApi.ensureDefaultBoard);
  const claimInvites = useConvexMutation(boardsApi.claimInvites);
  const createBoard = useConvexMutation(boardsApi.createBoard);

  // First load: link any email invites to this user, and make sure a starter
  // board exists so the surface is never an empty void.
  const bootstrapped = useRef(false);
  useEffect(() => {
    if (bootstrapped.current || boardsQuery.status !== 'success') return;
    bootstrapped.current = true;
    void claimInvites({}).catch(() => undefined);
    if (!boards.length) void ensureDefault({}).catch(() => undefined);
  }, [boardsQuery.status, boards.length, claimInvites, ensureDefault]);

  const activeBoardId =
    selectedBoardId && boards.some((board) => board.boardId === selectedBoardId)
      ? selectedBoardId
      : boards[0]?.boardId || null;

  return (
    <div className="flex h-full min-w-0 flex-col overflow-hidden">
      <header className="flex items-center gap-2 overflow-x-auto border-b border-[var(--color-border)] px-5 pb-3 pt-12 md:pt-4">
        <h1 className="mr-2 font-display text-[20px] font-semibold tracking-tight text-[var(--color-text)]">
          Tasks
        </h1>
        {boards.map((board) => (
          <button
            key={board.boardId}
            type="button"
            onClick={() => setSelectedBoardId(board.boardId)}
            className={cn(
              'shrink-0 rounded-full border px-3 py-1 text-[12.5px] transition-colors',
              board.boardId === activeBoardId
                ? 'border-[var(--color-accent)] bg-[var(--color-accent-soft)] text-[var(--color-accent)]'
                : 'border-[var(--color-border)] text-[var(--color-text-muted)] hover:bg-[var(--color-bg-subtle)] hover:text-[var(--color-text)]',
            )}
          >
            {board.title}
            {!board.owned ? <Users className="ml-1 inline size-3 opacity-60" /> : null}
          </button>
        ))}
        <button
          type="button"
          onClick={async () => {
            const title = window.prompt('Board name');
            if (!title) return;
            try {
              const boardId = await createBoard({ title });
              setSelectedBoardId(boardId as string);
            } catch (err: any) {
              toast.error(err?.message || 'Could not create board');
            }
          }}
          className="grid size-6 shrink-0 place-items-center rounded-full border border-dashed border-[var(--color-border)] text-[var(--color-text-faint)] hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]"
          title="New board"
        >
          <Plus className="size-3.5" />
        </button>
      </header>
      {activeBoardId ? (
        <BoardView key={activeBoardId} boardId={activeBoardId} />
      ) : (
        <EmptyState loading={boardsQuery.status !== 'success'} />
      )}
    </div>
  );
}

function EmptyState({ loading }: { loading: boolean }) {
  return (
    <div className="grid flex-1 place-items-center px-6">
      <div className="flex max-w-sm flex-col items-center gap-3 text-center">
        <span className="grid size-12 place-items-center rounded-full border border-[var(--color-border)] bg-[var(--color-bg-elevated)] text-[var(--color-text-muted)] shadow-[var(--shadow-soft)]">
          <SquareKanban size={22} strokeWidth={1.75} />
        </span>
        <p className="font-display text-[16px] font-semibold text-[var(--color-text)]">
          {loading ? 'Loading your boards…' : 'Setting up your first board…'}
        </p>
      </div>
    </div>
  );
}

function BoardView({ boardId }: { boardId: string }) {
  const boardQuery = useConvexQuery({ query: boardsApi.getBoard, args: { boardId } });
  const board: BoardPayload | null = boardQuery.status === 'success' ? boardQuery.data : null;

  const moveCard = useConvexMutation(boardsApi.moveCard);
  const createCard = useConvexMutation(boardsApi.createCard);
  const createColumn = useConvexMutation(boardsApi.createColumn);

  const canEdit = board ? board.role !== 'viewer' : false;

  // kibo's controlled data: local mirror for fluid drag, server resyncs on
  // every Convex push (which also covers collaborators' edits in real time).
  const [items, setItems] = useState<Array<{ id: string; name: string; column: string }>>([]);
  const cardsById = useMemo(
    () => new Map((board?.cards || []).map((card) => [card.cardId, card])),
    [board?.cards],
  );
  useEffect(() => {
    if (!board) return;
    setItems(board.cards.map((card) => ({ id: card.cardId, name: card.title, column: card.columnId })));
  }, [board]);

  const [openCardId, setOpenCardId] = useState<string | null>(null);
  const [shareOpen, setShareOpen] = useState(false);

  const handleDragEnd = (event: DragEndEvent) => {
    if (!board || !canEdit) return;
    const cardId = String(event.active.id);
    const previous = cardsById.get(cardId);
    const local = items.find((item) => item.id === cardId);
    if (!previous || !local) return;
    const targetColumn = local.column;
    // Position within the column after the local reorder.
    const columnItems = items.filter((item) => item.column === targetColumn);
    const index = columnItems.findIndex((item) => item.id === cardId);
    const beforeId = index > 0 ? columnItems[index - 1].id : undefined;
    const afterId = index < columnItems.length - 1 ? columnItems[index + 1].id : undefined;
    const beforeOrder = beforeId ? cardsById.get(beforeId)?.order : undefined;
    const afterOrder = afterId ? cardsById.get(afterId)?.order : undefined;
    if (previous.columnId === targetColumn && beforeId === undefined && afterId === undefined) return;
    void moveCard({ cardId, columnId: targetColumn, beforeOrder, afterOrder }).catch((err: any) =>
      toast.error(err?.message || 'Could not move card'),
    );
  };

  if (!board) {
    return (
      <div className="grid flex-1 place-items-center text-[13px] text-[var(--color-text-muted)]">
        Loading board…
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 px-5 py-2">
        <span className="text-[12px] text-[var(--color-text-faint)]">
          {board.cards.length} card{board.cards.length === 1 ? '' : 's'}
          {board.role !== 'owner' ? ` · shared with you (${board.role})` : ''}
        </span>
        <div className="ml-auto flex items-center gap-1.5">
          {canEdit ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-7 gap-1.5 px-2 text-[12px]"
              onClick={async () => {
                const name = window.prompt('Column name');
                if (!name) return;
                try {
                  await createColumn({ boardId: board.boardId, name });
                } catch (err: any) {
                  toast.error(err?.message || 'Could not add column');
                }
              }}
            >
              <Plus className="size-3" /> Column
            </Button>
          ) : null}
          {board.role === 'owner' ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-7 gap-1.5 px-2 text-[12px]"
              onClick={() => setShareOpen(true)}
            >
              <Share2 className="size-3" /> Share
            </Button>
          ) : null}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-x-auto px-5 pb-5">
        <KanbanProvider
          columns={board.columns.map((column) => ({ id: column.columnId, name: column.name }))}
          data={items}
          onDataChange={setItems}
          onDragEnd={handleDragEnd}
          className="h-full min-w-fit"
        >
          {(column) => (
            <KanbanBoard id={column.id} key={column.id} className="w-72 bg-[var(--color-bg-subtle)]">
              <KanbanHeader className="flex items-center justify-between px-3 py-2">
                <span className="text-[12px] font-semibold uppercase tracking-[0.08em] text-[var(--color-text-muted)]">
                  {column.name}
                </span>
                <span className="text-[11px] tabular-nums text-[var(--color-text-faint)]">
                  {items.filter((item) => item.column === column.id).length}
                </span>
              </KanbanHeader>
              <KanbanCards id={column.id}>
                {(item: any) => {
                  const card = cardsById.get(item.id);
                  return (
                    <KanbanCard key={item.id} {...item}>
                      <button
                        type="button"
                        className="block w-full text-left"
                        onClick={() => setOpenCardId(item.id)}
                      >
                        <CardFace card={card} fallbackTitle={item.name} />
                      </button>
                    </KanbanCard>
                  );
                }}
              </KanbanCards>
              {canEdit ? (
                <QuickAddCard
                  onAdd={async (title) => {
                    try {
                      await createCard({
                        boardId: board.boardId,
                        columnId: column.id,
                        title,
                        source: { kind: 'manual' },
                      });
                    } catch (err: any) {
                      toast.error(err?.message || 'Could not add card');
                    }
                  }}
                />
              ) : null}
            </KanbanBoard>
          )}
        </KanbanProvider>
      </div>

      {openCardId && cardsById.get(openCardId) ? (
        <CardSheet
          card={cardsById.get(openCardId) as BoardCard}
          canEdit={canEdit}
          onClose={() => setOpenCardId(null)}
        />
      ) : null}
      {shareOpen ? <ShareDialog board={board} onClose={() => setShareOpen(false)} /> : null}
    </div>
  );
}

const PRIORITY_DOT: Record<string, string> = {
  high: 'bg-[var(--color-danger)]',
  medium: 'bg-amber-500',
  low: 'bg-emerald-500',
};

function CardFace({ card, fallbackTitle }: { card?: BoardCard; fallbackTitle: string }) {
  const done = Boolean(card?.completedAt);
  const overdue = card?.dueAt && !done && card.dueAt < Date.now();
  return (
    <div className="space-y-1.5">
      <p
        className={cn(
          'text-[13px] font-medium leading-snug text-[var(--color-text)]',
          done && 'text-[var(--color-text-faint)] line-through',
        )}
      >
        {card?.title || fallbackTitle}
      </p>
      {card?.labels?.length || card?.dueAt || card?.priority || card?.source?.threadId ? (
        <div className="flex flex-wrap items-center gap-1.5">
          {card?.priority ? (
            <span
              className={cn('size-1.5 rounded-full', PRIORITY_DOT[card.priority])}
              title={`${card.priority} priority`}
            />
          ) : null}
          {(card?.labels || []).slice(0, 3).map((label) => (
            <Badge key={label} variant="outline" className="px-1.5 py-0 text-[9.5px]">
              {label}
            </Badge>
          ))}
          {card?.dueAt ? (
            <span
              className={cn(
                'inline-flex items-center gap-1 text-[10.5px]',
                overdue ? 'font-medium text-[var(--color-danger)]' : 'text-[var(--color-text-faint)]',
              )}
            >
              <CalendarClock className="size-3" />
              {new Date(card.dueAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
            </span>
          ) : null}
          {card?.source?.threadId ? (
            <Mail className="size-3 text-[var(--color-text-faint)]" aria-label="Created from an email" />
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function QuickAddCard({ onAdd }: { onAdd: (title: string) => void }) {
  const [value, setValue] = useState('');
  return (
    <form
      className="p-2"
      onSubmit={(event) => {
        event.preventDefault();
        const title = value.trim();
        if (!title) return;
        setValue('');
        onAdd(title);
      }}
    >
      <Input
        value={value}
        onChange={(event) => setValue(event.target.value)}
        placeholder="Add a card…"
        className="h-7 border-dashed bg-transparent text-[12.5px]"
      />
    </form>
  );
}

function CardSheet({ card, canEdit, onClose }: { card: BoardCard; canEdit: boolean; onClose: () => void }) {
  const updateCard = useConvexMutation(boardsApi.updateCard);
  const deleteCard = useConvexMutation(boardsApi.deleteCard);
  const setPrimaryView = useClientStore((s) => s.setPrimaryView);
  const setSelectedThread = useClientStore((s) => s.setSelectedThread);
  const setThreadAccount = useClientStore((s) => s.setThreadAccount);

  const [title, setTitle] = useState(card.title);
  const [description, setDescription] = useState(card.description || '');
  const [labels, setLabels] = useState((card.labels || []).join(', '));
  const [priority, setPriority] = useState<string>(card.priority || '');
  const [due, setDue] = useState(card.dueAt ? toLocalInputValue(card.dueAt) : '');
  const done = Boolean(card.completedAt);

  const save = async () => {
    try {
      await updateCard({
        cardId: card.cardId,
        title: title.trim() || card.title,
        description,
        labels: labels
          .split(',')
          .map((label) => label.trim())
          .filter(Boolean),
        priority: (priority || undefined) as any,
        dueAt: due ? new Date(due).getTime() : null,
      });
      onClose();
    } catch (err: any) {
      toast.error(err?.message || 'Could not save card');
    }
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogTitle className="sr-only">Card details</DialogTitle>
        <div className="space-y-3">
          <Input
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            disabled={!canEdit}
            className="border-none px-0 font-display text-[17px] font-semibold shadow-none focus-visible:ring-0"
          />
          <textarea
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            disabled={!canEdit}
            placeholder="Notes (markdown)"
            className="min-h-28 w-full rounded-md border border-[var(--color-border)] bg-transparent px-2.5 py-2 text-[13px] leading-relaxed"
          />
          <div className="grid grid-cols-2 gap-2">
            <label htmlFor="card-due" className="space-y-1 text-[11px] text-[var(--color-text-muted)]">
              Due
              <Input
                id="card-due"
                type="datetime-local"
                value={due}
                onChange={(event) => setDue(event.target.value)}
                disabled={!canEdit}
                className="h-8 text-[12.5px]"
              />
            </label>
            <label htmlFor="card-priority" className="space-y-1 text-[11px] text-[var(--color-text-muted)]">
              Priority
              <select
                id="card-priority"
                value={priority}
                onChange={(event) => setPriority(event.target.value)}
                disabled={!canEdit}
                className="h-8 w-full rounded-md border border-[var(--color-border)] bg-transparent px-2 text-[12.5px]"
              >
                <option value="">None</option>
                <option value="low">Low</option>
                <option value="medium">Medium</option>
                <option value="high">High</option>
              </select>
            </label>
          </div>
          <label htmlFor="card-labels" className="block space-y-1 text-[11px] text-[var(--color-text-muted)]">
            Labels (comma-separated)
            <Input
              id="card-labels"
              value={labels}
              onChange={(event) => setLabels(event.target.value)}
              disabled={!canEdit}
              className="h-8 text-[12.5px]"
            />
          </label>
          {card.source?.threadId ? (
            <button
              type="button"
              onClick={() => {
                if (card.source?.accountId) setThreadAccount(card.source.accountId);
                setSelectedThread(card.source?.threadId || null);
                setPrimaryView('mail');
                onClose();
              }}
              className="inline-flex items-center gap-1.5 rounded-full border border-[var(--color-border)] px-2.5 py-1 text-[11.5px] text-[var(--color-text-muted)] hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]"
            >
              <Mail className="size-3" /> From this email — open thread
            </button>
          ) : null}
          {canEdit ? (
            <div className="flex items-center gap-2 pt-1">
              <Button type="button" size="sm" onClick={save} className="h-8 px-3 text-[12.5px]">
                Save
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-8 px-3 text-[12.5px]"
                onClick={async () => {
                  try {
                    await updateCard({
                      cardId: card.cardId,
                      completedAt: done ? null : Date.now(),
                    });
                    onClose();
                  } catch (err: any) {
                    toast.error(err?.message || 'Could not update card');
                  }
                }}
              >
                {done ? 'Reopen' : 'Mark done'}
              </Button>
              <Button
                type="button"
                size="icon-sm"
                variant="ghost"
                className="ml-auto text-[var(--color-text-muted)] hover:text-[var(--color-danger)]"
                title="Delete card"
                onClick={async () => {
                  if (!window.confirm('Delete this card?')) return;
                  try {
                    await deleteCard({ cardId: card.cardId });
                    onClose();
                  } catch (err: any) {
                    toast.error(err?.message || 'Could not delete card');
                  }
                }}
              >
                <Trash2 className="size-3.5" />
              </Button>
            </div>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function ShareDialog({ board, onClose }: { board: BoardPayload; onClose: () => void }) {
  const inviteMember = useConvexMutation(boardsApi.inviteMember);
  const removeMember = useConvexMutation(boardsApi.removeMember);
  const setPublicLink = useConvexMutation(boardsApi.setPublicLink);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<'member' | 'viewer'>('member');

  const publicUrl = board.publicToken ? `${window.location.origin}/b/${board.publicToken}` : null;

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-md">
        <DialogTitle>Share “{board.title}”</DialogTitle>
        <div className="space-y-4">
          <form
            className="flex items-center gap-2"
            onSubmit={async (event) => {
              event.preventDefault();
              if (!email.trim()) return;
              try {
                await inviteMember({ boardId: board.boardId, email: email.trim(), role });
                setEmail('');
                toast.success('Invited — they’ll see the board when they sign in');
              } catch (err: any) {
                toast.error(err?.message || 'Could not invite');
              }
            }}
          >
            <Input
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              placeholder="email@example.com"
              className="h-8 flex-1 text-[12.5px]"
            />
            <select
              value={role}
              onChange={(event) => setRole(event.target.value as 'member' | 'viewer')}
              className="h-8 rounded-md border border-[var(--color-border)] bg-transparent px-2 text-[12.5px]"
            >
              <option value="member">Can edit</option>
              <option value="viewer">View only</option>
            </select>
            <Button type="submit" size="sm" className="h-8 px-3 text-[12.5px]">
              Invite
            </Button>
          </form>

          {board.members.length ? (
            <ul className="space-y-1.5">
              {board.members.map((member) => (
                <li key={member.memberId} className="flex items-center gap-2 text-[12.5px]">
                  <span className="min-w-0 flex-1 truncate">{member.email}</span>
                  <Badge variant="outline" className="px-1.5 py-0 text-[10px]">
                    {member.role}
                    {member.status === 'invited' ? ' · invited' : ''}
                  </Badge>
                  <button
                    type="button"
                    onClick={async () => {
                      try {
                        await removeMember({ boardId: board.boardId, memberId: member.memberId });
                      } catch (err: any) {
                        toast.error(err?.message || 'Could not remove');
                      }
                    }}
                    className="text-[var(--color-text-faint)] hover:text-[var(--color-danger)]"
                  >
                    <X className="size-3.5" />
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-[12px] text-[var(--color-text-faint)]">No collaborators yet.</p>
          )}

          <div className="space-y-2 border-t border-[var(--color-border)] pt-3">
            <div className="flex items-center justify-between">
              <span className="inline-flex items-center gap-1.5 text-[12.5px] text-[var(--color-text-muted)]">
                <Link2 className="size-3.5" /> Public read-only link
              </span>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-7 px-2 text-[11.5px]"
                onClick={async () => {
                  try {
                    if (board.publicToken) {
                      await setPublicLink({ boardId: board.boardId, enabled: false });
                      toast.success('Public link disabled');
                    } else {
                      const token = crypto.randomUUID().replace(/-/g, '');
                      await setPublicLink({ boardId: board.boardId, enabled: true, token });
                      toast.success('Public link enabled');
                    }
                  } catch (err: any) {
                    toast.error(err?.message || 'Could not update link');
                  }
                }}
              >
                {board.publicToken ? 'Disable' : 'Enable'}
              </Button>
            </div>
            {publicUrl ? (
              <button
                type="button"
                className="block w-full truncate rounded-md border border-[var(--color-border)] bg-[var(--color-bg-subtle)] px-2.5 py-1.5 text-left text-[11.5px] text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
                onClick={() => {
                  void navigator.clipboard.writeText(publicUrl);
                  toast.success('Link copied');
                }}
                title="Copy link"
              >
                {publicUrl}
              </button>
            ) : null}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function toLocalInputValue(epoch: number): string {
  const date = new Date(epoch);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
