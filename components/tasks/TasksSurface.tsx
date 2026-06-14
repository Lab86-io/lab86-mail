'use client';

import { useMutation as useConvexMutation, useQuery_experimental as useConvexQuery } from 'convex/react';
import {
  CalendarClock,
  Check,
  CheckCircle2,
  Download,
  ExternalLink,
  FileArchive,
  File as FileIcon,
  FileImage,
  FileSpreadsheet,
  FileText,
  Flag,
  GripVertical,
  History,
  LayoutList,
  Link2,
  Mail,
  MoreHorizontal,
  Paperclip,
  Pencil,
  Plus,
  Scale,
  Share2,
  SquareKanban,
  Tag,
  Trash2,
  UploadCloud,
  Users,
  X,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
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
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from '@/components/ui/input-group';
import { api } from '@/convex/_generated/api';
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
  source?: { kind: string; accountId?: string; threadId?: string; messageId?: string };
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

export function TasksSurface() {
  const [selectedBoardId, setSelectedBoardId] = useState<string | null>(null);
  const [newBoardOpen, setNewBoardOpen] = useState(false);
  const [renameBoardOpen, setRenameBoardOpen] = useState(false);

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
  const updateColumn = useConvexMutation(boardsApi.updateColumn);
  const deleteColumn = useConvexMutation(boardsApi.deleteColumn);

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

  const handleDragEnd = (event: DragEndEvent) => {
    if (!board || !canEdit) return;
    const cardId = String(event.active.id);
    const previous = cardsById.get(cardId);
    const local = items.find((item) => item.id === cardId);
    if (!previous || !local) return;
    const targetColumn = local.column;
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
        <div className="flex items-center gap-2 px-5 py-2">
          <span className="text-[12px] text-[var(--color-text-faint)]">
            {board.cards.length} card{board.cards.length === 1 ? '' : 's'}
            {board.role !== 'owner' ? ` · shared with you (${board.role})` : ''}
          </span>
          <div className="ml-auto flex items-center gap-1.5">
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
          </div>
        </div>

        {viewMode === 'kanban' ? (
          <div className="min-h-0 flex-1 overflow-x-auto px-5 pb-5">
            <KanbanProvider
              columns={columns}
              data={items}
              onDataChange={setItems}
              onColumnsChange={canEdit ? setColumns : undefined}
              onColumnDragEnd={canEdit ? (_event, nextColumns) => persistColumnOrder(nextColumns) : undefined}
              onDragEnd={handleDragEnd}
              className="h-full min-w-fit"
            >
              {(column) => (
                <KanbanBoard
                  id={column.id}
                  key={column.id}
                  className="h-full w-72 shrink-0 bg-[var(--color-bg-subtle)]"
                >
                  <KanbanHeader className="flex items-center px-3 py-2">
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
                  <KanbanCards id={column.id}>
                    {(item: any) => {
                      const card = cardsById.get(item.id);
                      return (
                        <KanbanCard key={item.id} {...item} onCardClick={() => setOpenCardId(item.id)}>
                          {/* Native button = keyboard activation for free.
                              Pointer taps still route through the wrapper's
                              onCardClick (drag-aware); both just set the same
                              open state, so double-firing is harmless. */}
                          <button
                            type="button"
                            aria-label={`Open card: ${card?.title || item.name}`}
                            onClick={() => setOpenCardId(item.id)}
                            className="block w-full rounded-sm text-left outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]"
                          >
                            <CardFace card={card} fallbackTitle={item.name} />
                          </button>
                        </KanbanCard>
                      );
                    }}
                  </KanbanCards>
                  {canEdit ? (
                    <button
                      type="button"
                      onClick={() => setCreateInColumn(column.id)}
                      className="mx-2 mb-2 mt-auto inline-flex h-9 items-center justify-center gap-1.5 rounded-md border border-[var(--color-accent)] bg-[var(--color-accent-soft)] px-3 text-[12.5px] font-medium text-[var(--color-accent)] shadow-[var(--shadow-soft)] transition-colors hover:bg-[var(--color-accent)] hover:text-[var(--color-accent-foreground)]"
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

      {openCard ? (
        <CardPanel
          card={openCard}
          canEdit={canEdit}
          role={board.role}
          assignable={[
            ...new Set(
              [board.ownerEmail, ...board.members.map((member) => member.email)].filter(Boolean) as string[],
            ),
          ]}
          onClose={() => setOpenCardId(null)}
        />
      ) : null}

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
    <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-6">
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

function CardMetaChips({ card }: { card?: BoardCard }) {
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
      {card.source?.threadId ? (
        <Mail className="size-3 text-[var(--color-text-faint)]" aria-label="From an email" />
      ) : null}
      {card.attachments?.length ? (
        <Paperclip className="size-3 text-[var(--color-text-faint)]" aria-label="Has attachments" />
      ) : null}
      {card.comments?.length ? (
        <span className="text-[10px] tabular-nums text-[var(--color-text-faint)]">
          💬 {card.comments.length}
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
      {(card.assignees || []).slice(0, 3).map((email) => (
        <span
          key={email}
          title={email}
          className="grid size-4 place-items-center rounded-full bg-[var(--color-accent-soft)] text-[8px] font-semibold uppercase text-[var(--color-accent)]"
        >
          {emailInitials(email)}
        </span>
      ))}
    </span>
  );
}

function emailInitials(email: string): string {
  const name = email.split('@')[0] || email;
  const parts = name.split(/[.\-_]+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return name.slice(0, 2).toUpperCase();
}

function CardFace({ card, fallbackTitle }: { card?: BoardCard; fallbackTitle: string }) {
  const done = Boolean(card?.completedAt);
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
      {card?.description ? (
        <p className="line-clamp-2 text-[11.5px] leading-snug text-[var(--color-text-muted)]">
          {card.description}
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-1.5">
        <CardMetaChips card={card} />
      </div>
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
  const fileInputRef = useRef<HTMLInputElement>(null);

  const submitLink = () => {
    const url = normalizeUrl(attachUrl);
    if (!url) return;
    onAddLink({ name: attachName.trim() || url, url });
    setAttachName('');
    setAttachUrl('');
  };

  return (
    <section className="space-y-2.5">
      <div className="flex items-center gap-2">
        <Paperclip className="size-3.5 text-[var(--color-text-faint)]" />
        <h3 className="text-[12px] font-medium text-[var(--color-text-muted)]">Attachments</h3>
        {attachments.length ? (
          <span className="rounded-full bg-[var(--color-bg-muted)] px-1.5 text-[10px] text-[var(--color-text-faint)]">
            {attachments.length}
          </span>
        ) : null}
      </div>

      {attachments.length ? (
        <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {attachments.map((attachment, index) => {
            const { Icon, kind, isImage } = attachmentVisual(attachment);
            const meta = [kind, formatBytes(attachment.size)].filter(Boolean).join(' · ');
            return (
              <li
                key={attachment.storageId || attachment.url || `${attachment.name}-${index}`}
                className="group relative flex items-center gap-3 overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-subtle)] p-2 transition-colors hover:border-[var(--color-accent)]/60"
              >
                {isImage && attachment.url ? (
                  // biome-ignore lint/performance/noImgElement: storage/remote thumbnail, not a static asset
                  <img
                    src={attachment.url}
                    alt={attachment.name}
                    className="size-11 shrink-0 rounded-lg object-cover"
                  />
                ) : (
                  <span className="grid size-11 shrink-0 place-items-center rounded-lg bg-[var(--color-bg-muted)] text-[var(--color-text-muted)]">
                    <Icon className="size-5" />
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
                  <span className="text-[10.5px] uppercase tracking-wide text-[var(--color-text-faint)]">
                    {meta}
                  </span>
                </div>
                <div className="flex shrink-0 items-center gap-0.5">
                  {attachment.url ? (
                    <a
                      href={attachment.url}
                      {...(attachment.storageId
                        ? { download: attachment.name }
                        : { target: '_blank', rel: 'noreferrer noopener' })}
                      className="grid size-6 place-items-center rounded-md text-[var(--color-text-faint)] hover:bg-[var(--color-bg-muted)] hover:text-[var(--color-text)]"
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
                      className="grid size-6 place-items-center rounded-md text-[var(--color-text-faint)] opacity-0 transition-opacity hover:bg-[var(--color-bg-muted)] hover:text-[var(--color-danger)] group-hover:opacity-100"
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

      {canEdit ? (
        <>
          {/* biome-ignore lint/a11y/noStaticElementInteractions: drag-and-drop dropzone, click delegates to the file input button */}
          <div
            onDragOver={(event) => {
              event.preventDefault();
              setDragOver(true);
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(event) => {
              event.preventDefault();
              setDragOver(false);
              const files = Array.from(event.dataTransfer.files || []);
              if (files.length) onUploadFiles(files);
            }}
            className={cn(
              'flex flex-col items-center justify-center gap-1 rounded-xl border border-dashed px-3 py-4 text-center transition-colors',
              dragOver
                ? 'border-[var(--color-accent)] bg-[var(--color-accent-soft)]'
                : 'border-[var(--color-border)] bg-[var(--color-bg-subtle)]/40',
            )}
          >
            <UploadCloud
              className={cn(
                'size-5',
                dragOver ? 'text-[var(--color-accent)]' : 'text-[var(--color-text-faint)]',
              )}
            />
            <p className="text-[12px] text-[var(--color-text-muted)]">
              Drop files here, or{' '}
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                disabled={uploading}
                className="font-medium text-[var(--color-accent)] hover:underline disabled:opacity-60"
              >
                {uploading ? 'uploading…' : 'browse'}
              </button>
            </p>
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
          </div>

          <div className="grid gap-1.5 sm:grid-cols-[minmax(8rem,0.35fr)_minmax(0,1fr)]">
            <Input
              value={attachName}
              onChange={(event) => setAttachName(event.target.value)}
              placeholder="Label (optional)"
              className="h-9 text-[12px]"
            />
            <InputGroup className="h-9 bg-[var(--color-bg-elevated)]">
              <InputGroupAddon>
                <Link2 className="size-3.5" />
              </InputGroupAddon>
              <InputGroupInput
                value={attachUrl}
                onChange={(event) => setAttachUrl(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    submitLink();
                  }
                }}
                placeholder="example.com or https://"
                className="text-[12px]"
              />
              <InputGroupAddon align="inline-end">
                <InputGroupButton
                  type="button"
                  size="sm"
                  variant="secondary"
                  className="text-[11.5px]"
                  disabled={!normalizeUrl(attachUrl)}
                  onClick={submitLink}
                >
                  Add link
                </InputGroupButton>
              </InputGroupAddon>
            </InputGroup>
          </div>
        </>
      ) : !attachments.length ? (
        <p className="text-[11.5px] text-[var(--color-text-faint)]">Nothing attached.</p>
      ) : null}
    </section>
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
  const [uploading, setUploading] = useState(false);
  const [showActivity, setShowActivity] = useState(false);
  const [portalReady, setPortalReady] = useState(false);
  const onCloseRef = useRef(onClose);
  const done = Boolean(card.completedAt);

  onCloseRef.current = onClose;

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
      <button
        type="button"
        aria-label="Close card"
        className="fixed inset-0 z-[70] cursor-default bg-black/50 backdrop-blur-[2px]"
        onClick={onClose}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={card.title}
        className="fixed inset-y-0 right-0 z-[80] flex h-auto w-[calc(100vw-24px)] flex-col overflow-hidden rounded-l-2xl border-l border-[var(--color-border)] bg-[var(--color-bg-elevated)] shadow-[-24px_0_80px_-12px_rgb(0_0_0/0.45)] sm:w-[min(calc(100vw-72px),1280px)]"
      >
        <header className="flex items-center gap-2.5 border-b border-[var(--color-border)] px-5 py-3">
          <span className="inline-flex items-center gap-1.5 text-[11px] uppercase tracking-[0.09em] text-[var(--color-text-faint)]">
            <SquareKanban className="size-3.5" /> Card
          </span>
          {done ? (
            <span className="inline-flex items-center gap-1 rounded-full bg-[var(--color-accent-soft)] px-2 py-0.5 text-[10.5px] font-medium text-[var(--color-accent)]">
              <CheckCircle2 className="size-3" /> Done
            </span>
          ) : null}
          <div className="ml-auto flex items-center gap-2">
            {canEdit ? (
              <Button type="button" size="sm" className="h-8 px-3 text-[12px]" onClick={save}>
                <Check className="mr-1 size-3.5" /> Save
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
          {/* Main column — title, notes, attachments, discussion. */}
          <div className="min-h-0 space-y-6 overflow-y-auto px-6 py-5">
            <input
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              disabled={!canEdit}
              placeholder="Card title"
              className="w-full border-none bg-transparent font-display text-[22px] font-semibold leading-snug text-[var(--color-text)] outline-none placeholder:text-[var(--color-text-faint)] disabled:opacity-100"
            />

            <div className="space-y-2">
              <h3 className="text-[12px] font-medium text-[var(--color-text-muted)]">Notes</h3>
              <textarea
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                disabled={!canEdit}
                placeholder="Add details, context, or a checklist (markdown supported)…"
                className="min-h-40 w-full resize-y rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-subtle)]/40 px-3.5 py-3 text-[13.5px] leading-relaxed outline-none focus-visible:border-[var(--color-accent)]"
              />
            </div>

            <CardAttachments
              attachments={card.attachments || []}
              canEdit={canEdit}
              uploading={uploading}
              onUploadFiles={uploadFiles}
              onAddLink={addAttachment}
              onRemove={removeAttachment}
            />

            <section className="space-y-2.5">
              <div className="flex items-center gap-2">
                <Mail className="size-3.5 text-[var(--color-text-faint)]" />
                <h3 className="text-[12px] font-medium text-[var(--color-text-muted)]">
                  Comments{card.comments?.length ? ` · ${card.comments.length}` : ''}
                </h3>
              </div>
              {(card.comments || []).map((comment) => (
                <div
                  key={comment.id}
                  className="flex gap-2.5 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-subtle)]/50 px-3 py-2.5"
                >
                  <span className="mt-0.5 grid size-6 shrink-0 place-items-center rounded-full bg-[var(--color-bg-muted)] text-[9px] font-semibold uppercase text-[var(--color-text-muted)]">
                    {emailInitials(comment.authorEmail || '?')}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="text-[13px] leading-relaxed text-[var(--color-text)]">{comment.body}</p>
                    <p className="mt-1 text-[10.5px] text-[var(--color-text-faint)]">
                      {comment.authorEmail || 'someone'} ·{' '}
                      {new Date(comment.createdAt).toLocaleString(undefined, {
                        month: 'short',
                        day: 'numeric',
                        hour: 'numeric',
                        minute: '2-digit',
                      })}
                    </p>
                  </div>
                </div>
              ))}
              {/* Everyone with access can comment — viewers included. */}
              <form
                className="flex items-center gap-1.5"
                onSubmit={async (event) => {
                  event.preventDefault();
                  const body = commentDraft.trim();
                  if (!body) return;
                  try {
                    await addComment({ cardId: card.cardId, body });
                    setCommentDraft('');
                  } catch (err: any) {
                    toast.error(err?.message || 'Could not comment');
                  }
                }}
              >
                <Input
                  value={commentDraft}
                  onChange={(event) => setCommentDraft(event.target.value)}
                  placeholder={role === 'viewer' ? 'Comment as a viewer…' : 'Add a comment…'}
                  className="h-9 flex-1 text-[12.5px]"
                />
                <Button type="submit" size="sm" variant="outline" className="h-9 px-3 text-[12px]">
                  Post
                </Button>
              </form>
            </section>

            <section className="space-y-2 pb-2">
              <button
                type="button"
                onClick={() => setShowActivity(!showActivity)}
                className="inline-flex items-center gap-1.5 text-[11px] text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
              >
                <History className="size-3.5" />
                Activity{card.activity?.length ? ` · ${card.activity.length}` : ''}
              </button>
              {showActivity ? (
                <ul className="space-y-1 border-l border-[var(--color-border)] pl-3">
                  {[...(card.activity || [])].reverse().map((entry) => (
                    <li key={entry.id} className="text-[11px] text-[var(--color-text-faint)]">
                      <span className="text-[var(--color-text-muted)]">{entry.actorEmail || 'someone'}</span>{' '}
                      {entry.action}
                      {entry.detail ? ` — ${entry.detail}` : ''} ·{' '}
                      {new Date(entry.createdAt).toLocaleString(undefined, {
                        month: 'short',
                        day: 'numeric',
                        hour: 'numeric',
                        minute: '2-digit',
                      })}
                    </li>
                  ))}
                </ul>
              ) : null}
            </section>
          </div>

          {/* Metadata rail. */}
          <aside className="min-h-0 space-y-5 overflow-y-auto border-t border-[var(--color-border)] bg-[var(--color-bg-subtle)]/40 px-5 py-5 md:border-l md:border-t-0">
            <div className="space-y-1.5">
              <label
                htmlFor="card-due"
                className="flex items-center gap-1.5 text-[11px] font-medium text-[var(--color-text-muted)]"
              >
                <CalendarClock className="size-3.5" /> Due date
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
                className="flex items-center gap-1.5 text-[11px] font-medium text-[var(--color-text-muted)]"
              >
                <Flag className="size-3.5" /> Priority
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
              <label
                htmlFor="card-weight"
                className="flex items-center gap-1.5 text-[11px] font-medium text-[var(--color-text-muted)]"
              >
                <Scale className="size-3.5" /> Weight
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
              <label
                htmlFor="card-labels"
                className="flex items-center gap-1.5 text-[11px] font-medium text-[var(--color-text-muted)]"
              >
                <Tag className="size-3.5" /> Labels
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
              <p className="flex items-center gap-1.5 text-[11px] font-medium text-[var(--color-text-muted)]">
                <Users className="size-3.5" /> Assigned
              </p>
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

            {card.source?.threadId ? (
              <div className="space-y-1.5">
                <p className="flex items-center gap-1.5 text-[11px] font-medium text-[var(--color-text-muted)]">
                  <Mail className="size-3.5" /> Source
                </p>
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
          </aside>
        </div>
      </div>
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
