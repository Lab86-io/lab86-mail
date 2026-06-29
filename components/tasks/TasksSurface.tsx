'use client';

import { useMutation as useConvexMutation, useQuery_experimental as useConvexQuery } from 'convex/react';
import {
  CalendarClock,
  Circle,
  CircleCheck,
  Download,
  ExternalLink,
  FileArchive,
  File as FileIcon,
  FileImage,
  FileSpreadsheet,
  FileText,
  GripVertical,
  LayoutList,
  Link2,
  Mail,
  MessageSquare,
  MoreHorizontal,
  Paperclip,
  Pencil,
  Plus,
  Share2,
  Sparkles,
  SquareKanban,
  Trash2,
  UploadCloud,
  Users,
  X,
} from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { createContext, useContext, useEffect, useId, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { toast } from 'sonner';
import type { DragEndEvent } from '@/components/kibo-ui/kanban';
import {
  KanbanBoard,
  KanbanCard,
  KanbanCards,
  KanbanColumnHandle,
  KanbanHeader,
  KanbanProvider,
} from '@/components/kibo-ui/kanban';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Markdown } from '@/components/ui/markdown';
import { api } from '@/convex/_generated/api';
import { callTool } from '@/lib/api-client';
import { useClientStore } from '@/lib/client-state';
import { normalizeUrl } from '@/lib/shared/url';
import { cn } from '@/lib/utils';

const boardsApi = (api as any).boards;

interface CardAttachment {
  name: string;
  url?: string;
  storageId?: string;
  contentType?: string;
  size?: number;
}

interface BoardCard {
  cardId: string;
  boardId: string;
  columnId: string;
  title: string;
  description?: string;
  labels?: string[];
  priority?: 'low' | 'medium' | 'high';
  weight?: number;
  assignees?: string[];
  dueAt?: number;
  completedAt?: number;
  order: number;
  attachments?: CardAttachment[];
  comments?: Array<{ id: string; authorEmail?: string; body: string; createdAt: number }>;
  activity?: Array<{ id: string; actorEmail?: string; action: string; detail?: string; createdAt: number }>;
  source?: {
    kind: string;
    accountId?: string;
    threadId?: string;
    messageId?: string;
    calendarId?: string;
    eventId?: string;
    url?: string;
    htmlLink?: string;
    title?: string;
  };
  sourceThreadId?: string;
  sourceCalendarEventId?: string;
  sourceAccountId?: string;
}

interface BoardPayload {
  boardId: string;
  title: string;
  role: 'owner' | 'member' | 'viewer';
  publicToken: string | null;
  ownerEmail?: string;
  columns: Array<{ columnId: string; name: string; order: number }>;
  cards: BoardCard[];
  members: Array<{ memberId: string; email: string; role: string; status: string }>;
}

type BoardViewMode = 'kanban' | 'list';
type BoardColumnItem = { id: string; name: string; order: number };

// Lets BoardView render its toolbar controls into the parent header row.
const BoardHeaderActionsSlot = createContext<HTMLElement | null>(null);

export function TasksSurface() {
  const [selectedBoardId, setSelectedBoardId] = useState<string | null>(null);
  const [newBoardOpen, setNewBoardOpen] = useState(false);
  const [renameBoardOpen, setRenameBoardOpen] = useState(false);
  // BoardView portals its view/column/share controls up into this header slot
  // so they sit inline with the "Tasks" title instead of in a second toolbar row.
  const [headerSlot, setHeaderSlot] = useState<HTMLElement | null>(null);

  const boardsQuery = useConvexQuery({ query: boardsApi.listMyBoards, args: {} });
  const boards: any[] = boardsQuery.status === 'success' ? boardsQuery.data || [] : [];

  const ensureDefault = useConvexMutation(boardsApi.ensureDefaultBoard);
  const claimInvites = useConvexMutation(boardsApi.claimInvites);
  const createBoard = useConvexMutation(boardsApi.createBoard);
  const renameBoard = useConvexMutation(boardsApi.renameBoard);

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
  const activeBoard = boards.find((board) => board.boardId === activeBoardId);

  return (
    <BoardHeaderActionsSlot.Provider value={headerSlot}>
      <div className="flex h-full min-w-0 flex-col overflow-hidden">
        <header className="flex items-center gap-2 border-b border-[var(--color-border)] px-5 pb-3 pt-12 md:pt-4">
          <h1 className="shrink-0 font-display text-[20px] font-semibold tracking-tight text-[var(--color-text)]">
            Tasks
          </h1>
          <div className="flex min-w-0 flex-1 items-center gap-2 overflow-x-auto">
            {boards.map((board) => (
              <button
                key={board.boardId}
                type="button"
                onClick={() => setSelectedBoardId(board.boardId)}
                // Rename the active, owned board — no separate edit button. Mouse:
                // double-click. Keyboard: F2, or Enter when it's already active
                // (so keyboard/AT users still have a rename path).
                onDoubleClick={() => {
                  if (board.boardId === activeBoardId && board.owned) setRenameBoardOpen(true);
                }}
                onKeyDown={(event) => {
                  if (!board.owned) return;
                  const renameKey =
                    event.key === 'F2' || (event.key === 'Enter' && board.boardId === activeBoardId);
                  if (renameKey) {
                    event.preventDefault();
                    setSelectedBoardId(board.boardId);
                    setRenameBoardOpen(true);
                  }
                }}
                title={board.owned ? 'Double-click or press F2 to rename' : undefined}
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
              onClick={() => setNewBoardOpen(true)}
              className="grid size-6 shrink-0 place-items-center rounded-full border border-dashed border-[var(--color-border)] text-[var(--color-text-faint)] hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]"
              title="New board"
            >
              <Plus className="size-3.5" />
            </button>
          </div>
          {/* BoardView portals its view/column/share controls in here. */}
          <div ref={setHeaderSlot} className="flex shrink-0 items-center gap-1.5" />
        </header>
        {activeBoardId ? (
          <BoardView key={activeBoardId} boardId={activeBoardId} />
        ) : (
          <EmptyState loading={boardsQuery.status !== 'success'} />
        )}
        <NameDialog
          open={newBoardOpen}
          title="New board"
          placeholder="Board name"
          submitLabel="Create board"
          onClose={() => setNewBoardOpen(false)}
          onSubmit={async (title) => {
            try {
              const boardId = await createBoard({ title });
              setSelectedBoardId(boardId as string);
            } catch (err: any) {
              toast.error(err?.message || 'Could not create board');
            }
          }}
        />
        <NameDialog
          open={renameBoardOpen}
          title="Rename board"
          placeholder="Board name"
          submitLabel="Rename"
          initialValue={activeBoard?.title || ''}
          onClose={() => setRenameBoardOpen(false)}
          onSubmit={async (title) => {
            if (!activeBoardId) return;
            try {
              await renameBoard({ boardId: activeBoardId, title });
            } catch (err: any) {
              toast.error(err?.message || 'Could not rename board');
            }
          }}
        />
      </div>
    </BoardHeaderActionsSlot.Provider>
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
  const headerSlot = useContext(BoardHeaderActionsSlot);
  const boardQuery = useConvexQuery({ query: boardsApi.getBoard, args: { boardId } });
  const board: BoardPayload | null = boardQuery.status === 'success' ? boardQuery.data : null;

  const moveCard = useConvexMutation(boardsApi.moveCard);
  const createCard = useConvexMutation(boardsApi.createCard);
  const createColumn = useConvexMutation(boardsApi.createColumn);
  const updateColumn = useConvexMutation(boardsApi.updateColumn);
  const deleteColumn = useConvexMutation(boardsApi.deleteColumn);
  const updateCard = useConvexMutation(boardsApi.updateCard);

  const canEdit = board ? board.role !== 'viewer' : false;

  const [viewMode, setViewMode] = useState<BoardViewMode>(() => {
    if (typeof window === 'undefined') return 'kanban';
    return (window.localStorage.getItem(`board-view:${boardId}`) as BoardViewMode) || 'kanban';
  });
  const switchView = (mode: BoardViewMode) => {
    setViewMode(mode);
    try {
      window.localStorage.setItem(`board-view:${boardId}`, mode);
    } catch {}
  };

  // kibo's controlled data: local mirror for fluid drag, server resyncs on
  // every Convex push (which also covers collaborators' edits in real time).
  const [items, setItems] = useState<Array<{ id: string; name: string; column: string }>>([]);
  const [columns, setColumns] = useState<BoardColumnItem[]>([]);
  const cardsById = useMemo(
    () => new Map((board?.cards || []).map((card) => [card.cardId, card])),
    [board?.cards],
  );
  useEffect(() => {
    if (!board) return;
    setItems(board.cards.map((card) => ({ id: card.cardId, name: card.title, column: card.columnId })));
    setColumns(
      board.columns.map((column) => ({
        id: column.columnId,
        name: column.name,
        order: column.order,
      })),
    );
  }, [board]);

  const [openCardId, setOpenCardId] = useState<string | null>(null);
  const [shareOpen, setShareOpen] = useState(false);
  const [newColumnOpen, setNewColumnOpen] = useState(false);
  const [renameColumn, setRenameColumn] = useState<{ columnId: string; name: string } | null>(null);
  const [createInColumn, setCreateInColumn] = useState<string | null>(null);

  const openCard = openCardId ? cardsById.get(openCardId) : null;

  const handleItemDragEnd = (
    event: DragEndEvent,
    nextItems: Array<{ id: string; name: string; column: string }>,
  ) => {
    if (!board || !canEdit) return;
    const cardId = String(event.active.id);
    const previous = cardsById.get(cardId);
    const local = nextItems.find((item) => item.id === cardId);
    if (!previous || !local) return;
    const targetColumn = local.column;
    const columnItems = nextItems.filter((item) => item.column === targetColumn);
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

  const persistColumnOrder = (nextColumns: BoardColumnItem[]) => {
    if (!canEdit) return;
    const previousIndexById = new Map(columns.map((column, index) => [column.id, index]));
    const changedColumns = nextColumns.filter((column, index) => previousIndexById.get(column.id) !== index);
    if (!changedColumns.length) return;
    void Promise.all(
      changedColumns.map((column) =>
        updateColumn({
          columnId: column.id,
          order: (nextColumns.findIndex((item) => item.id === column.id) + 1) * 1024,
        }),
      ),
    ).catch((err: any) => toast.error(err?.message || 'Could not reorder columns'));
  };

  if (!board) {
    return (
      <div className="grid flex-1 place-items-center text-[13px] text-[var(--color-text-muted)]">
        Loading board…
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1">
      <div className="flex min-w-0 flex-1 flex-col">
        {/* Toolbar controls live inline with the page title (parent header slot). */}
        {headerSlot
          ? createPortal(
              <>
                <div className="flex overflow-hidden rounded-md border border-[var(--color-border)]">
                  <button
                    type="button"
                    onClick={() => switchView('kanban')}
                    className={cn(
                      'grid h-7 w-8 place-items-center',
                      viewMode === 'kanban'
                        ? 'bg-[var(--color-accent-soft)] text-[var(--color-accent)]'
                        : 'text-[var(--color-text-faint)] hover:text-[var(--color-text)]',
                    )}
                    title="Kanban view"
                  >
                    <SquareKanban className="size-3.5" />
                  </button>
                  <button
                    type="button"
                    onClick={() => switchView('list')}
                    className={cn(
                      'grid h-7 w-8 place-items-center border-l border-[var(--color-border)]',
                      viewMode === 'list'
                        ? 'bg-[var(--color-accent-soft)] text-[var(--color-accent)]'
                        : 'text-[var(--color-text-faint)] hover:text-[var(--color-text)]',
                    )}
                    title="To-do list view"
                  >
                    <LayoutList className="size-3.5" />
                  </button>
                </div>
                {canEdit ? (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="h-7 gap-1.5 px-2 text-[12px]"
                    onClick={() => setNewColumnOpen(true)}
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
              </>,
              headerSlot,
            )
          : null}

        {viewMode === 'kanban' ? (
          <div className="min-h-0 flex-1 overflow-x-auto px-5 pb-2 pt-3">
            <KanbanProvider
              columns={columns}
              data={items}
              onDataChange={setItems}
              onColumnsChange={canEdit ? setColumns : undefined}
              onColumnDragEnd={canEdit ? (_event, nextColumns) => persistColumnOrder(nextColumns) : undefined}
              onItemDragEnd={handleItemDragEnd}
              className="h-full min-w-fit"
            >
              {(column) => (
                <KanbanBoard
                  id={column.id}
                  key={column.id}
                  className="h-full w-[300px] shrink-0 divide-y-0 rounded-xl border-[var(--color-border)] bg-[var(--color-bg-subtle)]/45 shadow-none"
                >
                  <KanbanHeader className="flex items-center px-3 pb-1.5 pt-3">
                    {canEdit ? (
                      <KanbanColumnHandle
                        className="mr-1 text-[var(--color-text-faint)] hover:bg-[var(--color-bg-muted)] hover:text-[var(--color-text-muted)]"
                        title="Drag column"
                      >
                        <GripVertical className="size-3.5" />
                      </KanbanColumnHandle>
                    ) : null}
                    <button
                      type="button"
                      disabled={!canEdit}
                      onDoubleClick={() =>
                        setRenameColumn({ columnId: column.id, name: String(column.name) })
                      }
                      title={canEdit ? 'Double-click to rename' : undefined}
                      className="text-left text-[12px] font-semibold uppercase tracking-[0.08em] text-[var(--color-text-muted)]"
                    >
                      {column.name}
                    </button>
                    <span className="ml-auto mr-1 text-[11px] tabular-nums text-[var(--color-text-faint)]">
                      {items.filter((item) => item.column === column.id).length}
                    </span>
                    {canEdit ? (
                      <ColumnMenu
                        onRename={() => setRenameColumn({ columnId: column.id, name: String(column.name) })}
                        onDelete={async () => {
                          try {
                            await deleteColumn({ columnId: column.id });
                          } catch (err: any) {
                            toast.error(err?.message || 'Could not delete column');
                          }
                        }}
                        cardCount={items.filter((item) => item.column === column.id).length}
                        columnName={String(column.name)}
                      />
                    ) : null}
                  </KanbanHeader>
                  <ColumnLoadBar
                    count={items.filter((i: any) => i.column === column.id).length}
                    max={Math.max(
                      1,
                      ...columns.map((c: any) => items.filter((i: any) => i.column === c.id).length),
                    )}
                  />
                  <KanbanCards id={column.id} className="gap-2.5 px-2.5">
                    {(item: any) => {
                      const card = cardsById.get(item.id);
                      const done = Boolean(card?.completedAt);
                      return (
                        <KanbanCard
                          key={item.id}
                          {...item}
                          onCardClick={() => setOpenCardId(item.id)}
                          className={cn(
                            'group rounded-xl border-[var(--color-border)] bg-[var(--color-bg-elevated)] p-3.5 shadow-[var(--shadow-soft)] transition-[transform,box-shadow,border-color] duration-150 hover:-translate-y-px hover:border-[var(--color-border-strong)] hover:shadow-md',
                            done && 'opacity-75',
                            card?.priority ? PRIORITY_EDGE[card.priority] : undefined,
                          )}
                        >
                          {/* Native button = keyboard activation for free.
                              Pointer taps still route through the wrapper's
                              onCardClick (drag-aware); both just set the same
                              open state, so double-firing is harmless. */}
                          <div className="relative">
                            <button
                              type="button"
                              aria-label={`Open card: ${card?.title || item.name}`}
                              onClick={() => setOpenCardId(item.id)}
                              className="block w-full rounded-sm text-left outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]"
                            >
                              <CardFace card={card} fallbackTitle={item.name} />
                            </button>
                            {/* Highest-frequency action surfaced on hover; the
                                full action set still lives in the card panel. */}
                            {canEdit && card ? (
                              <button
                                type="button"
                                title={done ? 'Mark not done' : 'Mark done'}
                                // KanbanCard opens from its wrapper's pointerup;
                                // swallow it so the toggle doesn't also open.
                                onPointerUp={(e) => e.stopPropagation()}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  void updateCard({
                                    cardId: card.cardId,
                                    completedAt: done ? null : Date.now(),
                                  }).catch((err: any) =>
                                    toast.error(err?.message || 'Could not update card'),
                                  );
                                }}
                                className="absolute -right-1 -top-1 grid size-6 place-items-center rounded-md bg-[var(--color-bg-elevated)] text-[var(--color-text-faint)] opacity-0 shadow-[var(--shadow-soft)] transition-opacity hover:text-[var(--color-accent)] focus-visible:opacity-100 group-hover:opacity-100"
                              >
                                {done ? (
                                  <CircleCheck className="size-4 text-[var(--color-accent)]" />
                                ) : (
                                  <Circle className="size-4" />
                                )}
                                <span className="sr-only">{done ? 'Mark not done' : 'Mark done'}</span>
                              </button>
                            ) : null}
                          </div>
                        </KanbanCard>
                      );
                    }}
                  </KanbanCards>
                  {canEdit ? (
                    <button
                      type="button"
                      onClick={() => setCreateInColumn(column.id)}
                      className="mx-2 mb-2 mt-auto inline-flex h-8 items-center justify-start gap-1.5 rounded-lg px-2.5 text-[12.5px] font-medium text-[var(--color-text-faint)] transition-colors hover:bg-[var(--color-bg-muted)] hover:text-[var(--color-text)]"
                    >
                      <Plus className="size-3.5" /> Add card
                    </button>
                  ) : null}
                </KanbanBoard>
              )}
            </KanbanProvider>
          </div>
        ) : (
          <ListView
            board={board}
            canEdit={canEdit}
            onOpenCard={setOpenCardId}
            onAddCard={setCreateInColumn}
          />
        )}
      </div>

      <AnimatePresence>
        {openCard ? (
          <CardPanel
            key={openCard.cardId}
            card={openCard}
            canEdit={canEdit}
            role={board.role}
            assignable={[
              ...new Set(
                [board.ownerEmail, ...board.members.map((member) => member.email)].filter(
                  Boolean,
                ) as string[],
              ),
            ]}
            onClose={() => setOpenCardId(null)}
          />
        ) : null}
      </AnimatePresence>

      {shareOpen ? <ShareDialog board={board} onClose={() => setShareOpen(false)} /> : null}
      {createInColumn ? (
        <CreateCardDialog
          boardId={board.boardId}
          columnName={columns.find((c) => c.id === createInColumn)?.name || ''}
          onClose={() => setCreateInColumn(null)}
          onCreate={async (fields) => {
            try {
              await createCard({
                boardId: board.boardId,
                columnId: createInColumn,
                source: { kind: 'manual' },
                ...fields,
              });
              setCreateInColumn(null);
            } catch (err: any) {
              toast.error(err?.message || 'Could not add card');
            }
          }}
        />
      ) : null}
      <NameDialog
        open={newColumnOpen}
        title="New column"
        placeholder="Column name"
        submitLabel="Add column"
        onClose={() => setNewColumnOpen(false)}
        onSubmit={async (name) => {
          try {
            await createColumn({ boardId: board.boardId, name });
          } catch (err: any) {
            toast.error(err?.message || 'Could not add column');
          }
        }}
      />
      <NameDialog
        open={Boolean(renameColumn)}
        title="Rename column"
        placeholder="Column name"
        submitLabel="Rename"
        initialValue={renameColumn?.name || ''}
        onClose={() => setRenameColumn(null)}
        onSubmit={async (name) => {
          if (!renameColumn) return;
          try {
            await updateColumn({ columnId: renameColumn.columnId, name });
          } catch (err: any) {
            toast.error(err?.message || 'Could not rename column');
          }
        }}
      />
    </div>
  );
}

function ColumnMenu({
  onRename,
  onDelete,
  cardCount,
  columnName,
}: {
  onRename: () => void;
  onDelete: () => void;
  cardCount: number;
  columnName: string;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="grid size-5 place-items-center rounded text-[var(--color-text-faint)] hover:bg-[var(--color-bg-muted)] hover:text-[var(--color-text)]"
          title="Column actions"
        >
          <MoreHorizontal className="size-3.5" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-44">
        <DropdownMenuItem onSelect={onRename} className="gap-2 text-[12.5px]">
          <Pencil className="size-3.5" /> Rename
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <DropdownMenuItem
              onSelect={(event) => event.preventDefault()}
              className="gap-2 text-[12.5px] text-[var(--color-danger)] focus:text-[var(--color-danger)]"
            >
              <Trash2 className="size-3.5" /> Delete column
            </DropdownMenuItem>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Delete “{columnName}”?</AlertDialogTitle>
              <AlertDialogDescription>
                {cardCount
                  ? `Its ${cardCount} card${cardCount === 1 ? '' : 's'} will be deleted with it.`
                  : 'The column is empty.'}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction onClick={onDelete}>Delete</AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// To-do list mode: same data, grouped by column as checkable rows.
function ListView({
  board,
  canEdit,
  onOpenCard,
  onAddCard,
}: {
  board: BoardPayload;
  canEdit: boolean;
  onOpenCard: (cardId: string) => void;
  onAddCard: (columnId: string) => void;
}) {
  const updateCard = useConvexMutation(boardsApi.updateCard);
  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-3 pt-3">
      {board.columns.map((column) => {
        const cards = board.cards.filter((card) => card.columnId === column.columnId);
        return (
          <section key={column.columnId} className="mb-5">
            <div className="mb-1.5 flex items-center gap-2">
              <h2 className="text-[12px] font-semibold uppercase tracking-[0.08em] text-[var(--color-text-muted)]">
                {column.name}
              </h2>
              <span className="text-[11px] tabular-nums text-[var(--color-text-faint)]">{cards.length}</span>
              {canEdit ? (
                <button
                  type="button"
                  onClick={() => onAddCard(column.columnId)}
                  className="grid size-5 place-items-center rounded text-[var(--color-text-faint)] hover:text-[var(--color-accent)]"
                  title={`Add to ${column.name}`}
                >
                  <Plus className="size-3" />
                </button>
              ) : null}
            </div>
            <ul className="divide-y divide-[var(--color-border)] rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-elevated)]">
              {cards.map((card) => (
                <li key={card.cardId} className="flex items-center gap-2.5 px-3 py-2">
                  <Checkbox
                    checked={Boolean(card.completedAt)}
                    disabled={!canEdit}
                    onCheckedChange={(checked) => {
                      void updateCard({
                        cardId: card.cardId,
                        completedAt: checked ? Date.now() : null,
                      }).catch((err: any) => toast.error(err?.message || 'Could not update'));
                    }}
                  />
                  <button
                    type="button"
                    onClick={() => onOpenCard(card.cardId)}
                    className="min-w-0 flex-1 text-left"
                  >
                    <span
                      className={cn(
                        'block truncate text-[13.5px]',
                        card.completedAt && 'text-[var(--color-text-faint)] line-through',
                      )}
                    >
                      {card.title}
                    </span>
                  </button>
                  <CardMetaChips card={card} />
                </li>
              ))}
              {!cards.length ? (
                <li className="px-3 py-2 text-[12px] text-[var(--color-text-faint)]">Nothing here.</li>
              ) : null}
            </ul>
          </section>
        );
      })}
    </div>
  );
}

const PRIORITY_DOT: Record<string, string> = {
  high: 'bg-[var(--color-danger)]',
  medium: 'bg-amber-500',
  low: 'bg-emerald-500',
};

// A coloured left edge reads priority across a whole column far faster than a
// 6px dot buried in the meta row (colour from the data's meaning).
const PRIORITY_EDGE: Record<string, string> = {
  high: 'border-l-[3px] border-l-[var(--color-danger)]',
  medium: 'border-l-[3px] border-l-amber-500',
  low: 'border-l-[3px] border-l-emerald-500',
};

// A thin per-column load bar (cards relative to the busiest column) turns a row
// of bare counts into a glanceable workload distribution.
function ColumnLoadBar({ count, max }: { count: number; max: number }) {
  if (!count) return null;
  return (
    <div className="mx-3 mb-1.5 h-1 overflow-hidden rounded-full bg-[var(--color-bg-muted)]">
      <div
        className="h-full rounded-full bg-[var(--color-accent)]/40"
        style={{ width: `${Math.round((count / Math.max(1, max)) * 100)}%` }}
      />
    </div>
  );
}

// Overlapping initials avatars (Linear/ClickUp idiom). The ring colour matches
// the card surface so the stack reads as layered chips, not floating dots.
function AssigneeStack({ emails, max = 3 }: { emails?: string[]; max?: number }) {
  if (!emails?.length) return null;
  const shown = emails.slice(0, max);
  const extra = emails.length - shown.length;
  return (
    <span className="flex shrink-0 items-center -space-x-1.5">
      <span className="sr-only">Assigned to {emails.join(', ')}</span>
      {shown.map((email) => (
        <span
          key={email}
          title={email}
          aria-hidden="true"
          className="grid size-5 place-items-center rounded-full bg-[var(--color-accent-soft)] text-[8.5px] font-semibold uppercase text-[var(--color-accent)] ring-2 ring-[var(--color-bg-elevated)]"
        >
          {emailInitials(email)}
        </span>
      ))}
      {extra > 0 ? (
        <span
          aria-hidden="true"
          className="grid size-5 place-items-center rounded-full bg-[var(--color-bg-muted)] text-[8.5px] font-semibold tabular-nums text-[var(--color-text-muted)] ring-2 ring-[var(--color-bg-elevated)]"
        >
          +{extra}
        </span>
      ) : null}
    </span>
  );
}

function CardMetaChips({ card, hideAssignees }: { card?: BoardCard; hideAssignees?: boolean }) {
  if (!card) return null;
  const overdue = card.dueAt && !card.completedAt && card.dueAt < Date.now();
  return (
    <span className="flex shrink-0 flex-wrap items-center gap-1.5">
      {card.priority ? (
        <span
          className={cn('size-1.5 rounded-full', PRIORITY_DOT[card.priority])}
          title={`${card.priority} priority`}
        />
      ) : null}
      {(card.labels || []).slice(0, 3).map((label) => (
        <Badge key={label} variant="outline" className="px-1.5 py-0 text-[9.5px]">
          {label}
        </Badge>
      ))}
      {card.dueAt ? (
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
      {card.source?.threadId || card.sourceThreadId ? (
        <span
          className="inline-flex items-center gap-1 rounded bg-[var(--color-bg-muted)] px-1 py-0 text-[9.5px] font-medium text-[var(--color-text-muted)]"
          title="Created from an email"
        >
          <Mail className="size-2.5" /> Email
        </span>
      ) : null}
      {card.source?.eventId || card.sourceCalendarEventId ? (
        <span
          className="inline-flex items-center gap-1 rounded bg-[var(--color-bg-muted)] px-1 py-0 text-[9.5px] font-medium text-[var(--color-text-muted)]"
          title="Created from a calendar event"
        >
          <CalendarClock className="size-2.5" /> Event
        </span>
      ) : null}
      {card.attachments?.length ? (
        <Paperclip className="size-3 text-[var(--color-text-faint)]" aria-label="Has attachments" />
      ) : null}
      {card.comments?.length ? (
        <span
          className="inline-flex items-center gap-1 text-[10.5px] tabular-nums text-[var(--color-text-faint)]"
          title={`${card.comments.length} comment${card.comments.length === 1 ? '' : 's'}`}
        >
          <MessageSquare className="size-3" />
          {card.comments.length}
        </span>
      ) : null}
      {card.weight !== undefined ? (
        <span
          className="rounded bg-[var(--color-bg-muted)] px-1 text-[10px] font-medium tabular-nums text-[var(--color-text-muted)]"
          title={`Weight ${card.weight}`}
        >
          {card.weight}
        </span>
      ) : null}
      {hideAssignees || !card.assignees?.length ? null : (
        <span className="ml-auto pl-1">
          <AssigneeStack emails={card.assignees} />
        </span>
      )}
    </span>
  );
}

function formatTimelineTime(ts: number): string {
  return new Date(ts).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function emailInitials(email: string): string {
  const name = email.split('@')[0] || email;
  const parts = name.split(/[.\-_]+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return name.slice(0, 2).toUpperCase();
}

function CardFace({ card, fallbackTitle }: { card?: BoardCard; fallbackTitle: string }) {
  const done = Boolean(card?.completedAt);
  const hasMeta =
    card &&
    (card.priority ||
      card.labels?.length ||
      card.dueAt ||
      card.source?.threadId ||
      card.sourceThreadId ||
      card.source?.eventId ||
      card.sourceCalendarEventId ||
      card.attachments?.length ||
      card.comments?.length ||
      card.weight !== undefined ||
      card.assignees?.length);
  return (
    <div className="space-y-2">
      {/* pr-5 leaves room for the hover "mark done" toggle at the top-right corner. */}
      <p
        className={cn(
          'pr-5 text-[13.5px] font-semibold leading-snug text-[var(--color-text)]',
          done && 'text-[var(--color-text-faint)] line-through',
        )}
      >
        {card?.title || fallbackTitle}
      </p>
      {card?.description ? (
        <p className="line-clamp-2 text-[11.5px] leading-snug text-[var(--color-text-muted)]">
          {card.description}
        </p>
      ) : null}
      {hasMeta ? (
        <div className="flex flex-wrap items-center gap-1.5">
          <CardMetaChips card={card} />
        </div>
      ) : null}
    </div>
  );
}

// Full-height detail panel, in the same spirit as the email reader pane:
// the card opens beside the board, not over it.
function formatBytes(bytes?: number): string | null {
  if (!bytes || bytes <= 0) return null;
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i += 1;
  }
  return `${value >= 10 || i === 0 ? Math.round(value) : value.toFixed(1)} ${units[i]}`;
}

// Pick an icon + human kind for an attachment from its mime type / extension.
function attachmentVisual(att: CardAttachment): {
  Icon: typeof FileIcon;
  kind: string;
  isImage: boolean;
} {
  const ct = (att.contentType || '').toLowerCase();
  const name = att.name || att.url || '';
  const ext = name.includes('.') ? name.split('.').pop()?.toLowerCase() || '' : '';
  const isImage =
    ct.startsWith('image/') ||
    ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'avif', 'heic', 'bmp'].includes(ext);
  if (isImage) return { Icon: FileImage, kind: 'Image', isImage: true };
  if (ct === 'application/pdf' || ext === 'pdf') return { Icon: FileText, kind: 'PDF', isImage: false };
  if (ct.includes('spreadsheet') || ['xls', 'xlsx', 'csv', 'numbers'].includes(ext))
    return { Icon: FileSpreadsheet, kind: 'Sheet', isImage: false };
  if (['zip', 'tar', 'gz', 'tgz', 'rar', '7z'].includes(ext))
    return { Icon: FileArchive, kind: 'Archive', isImage: false };
  if (ct.startsWith('text/') || ['doc', 'docx', 'txt', 'md', 'rtf', 'pages'].includes(ext))
    return { Icon: FileText, kind: 'Document', isImage: false };
  if (!att.storageId && att.url) {
    let host = '';
    try {
      host = new URL(att.url).hostname.replace(/^www\./, '');
    } catch {
      host = 'Link';
    }
    return { Icon: Link2, kind: host || 'Link', isImage: false };
  }
  return { Icon: FileIcon, kind: ext ? ext.toUpperCase() : 'File', isImage: false };
}

// Shared attachment surface: drag-and-drop dropzone, link adder, and a grid of
// rich attachment tiles (image previews, type icons, sizes). Used by both the
// open-card panel and the create-card dialog so they stay visually identical.
function CardAttachments({
  attachments,
  canEdit,
  uploading,
  onUploadFiles,
  onAddLink,
  onRemove,
}: {
  attachments: CardAttachment[];
  canEdit: boolean;
  uploading: boolean;
  onUploadFiles: (files: File[]) => void;
  onAddLink: (att: CardAttachment) => void;
  onRemove: (index: number) => void;
}) {
  const [attachName, setAttachName] = useState('');
  const [attachUrl, setAttachUrl] = useState('');
  const [dragOver, setDragOver] = useState(false);
  const [linkOpen, setLinkOpen] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const linkLabelId = useId();
  const linkUrlId = useId();

  const submitLink = () => {
    const url = normalizeUrl(attachUrl);
    if (!url) return;
    onAddLink({ name: attachName.trim() || url, url });
    setAttachName('');
    setAttachUrl('');
    setLinkOpen(false);
  };

  return (
    <section className="space-y-2.5">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <h3 className="text-[12px] font-medium text-[var(--color-text-muted)]">Attachments</h3>
          {attachments.length ? (
            <span className="rounded-full bg-[var(--color-bg-muted)] px-1.5 text-[10px] text-[var(--color-text-faint)]">
              {attachments.length}
            </span>
          ) : null}
        </div>
        {canEdit ? (
          <div className="flex items-center gap-0.5">
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={uploading}
              title="Attach a file"
              className="inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-[11.5px] text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-bg-muted)] hover:text-[var(--color-text)] disabled:opacity-60"
            >
              <Paperclip className="size-3.5" />
              {uploading ? 'Uploading…' : 'Attach'}
            </button>
            <button
              type="button"
              onClick={() => setLinkOpen((open) => !open)}
              title="Add a link"
              className={cn(
                'inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-[11.5px] transition-colors hover:bg-[var(--color-bg-muted)] hover:text-[var(--color-text)]',
                linkOpen ? 'text-[var(--color-text)]' : 'text-[var(--color-text-muted)]',
              )}
            >
              <Link2 className="size-3.5" /> Link
            </button>
          </div>
        ) : null}
      </div>

      <input
        ref={fileInputRef}
        type="file"
        multiple
        className="hidden"
        onChange={(event) => {
          const files = Array.from(event.target.files || []);
          if (files.length) onUploadFiles(files);
          event.target.value = '';
        }}
      />

      {/* The whole list region is a drop target; the dashed overlay only shows while dragging. */}
      {/* biome-ignore lint/a11y/noStaticElementInteractions: drag-and-drop dropzone, the Attach button handles the click path */}
      <div
        onDragOver={
          canEdit
            ? (event) => {
                event.preventDefault();
                setDragOver(true);
              }
            : undefined
        }
        onDragLeave={canEdit ? () => setDragOver(false) : undefined}
        onDrop={
          canEdit
            ? (event) => {
                event.preventDefault();
                setDragOver(false);
                const files = Array.from(event.dataTransfer.files || []);
                if (files.length) onUploadFiles(files);
              }
            : undefined
        }
        className={cn(
          'relative space-y-1.5 rounded-xl transition-colors',
          dragOver && 'outline-2 outline-dashed -outline-offset-2 outline-[var(--color-accent)]',
        )}
      >
        {attachments.length ? (
          <ul className="space-y-1.5">
            {attachments.map((attachment, index) => {
              const { Icon, kind, isImage } = attachmentVisual(attachment);
              const meta = [kind, formatBytes(attachment.size)].filter(Boolean).join(' · ');
              return (
                <li
                  key={attachment.storageId || attachment.url || `${attachment.name}-${index}`}
                  className="group relative flex items-center gap-3 overflow-hidden rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-subtle)]/50 p-2 transition-colors hover:border-[var(--color-border-strong)] hover:bg-[var(--color-bg-subtle)]"
                >
                  {isImage && attachment.url ? (
                    // biome-ignore lint/performance/noImgElement: storage/remote thumbnail, not a static asset
                    <img
                      src={attachment.url}
                      alt={attachment.name}
                      className="size-10 shrink-0 rounded-md object-cover"
                    />
                  ) : (
                    <span className="grid size-10 shrink-0 place-items-center rounded-md bg-[var(--color-bg-muted)] text-[var(--color-text-muted)]">
                      <Icon className="size-[18px]" />
                    </span>
                  )}
                  <div className="min-w-0 flex-1">
                    {attachment.url ? (
                      <a
                        href={attachment.url}
                        target="_blank"
                        rel="noreferrer noopener"
                        className="block truncate text-[12.5px] font-medium text-[var(--color-text)] hover:text-[var(--color-accent)]"
                        title={attachment.name}
                      >
                        {attachment.name || attachment.url}
                      </a>
                    ) : (
                      <span className="block truncate text-[12.5px] font-medium text-[var(--color-text)]">
                        {attachment.name}
                      </span>
                    )}
                    {meta ? (
                      <span className="text-[10.5px] text-[var(--color-text-faint)]">{meta}</span>
                    ) : null}
                  </div>
                  <div className="flex shrink-0 items-center gap-0.5">
                    {attachment.url ? (
                      <a
                        href={attachment.url}
                        {...(attachment.storageId
                          ? { download: attachment.name }
                          : { target: '_blank', rel: 'noreferrer noopener' })}
                        className="grid size-7 place-items-center rounded-md text-[var(--color-text-faint)] hover:bg-[var(--color-bg-muted)] hover:text-[var(--color-text)]"
                        title={attachment.storageId ? 'Download' : 'Open'}
                      >
                        {attachment.storageId ? (
                          <Download className="size-3.5" />
                        ) : (
                          <ExternalLink className="size-3.5" />
                        )}
                      </a>
                    ) : null}
                    {canEdit ? (
                      <button
                        type="button"
                        onClick={() => onRemove(index)}
                        className="grid size-7 place-items-center rounded-md text-[var(--color-text-faint)] opacity-0 transition-opacity hover:bg-[var(--color-bg-muted)] hover:text-[var(--color-danger)] focus-visible:opacity-100 group-hover:opacity-100"
                        title="Remove attachment"
                      >
                        <X className="size-3.5" />
                      </button>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ul>
        ) : null}

        {linkOpen && canEdit ? (
          // biome-ignore lint/a11y/noStaticElementInteractions: scopes Escape for every control in the inline form so it doesn't close the whole drawer
          <div
            className="flex flex-col gap-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-subtle)]/50 p-2"
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.stopPropagation();
                setLinkOpen(false);
              }
            }}
          >
            <label htmlFor={linkLabelId} className="sr-only">
              Link label
            </label>
            <Input
              id={linkLabelId}
              value={attachName}
              onChange={(event) => setAttachName(event.target.value)}
              placeholder="Label (optional)"
              className="h-8 bg-[var(--color-bg-elevated)] text-[12px]"
            />
            <label htmlFor={linkUrlId} className="sr-only">
              Link URL
            </label>
            <div className="flex gap-2">
              <Input
                id={linkUrlId}
                value={attachUrl}
                onChange={(event) => setAttachUrl(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    submitLink();
                  }
                }}
                placeholder="https://example.com/page"
                autoFocus
                className="h-8 flex-1 bg-[var(--color-bg-elevated)] text-[12px]"
              />
              <Button
                type="button"
                size="sm"
                className="h-8 px-3 text-[12px]"
                disabled={!normalizeUrl(attachUrl)}
                onClick={submitLink}
              >
                Add
              </Button>
            </div>
          </div>
        ) : null}

        {!attachments.length && !linkOpen ? (
          canEdit ? (
            <div className="flex items-center gap-2 rounded-lg border border-dashed border-[var(--color-border)] px-3 py-2.5 text-[12px] text-[var(--color-text-faint)]">
              <UploadCloud className="size-3.5 shrink-0" />
              Drag files here, or use Attach / Link above.
            </div>
          ) : (
            <p className="text-[11.5px] text-[var(--color-text-faint)]">Nothing attached.</p>
          )
        ) : null}
      </div>
    </section>
  );
}

type MarkdownMode = 'write' | 'preview';

const markdownClass =
  'space-y-2 text-[13.5px] leading-relaxed text-[var(--color-text)] [&_a]:text-[var(--color-accent)] [&_a]:underline [&_a]:underline-offset-2 [&_blockquote]:border-l-2 [&_blockquote]:border-[var(--color-border)] [&_blockquote]:pl-3 [&_blockquote]:text-[var(--color-text-muted)] [&_code]:rounded [&_code]:bg-[var(--color-bg-muted)] [&_code]:px-1 [&_code]:py-0.5 [&_h1]:font-display [&_h1]:text-xl [&_h1]:font-semibold [&_h2]:font-display [&_h2]:text-lg [&_h2]:font-semibold [&_h3]:font-semibold [&_ol]:ml-5 [&_ol]:list-decimal [&_pre]:overflow-x-auto [&_pre]:rounded-lg [&_pre]:bg-[var(--color-bg-muted)] [&_pre]:p-3 [&_ul]:ml-5 [&_ul]:list-disc';

function MarkdownEditor({
  value,
  onChange,
  disabled,
  placeholder,
  minHeight = 'min-h-40',
  mode,
  onModeChange,
  autoFocus,
}: {
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  placeholder: string;
  minHeight?: string;
  mode: MarkdownMode;
  onModeChange: (mode: MarkdownMode) => void;
  autoFocus?: boolean;
}) {
  const showWrite = !disabled && mode === 'write';
  return (
    <div className="overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-subtle)]/40">
      <div className="flex items-center justify-between border-b border-[var(--color-border)] px-2 py-1.5">
        <div className="flex rounded-md bg-[var(--color-bg-muted)] p-0.5">
          {(['write', 'preview'] as const).map((tab) => (
            <button
              key={tab}
              type="button"
              onClick={() => onModeChange(tab)}
              className={cn(
                'h-6 rounded px-2 text-[11px] font-medium capitalize transition-colors',
                mode === tab
                  ? 'bg-[var(--color-bg-elevated)] text-[var(--color-text)] shadow-[var(--shadow-soft)]'
                  : 'text-[var(--color-text-muted)] hover:text-[var(--color-text)]',
              )}
            >
              {tab}
            </button>
          ))}
        </div>
        <span className="text-[10.5px] text-[var(--color-text-faint)]">Markdown</span>
      </div>
      {showWrite ? (
        <textarea
          // biome-ignore lint/a11y/noAutofocus: editor mounts only after an explicit edit affordance is clicked
          autoFocus={autoFocus}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder={placeholder}
          className={cn(
            minHeight,
            'w-full resize-y border-0 bg-transparent px-3.5 py-3 text-[13.5px] leading-relaxed outline-none placeholder:text-[var(--color-text-faint)]',
          )}
        />
      ) : (
        <div className={cn(minHeight, 'px-3.5 py-3')}>
          {value.trim() ? (
            <Markdown className={markdownClass}>{value}</Markdown>
          ) : (
            <p className="text-[13px] text-[var(--color-text-faint)]">{placeholder}</p>
          )}
        </div>
      )}
    </div>
  );
}

function CardPanel({
  card,
  canEdit,
  role,
  assignable,
  onClose,
}: {
  card: BoardCard;
  canEdit: boolean;
  role: 'owner' | 'member' | 'viewer';
  assignable: string[];
  onClose: () => void;
}) {
  const updateCard = useConvexMutation(boardsApi.updateCard);
  const deleteCard = useConvexMutation(boardsApi.deleteCard);
  const addComment = useConvexMutation(boardsApi.addComment);
  const generateUploadUrl = useConvexMutation(boardsApi.generateAttachmentUploadUrl);
  const setPrimaryView = useClientStore((s) => s.setPrimaryView);
  const setSelectedThread = useClientStore((s) => s.setSelectedThread);
  const setThreadAccount = useClientStore((s) => s.setThreadAccount);

  const [title, setTitle] = useState(card.title);
  const [description, setDescription] = useState(card.description || '');
  const [labels, setLabels] = useState((card.labels || []).join(', '));
  const [priority, setPriority] = useState<string>(card.priority || '');
  const [weight, setWeight] = useState(card.weight !== undefined ? String(card.weight) : '');
  const [assignees, setAssignees] = useState<string[]>(card.assignees || []);
  const [due, setDue] = useState(card.dueAt ? toLocalInputValue(card.dueAt) : '');
  const [commentDraft, setCommentDraft] = useState('');
  const [descriptionMode, setDescriptionMode] = useState<MarkdownMode>('write');
  const [commentMode, setCommentMode] = useState<MarkdownMode>('write');
  const [editingNotes, setEditingNotes] = useState(false);
  const [composingComment, setComposingComment] = useState(false);
  const [commentSubmitting, setCommentSubmitting] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [portalReady, setPortalReady] = useState(false);
  const onCloseRef = useRef(onClose);
  const done = Boolean(card.completedAt);

  onCloseRef.current = onClose;

  // Comments and activity events are a single chronological timeline (a comment
  // is just one kind of timeline node); oldest first so the newest sits next to
  // the composer at the bottom.
  type TimelineNode =
    | { kind: 'comment'; id: string; who?: string; at: number; body: string }
    | { kind: 'activity'; id: string; who?: string; at: number; action: string; detail?: string };
  const timeline = useMemo<TimelineNode[]>(() => {
    const nodes: TimelineNode[] = [];
    for (const c of card.comments || [])
      nodes.push({ kind: 'comment', id: `c-${c.id}`, who: c.authorEmail, at: c.createdAt, body: c.body });
    // `commented` activities mirror entries already in card.comments, so skip
    // them here to avoid rendering every comment twice in the timeline.
    for (const a of card.activity || [])
      if (a.action !== 'commented')
        nodes.push({
          kind: 'activity',
          id: `a-${a.id}`,
          who: a.actorEmail,
          at: a.createdAt,
          action: a.action,
          detail: a.detail,
        });
    nodes.sort((x, y) => x.at - y.at);
    return nodes;
  }, [card.comments, card.activity]);

  // Always (re)enter editors in write mode — a leftover `preview` from a prior
  // session would otherwise reopen read-only and the autofocus never engages.
  const openNotesEditor = () => {
    setDescriptionMode('write');
    setEditingNotes(true);
  };
  const openComposer = () => {
    setCommentMode('write');
    setComposingComment(true);
  };

  // Strip the read-time-resolved URL off stored files so we never persist a
  // serving URL next to its storage id (it's re-resolved on every read).
  const persistable = (list: CardAttachment[]) =>
    list.map(({ name, url, storageId, contentType, size }) => ({
      name,
      url: storageId ? undefined : url,
      storageId,
      contentType,
      size,
    }));

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
        weight: weight === '' ? null : Number(weight),
        assignees,
        dueAt: due ? new Date(due).getTime() : null,
      });
      toast.success('Saved');
    } catch (err: any) {
      toast.error(err?.message || 'Could not save card');
    }
  };

  const addAttachment = async (attachment: CardAttachment) => {
    try {
      await updateCard({
        cardId: card.cardId,
        attachments: [...persistable(card.attachments || []), attachment],
      });
    } catch (err: any) {
      toast.error(err?.message || 'Could not attach');
    }
  };

  const removeAttachment = (index: number) => {
    void updateCard({
      cardId: card.cardId,
      attachments: persistable((card.attachments || []).filter((_, i) => i !== index)),
    }).catch((err: any) => toast.error(err?.message || 'Could not remove'));
  };

  const uploadFiles = async (files: File[]) => {
    setUploading(true);
    try {
      for (const file of files) {
        const uploadUrl = await generateUploadUrl({ cardId: card.cardId });
        const response = await fetch(uploadUrl as string, {
          method: 'POST',
          headers: { 'Content-Type': file.type || 'application/octet-stream' },
          body: file,
        });
        if (!response.ok) throw new Error(`Upload failed (${response.status})`);
        const { storageId } = (await response.json()) as { storageId: string };
        await addAttachment({
          name: file.name,
          storageId,
          contentType: file.type || undefined,
          size: file.size || undefined,
        });
      }
      toast.success(files.length > 1 ? `Uploaded ${files.length} files` : `Uploaded ${files[0]?.name}`);
    } catch (err: any) {
      toast.error(err?.message || 'Upload failed');
    } finally {
      setUploading(false);
    }
  };

  // Escape closes the panel, and body scroll stays locked while it is open.
  useEffect(() => {
    setPortalReady(true);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onCloseRef.current();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener('keydown', onKey);
    };
  }, []);

  if (!portalReady) return null;

  return createPortal(
    <>
      <motion.button
        type="button"
        aria-label="Close card"
        className="fixed inset-0 z-[70] cursor-default bg-black/50 backdrop-blur-[2px]"
        onClick={onClose}
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.18 }}
      />
      <motion.div
        role="dialog"
        aria-modal="true"
        aria-label={card.title}
        className="fixed inset-y-0 right-0 z-[80] flex h-auto w-[calc(100vw-24px)] flex-col overflow-hidden rounded-l-2xl border-l border-[var(--color-border)] bg-[var(--color-bg-elevated)] shadow-[-24px_0_80px_-12px_rgb(0_0_0/0.45)] sm:w-[min(calc(100vw-72px),1280px)]"
        initial={{ opacity: 0.3, x: 72 }}
        animate={{ opacity: 1, x: 0 }}
        exit={{ opacity: 0, x: 56 }}
        transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
      >
        <header className="flex items-center gap-3 border-b border-[var(--color-border)] px-5 py-3">
          <input
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            disabled={!canEdit}
            placeholder="Card title"
            aria-label="Card title"
            className="min-w-0 flex-1 border-none bg-transparent font-display text-[16px] font-semibold leading-tight text-[var(--color-text)] outline-none placeholder:text-[var(--color-text-faint)] disabled:opacity-100"
          />
          {done ? (
            <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-[var(--color-accent-soft)] px-2 py-0.5 text-[10.5px] font-medium text-[var(--color-accent)]">
              Done
            </span>
          ) : null}
          <div className="flex shrink-0 items-center gap-2">
            {canEdit ? (
              <Button type="button" size="sm" className="h-8 px-3 text-[12px]" onClick={save}>
                Save
              </Button>
            ) : null}
            {canEdit ? (
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-8 px-3 text-[12px]"
                onClick={async () => {
                  try {
                    await updateCard({ cardId: card.cardId, completedAt: done ? null : Date.now() });
                  } catch (err: any) {
                    toast.error(err?.message || 'Could not update card');
                  }
                }}
              >
                {done ? 'Reopen' : 'Mark done'}
              </Button>
            ) : null}
            {canEdit ? (
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button
                    type="button"
                    size="icon-sm"
                    variant="ghost"
                    className="size-8 text-[var(--color-text-muted)] hover:text-[var(--color-danger)]"
                    title="Delete card"
                  >
                    <Trash2 className="size-4" />
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>Delete this card?</AlertDialogTitle>
                    <AlertDialogDescription>“{card.title}” will be removed.</AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>Cancel</AlertDialogCancel>
                    <AlertDialogAction
                      onClick={async () => {
                        try {
                          await deleteCard({ cardId: card.cardId });
                          onClose();
                        } catch (err: any) {
                          toast.error(err?.message || 'Could not delete card');
                        }
                      }}
                    >
                      Delete
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            ) : null}
            <button
              type="button"
              onClick={onClose}
              className="grid size-8 place-items-center rounded-md text-[var(--color-text-faint)] hover:bg-[var(--color-bg-muted)] hover:text-[var(--color-text)]"
              title="Close (Esc)"
            >
              <X className="size-4" />
            </button>
          </div>
        </header>

        <div className="grid min-h-0 flex-1 grid-cols-1 overflow-hidden md:grid-cols-[1fr_310px]">
          {/* Main column — one continuous timeline: the description card heads
              the spine, comments + activity hang off it, and the composer card
              terminates it. The connecting line never breaks. */}
          <div className="min-h-0 overflow-y-auto px-6 py-5">
            <section className="pb-2">
              <ol className="space-y-0">
                {/* Description — the first node, wrapped in its own card so it's
                    unmistakably the description. View-first: double-click to edit. */}
                <li className="relative flex gap-3 pb-4">
                  <span
                    aria-hidden
                    className="absolute bottom-0 left-[14px] top-4 w-px -translate-x-1/2 bg-[var(--color-border)]"
                  />
                  <span
                    className="relative z-10 mt-0.5 grid size-7 shrink-0 place-items-center rounded-full border border-[var(--color-border)] bg-[var(--color-bg-elevated)] text-[var(--color-text-muted)] shadow-[var(--shadow-soft)]"
                    aria-hidden
                  >
                    <FileText className="size-3.5" />
                  </span>
                  <div className="min-w-0 flex-1">
                    {canEdit && editingNotes ? (
                      <div className="space-y-1.5">
                        <div className="flex items-center justify-between">
                          <span className="text-[11px] font-medium text-[var(--color-text-muted)]">
                            Description
                          </span>
                          <button
                            type="button"
                            onClick={() => setEditingNotes(false)}
                            className="text-[11px] text-[var(--color-text-faint)] transition-colors hover:text-[var(--color-text)]"
                          >
                            Done
                          </button>
                        </div>
                        <MarkdownEditor
                          value={description}
                          onChange={setDescription}
                          placeholder="Add details, context, or a checklist (markdown supported)…"
                          mode={descriptionMode}
                          onModeChange={setDescriptionMode}
                          autoFocus
                        />
                      </div>
                    ) : (
                      <div className="overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-subtle)]/40">
                        <div className="flex items-center justify-between border-b border-[var(--color-border)] px-3.5 py-2">
                          <span className="text-[11px] font-medium uppercase tracking-[0.06em] text-[var(--color-text-faint)]">
                            Description
                          </span>
                          {canEdit && description.trim() ? (
                            <button
                              type="button"
                              onClick={openNotesEditor}
                              className="inline-flex items-center gap-1 text-[11px] text-[var(--color-text-faint)] transition-colors hover:text-[var(--color-text)]"
                            >
                              <Pencil className="size-3" /> Edit
                            </button>
                          ) : null}
                        </div>
                        {description.trim() ? (
                          // biome-ignore lint/a11y/noStaticElementInteractions: double-click to edit keeps links clickable on single click
                          <div
                            onDoubleClick={() => canEdit && openNotesEditor()}
                            title={canEdit ? 'Double-click to edit' : undefined}
                            className={cn('px-3.5 py-3', canEdit && 'cursor-text')}
                          >
                            <Markdown className={markdownClass}>{description}</Markdown>
                          </div>
                        ) : canEdit ? (
                          <button
                            type="button"
                            onClick={openNotesEditor}
                            className="flex w-full items-center gap-2 px-3.5 py-3 text-left text-[13px] text-[var(--color-text-faint)] transition-colors hover:text-[var(--color-text-muted)]"
                          >
                            <Pencil className="size-3.5 shrink-0" /> Add details, context, or a checklist…
                          </button>
                        ) : (
                          <p className="px-3.5 py-3 text-[13px] text-[var(--color-text-faint)]">
                            No description.
                          </p>
                        )}
                      </div>
                    )}
                  </div>
                </li>

                {timeline.map((node) => (
                  <li key={node.id} className="relative flex gap-3 pb-4">
                    {/* Spine segment: centred on the avatar, drawn behind it (z-0),
                        running the full row height so it meets the next node. */}
                    <span
                      aria-hidden
                      className="absolute bottom-0 left-[14px] top-0 w-px -translate-x-1/2 bg-[var(--color-border)]"
                    />
                    <span
                      className={cn(
                        'relative z-10 mt-0.5 grid size-7 shrink-0 place-items-center rounded-full text-[9px] font-semibold uppercase shadow-[var(--shadow-soft)]',
                        node.kind === 'comment'
                          ? 'border border-[var(--color-border)] bg-[var(--color-bg-elevated)] text-[var(--color-text-muted)]'
                          : 'border border-[var(--color-border)] bg-[var(--color-bg-subtle)] text-[var(--color-text-faint)]',
                      )}
                    >
                      {emailInitials(node.who || '?')}
                    </span>
                    {node.kind === 'comment' ? (
                      <div className="min-w-0 flex-1 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-subtle)]/50 px-3 py-2.5">
                        <div className="mb-1.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10.5px]">
                          <span className="font-medium text-[var(--color-text-muted)]">
                            {node.who || 'someone'}
                          </span>
                          <span className="text-[var(--color-text-faint)]">
                            {formatTimelineTime(node.at)}
                          </span>
                        </div>
                        <Markdown className={markdownClass}>{node.body}</Markdown>
                      </div>
                    ) : (
                      <p className="min-w-0 flex-1 self-center text-[11.5px] leading-snug text-[var(--color-text-faint)]">
                        <span className="font-medium text-[var(--color-text-muted)]">
                          {node.who || 'someone'}
                        </span>{' '}
                        {node.action}
                        {node.detail ? ` — ${node.detail}` : ''}
                        <span className="px-1 text-[var(--color-text-faint)]">·</span>
                        {formatTimelineTime(node.at)}
                      </p>
                    )}
                  </li>
                ))}

                {/* Composer = the terminal node. Everyone with access can comment
                    (viewers included); view-first, it rests as a prompt. */}
                <li className="relative flex gap-3">
                  {/* Incoming spine stub so the timeline connects into the composer
                      avatar (only drawn when there are nodes above it). */}
                  {timeline.length ? (
                    <span
                      aria-hidden
                      className="absolute left-[14px] top-0 h-4 w-px -translate-x-1/2 bg-[var(--color-border)]"
                    />
                  ) : null}
                  <span
                    className="relative z-10 mt-0.5 grid size-7 shrink-0 place-items-center rounded-full border border-[var(--color-border)] bg-[var(--color-bg-elevated)] text-[var(--color-text-faint)] shadow-[var(--shadow-soft)]"
                    aria-hidden
                  >
                    <MessageSquare className="size-3.5" />
                  </span>
                  <div className="min-w-0 flex-1">
                    {composingComment ? (
                      <form
                        className="space-y-2"
                        onSubmit={async (event) => {
                          event.preventDefault();
                          const body = commentDraft.trim();
                          if (!body || commentSubmitting) return;
                          setCommentSubmitting(true);
                          try {
                            await addComment({ cardId: card.cardId, body });
                            setCommentDraft('');
                            setComposingComment(false);
                          } catch (err: any) {
                            toast.error(err?.message || 'Could not comment');
                          } finally {
                            setCommentSubmitting(false);
                          }
                        }}
                      >
                        <MarkdownEditor
                          value={commentDraft}
                          onChange={setCommentDraft}
                          placeholder={role === 'viewer' ? 'Comment as a viewer…' : 'Add a comment…'}
                          minHeight="min-h-24"
                          mode={commentMode}
                          onModeChange={setCommentMode}
                          autoFocus
                        />
                        <div className="flex justify-end gap-2">
                          <Button
                            type="button"
                            size="sm"
                            variant="ghost"
                            className="h-9 px-3 text-[12px]"
                            onClick={() => {
                              setComposingComment(false);
                              setCommentDraft('');
                            }}
                          >
                            Cancel
                          </Button>
                          <Button
                            type="submit"
                            size="sm"
                            className="h-9 px-3 text-[12px]"
                            disabled={commentSubmitting || !commentDraft.trim()}
                          >
                            Comment
                          </Button>
                        </div>
                      </form>
                    ) : (
                      <button
                        type="button"
                        onClick={openComposer}
                        className="flex w-full items-center gap-2 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-subtle)]/40 px-3.5 py-2.5 text-left text-[13px] text-[var(--color-text-faint)] transition-colors hover:border-[var(--color-border-strong)] hover:text-[var(--color-text-muted)]"
                      >
                        {role === 'viewer' ? 'Comment as a viewer…' : 'Add a comment…'}
                      </button>
                    )}
                  </div>
                </li>
              </ol>
            </section>
          </div>

          {/* Metadata rail. */}
          <aside className="min-h-0 space-y-5 overflow-y-auto border-t border-[var(--color-border)] bg-[var(--color-bg-subtle)]/40 px-5 py-5 md:border-l md:border-t-0">
            <div className="space-y-1.5">
              <label htmlFor="card-due" className="text-[11px] font-medium text-[var(--color-text-muted)]">
                Due date
              </label>
              <Input
                id="card-due"
                type="datetime-local"
                value={due}
                onChange={(event) => setDue(event.target.value)}
                disabled={!canEdit}
                className="h-9 text-[12.5px]"
              />
            </div>

            <div className="space-y-1.5">
              <label
                htmlFor="card-priority"
                className="text-[11px] font-medium text-[var(--color-text-muted)]"
              >
                Priority
              </label>
              <select
                id="card-priority"
                value={priority}
                onChange={(event) => setPriority(event.target.value)}
                disabled={!canEdit}
                className="h-9 w-full rounded-md border border-[var(--color-border)] bg-transparent px-2.5 text-[12.5px]"
              >
                <option value="">None</option>
                <option value="low">Low</option>
                <option value="medium">Medium</option>
                <option value="high">High</option>
              </select>
            </div>

            <div className="space-y-1.5">
              <label htmlFor="card-weight" className="text-[11px] font-medium text-[var(--color-text-muted)]">
                Weight
              </label>
              <Input
                id="card-weight"
                type="number"
                min={0}
                value={weight}
                onChange={(event) => setWeight(event.target.value)}
                disabled={!canEdit}
                placeholder="—"
                className="h-9 text-[12.5px]"
              />
            </div>

            <div className="space-y-1.5">
              <label htmlFor="card-labels" className="text-[11px] font-medium text-[var(--color-text-muted)]">
                Labels
              </label>
              <Input
                id="card-labels"
                value={labels}
                onChange={(event) => setLabels(event.target.value)}
                disabled={!canEdit}
                placeholder="comma, separated"
                className="h-9 text-[12.5px]"
              />
              {labels.trim() ? (
                <div className="flex flex-wrap gap-1">
                  {labels
                    .split(',')
                    .map((label) => label.trim())
                    .filter(Boolean)
                    .map((label) => (
                      <span
                        key={label}
                        className="rounded-full bg-[var(--color-bg-muted)] px-2 py-0.5 text-[10.5px] text-[var(--color-text-muted)]"
                      >
                        {label}
                      </span>
                    ))}
                </div>
              ) : null}
            </div>

            <div className="space-y-1.5">
              <p className="text-[11px] font-medium text-[var(--color-text-muted)]">Assigned</p>
              {assignable.length ? (
                <div className="flex flex-wrap gap-1.5">
                  {assignable.map((email) => {
                    const on = assignees.includes(email);
                    return (
                      <button
                        key={email}
                        type="button"
                        disabled={!canEdit}
                        onClick={() =>
                          setAssignees(on ? assignees.filter((a) => a !== email) : [...assignees, email])
                        }
                        className={cn(
                          'inline-flex max-w-full items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] transition-colors',
                          on
                            ? 'border-[var(--color-accent)] bg-[var(--color-accent-soft)] text-[var(--color-accent)]'
                            : 'border-[var(--color-border)] text-[var(--color-text-muted)] hover:text-[var(--color-text)]',
                        )}
                      >
                        <span className="grid size-3.5 shrink-0 place-items-center rounded-full bg-[var(--color-bg-muted)] text-[8px] font-semibold uppercase">
                          {emailInitials(email)}
                        </span>
                        <span className="truncate">{email}</span>
                      </button>
                    );
                  })}
                </div>
              ) : (
                <p className="text-[11.5px] text-[var(--color-text-faint)]">
                  Share this board to assign collaborators.
                </p>
              )}
            </div>

            <CardAttachments
              attachments={card.attachments || []}
              canEdit={canEdit}
              uploading={uploading}
              onUploadFiles={uploadFiles}
              onAddLink={addAttachment}
              onRemove={removeAttachment}
            />

            {card.source?.threadId ? (
              <div className="space-y-1.5">
                <p className="text-[11px] font-medium text-[var(--color-text-muted)]">Source</p>
                <button
                  type="button"
                  onClick={() => {
                    if (card.source?.accountId) setThreadAccount(card.source.accountId);
                    setSelectedThread(card.source?.threadId || null);
                    setPrimaryView('mail');
                    onClose();
                  }}
                  className="inline-flex w-full items-center gap-1.5 rounded-lg border border-[var(--color-border)] px-2.5 py-1.5 text-left text-[11.5px] text-[var(--color-text-muted)] hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]"
                >
                  <Mail className="size-3.5 shrink-0" /> From this email — open thread
                </button>
              </div>
            ) : null}

            {card.source?.eventId || card.sourceCalendarEventId ? (
              <div className="space-y-1.5">
                <p className="text-[11px] font-medium text-[var(--color-text-muted)]">Source</p>
                <div className="space-y-1.5">
                  {card.source?.url || card.source?.htmlLink ? (
                    <a
                      href={card.source.url || card.source.htmlLink}
                      target="_blank"
                      rel="noreferrer noopener"
                      className="inline-flex w-full items-center gap-1.5 rounded-lg border border-[var(--color-border)] px-2.5 py-1.5 text-left text-[11.5px] text-[var(--color-text-muted)] hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]"
                    >
                      <ExternalLink className="size-3.5 shrink-0" />
                      {card.source?.title || 'Open calendar event'}
                    </a>
                  ) : null}
                  <button
                    type="button"
                    onClick={() => {
                      setPrimaryView('calendar');
                      onClose();
                    }}
                    className="inline-flex w-full items-center gap-1.5 rounded-lg border border-[var(--color-border)] px-2.5 py-1.5 text-left text-[11.5px] text-[var(--color-text-muted)] hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]"
                  >
                    <CalendarClock className="size-3.5 shrink-0" /> Show calendar
                  </button>
                </div>
              </div>
            ) : null}
          </aside>
        </div>
      </motion.div>
    </>,
    document.body,
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
        <DialogDescription className="sr-only">
          Invite collaborators or manage the public link.
        </DialogDescription>
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

function CreateCardDialog({
  boardId,
  columnName,
  onClose,
  onCreate,
}: {
  boardId: string;
  columnName: string;
  onClose: () => void;
  onCreate: (fields: {
    title: string;
    description?: string;
    labels?: string[];
    priority?: 'low' | 'medium' | 'high';
    weight?: number;
    dueAt?: number;
    attachments?: CardAttachment[];
  }) => void;
}) {
  const generateUploadUrl = useConvexMutation(boardsApi.generateAttachmentUploadUrl);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [labels, setLabels] = useState('');
  const [priority, setPriority] = useState('');
  const [weight, setWeight] = useState('');
  const [due, setDue] = useState('');
  const [attachments, setAttachments] = useState<CardAttachment[]>([]);
  const [uploading, setUploading] = useState(false);
  const [nlText, setNlText] = useState('');
  const [parsing, setParsing] = useState(false);

  // Natural-language quick-add: parse one line into the structured fields below
  // (the user still reviews + confirms before the card is created).
  const parseNl = async () => {
    const text = nlText.trim();
    if (!text || parsing) return;
    setParsing(true);
    try {
      const r = await callTool<{
        title: string;
        dueAt: number | null;
        priority: 'low' | 'medium' | 'high' | null;
        labels: string[];
        description: string | null;
        model: string;
      }>('nl_task', { text, now: localIsoWithOffset() });
      // Replace (not merge) every field so re-running Autofill after editing the
      // sentence can't leave stale due/priority/labels/description behind.
      if (r.title) setTitle(r.title);
      setDescription(r.description || '');
      setPriority(r.priority || '');
      setLabels(r.labels?.length ? r.labels.join(', ') : '');
      setDue(r.dueAt ? toLocalInputValue(r.dueAt) : '');
      setNlText('');
      if (r.model === 'local') {
        toast.message('Used your text as the title — enable AI in settings for date/priority parsing.');
      }
    } catch (err: any) {
      toast.error(err?.message || 'Could not parse that');
    } finally {
      setParsing(false);
    }
  };

  const uploadFiles = async (files: File[]) => {
    setUploading(true);
    try {
      for (const file of files) {
        const uploadUrl = await generateUploadUrl({ boardId });
        const response = await fetch(uploadUrl as string, {
          method: 'POST',
          headers: { 'Content-Type': file.type || 'application/octet-stream' },
          body: file,
        });
        if (!response.ok) throw new Error(`Upload failed (${response.status})`);
        const { storageId } = (await response.json()) as { storageId: string };
        setAttachments((prev) => [
          ...prev,
          {
            name: file.name,
            storageId,
            contentType: file.type || undefined,
            size: file.size || undefined,
          },
        ]);
      }
    } catch (err: any) {
      toast.error(err?.message || 'Upload failed');
    } finally {
      setUploading(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogTitle>New card in {columnName}</DialogTitle>
        <DialogDescription className="sr-only">Fill in the card details.</DialogDescription>
        <form
          className="space-y-3"
          onSubmit={(event) => {
            event.preventDefault();
            const trimmed = title.trim();
            if (!trimmed) return;
            onCreate({
              title: trimmed,
              description: description.trim() || undefined,
              labels: labels
                .split(',')
                .map((label) => label.trim())
                .filter(Boolean),
              priority: (priority || undefined) as any,
              weight: weight ? Number(weight) : undefined,
              dueAt: due ? new Date(due).getTime() : undefined,
              attachments: attachments.length ? attachments : undefined,
            });
          }}
        >
          {/* Natural-language quick-add — parses into the fields below. */}
          <div className="space-y-1.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-subtle)]/40 p-2">
            <div className="flex gap-2">
              <Input
                value={nlText}
                onChange={(event) => setNlText(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    void parseNl();
                  }
                }}
                placeholder={'Type naturally — e.g. "Pay AT&T bill Tuesday, high priority"'}
                className="h-9 bg-[var(--color-bg-elevated)] text-[13px]"
              />
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-9 shrink-0 gap-1.5 px-2.5 text-[12px]"
                onClick={() => void parseNl()}
                disabled={parsing || !nlText.trim()}
              >
                <Sparkles className="size-3.5" /> {parsing ? 'Reading…' : 'Autofill'}
              </Button>
            </div>
            <p className="px-0.5 text-[11px] text-[var(--color-text-faint)]">
              Fills in the details below — review, then create.
            </p>
          </div>

          <Input
            autoFocus
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder="What needs doing?"
            className="h-9 text-[13.5px]"
          />
          <textarea
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            placeholder="Notes (markdown)"
            className="min-h-20 w-full rounded-md border border-[var(--color-border)] bg-transparent px-2.5 py-2 text-[13px] leading-relaxed"
          />
          <div className="grid grid-cols-3 gap-2">
            <label htmlFor="new-card-due" className="space-y-1 text-[11px] text-[var(--color-text-muted)]">
              Due
              <Input
                id="new-card-due"
                type="datetime-local"
                value={due}
                onChange={(event) => setDue(event.target.value)}
                className="h-8 text-[12px]"
              />
            </label>
            <label
              htmlFor="new-card-priority"
              className="space-y-1 text-[11px] text-[var(--color-text-muted)]"
            >
              Priority
              <select
                id="new-card-priority"
                value={priority}
                onChange={(event) => setPriority(event.target.value)}
                className="h-8 w-full rounded-md border border-[var(--color-border)] bg-transparent px-2 text-[12.5px]"
              >
                <option value="">None</option>
                <option value="low">Low</option>
                <option value="medium">Medium</option>
                <option value="high">High</option>
              </select>
            </label>
            <label htmlFor="new-card-weight" className="space-y-1 text-[11px] text-[var(--color-text-muted)]">
              Weight
              <Input
                id="new-card-weight"
                type="number"
                min={0}
                value={weight}
                onChange={(event) => setWeight(event.target.value)}
                className="h-8 text-[12.5px]"
              />
            </label>
          </div>
          <label
            htmlFor="new-card-labels"
            className="block space-y-1 text-[11px] text-[var(--color-text-muted)]"
          >
            Labels (comma-separated)
            <Input
              id="new-card-labels"
              value={labels}
              onChange={(event) => setLabels(event.target.value)}
              className="h-8 text-[12.5px]"
            />
          </label>
          <CardAttachments
            attachments={attachments}
            canEdit
            uploading={uploading}
            onUploadFiles={uploadFiles}
            onAddLink={(att) => setAttachments((prev) => [...prev, att])}
            onRemove={(index) => setAttachments((prev) => prev.filter((_, i) => i !== index))}
          />
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-8 px-3 text-[12.5px]"
              onClick={onClose}
            >
              Cancel
            </Button>
            <Button type="submit" size="sm" className="h-8 px-3 text-[12.5px]">
              Add card
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function NameDialog({
  open,
  title,
  placeholder,
  submitLabel,
  initialValue = '',
  onClose,
  onSubmit,
}: {
  open: boolean;
  title: string;
  placeholder: string;
  submitLabel: string;
  initialValue?: string;
  onClose: () => void;
  onSubmit: (value: string) => void;
}) {
  const [value, setValue] = useState(initialValue);
  useEffect(() => {
    if (open) setValue(initialValue);
  }, [open, initialValue]);
  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="max-w-sm">
        <DialogTitle>{title}</DialogTitle>
        <DialogDescription className="sr-only">{placeholder}</DialogDescription>
        <form
          className="space-y-3"
          onSubmit={(event) => {
            event.preventDefault();
            const trimmed = value.trim();
            if (!trimmed) return;
            onSubmit(trimmed);
            onClose();
          }}
        >
          <Input
            autoFocus
            value={value}
            onChange={(event) => setValue(event.target.value)}
            placeholder={placeholder}
            className="h-9 text-[13px]"
          />
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-8 px-3 text-[12.5px]"
              onClick={onClose}
            >
              Cancel
            </Button>
            <Button type="submit" size="sm" className="h-8 px-3 text-[12.5px]">
              {submitLabel}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function toLocalInputValue(epoch: number): string {
  const date = new Date(epoch);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

// Current time as an ISO 8601 string carrying the user's local UTC offset, so
// the nl_task model resolves "tomorrow"/"next Tuesday" against the right day
// (a bare toISOString() is UTC and shifts the day near midnight off-UTC).
function localIsoWithOffset(date = new Date()): string {
  const pad = (n: number) => String(Math.floor(Math.abs(n))).padStart(2, '0');
  const offsetMin = -date.getTimezoneOffset();
  const sign = offsetMin >= 0 ? '+' : '-';
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}` +
    `${sign}${pad(offsetMin / 60)}:${pad(offsetMin % 60)}`
  );
}
