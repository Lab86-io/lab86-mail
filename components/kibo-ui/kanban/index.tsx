'use client';

import type {
  Announcements,
  DndContextProps,
  DragEndEvent,
  DragOverEvent,
  DragStartEvent,
} from '@dnd-kit/core';
import {
  closestCenter,
  DndContext,
  DragOverlay,
  KeyboardSensor,
  MouseSensor,
  TouchSensor,
  useDroppable,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import { arrayMove, SortableContext, useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import {
  type ButtonHTMLAttributes,
  createContext,
  type HTMLAttributes,
  type ReactNode,
  useContext,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import tunnel from 'tunnel-rat';
import { Card } from '@/components/ui/card';
import { ScrollArea, ScrollBar } from '@/components/ui/scroll-area';
import { cn } from '@/lib/utils';

const t = tunnel();

export type { DragEndEvent } from '@dnd-kit/core';

type KanbanItemProps = {
  id: string;
  name: string;
  column: string;
} & Record<string, unknown>;

type KanbanColumnProps = {
  id: string;
  name: string;
} & Record<string, unknown>;

type KanbanContextProps<
  T extends KanbanItemProps = KanbanItemProps,
  C extends KanbanColumnProps = KanbanColumnProps,
> = {
  columns: C[];
  data: T[];
  activeCardId: string | null;
  activeColumnId: string | null;
  columnsReorderable: boolean;
};

const KanbanContext = createContext<KanbanContextProps>({
  columns: [],
  data: [],
  activeCardId: null,
  activeColumnId: null,
  columnsReorderable: false,
});

type KanbanColumnHandleContextProps = Pick<
  ReturnType<typeof useSortable>,
  'attributes' | 'listeners' | 'setActivatorNodeRef'
>;

const KanbanColumnHandleContext = createContext<KanbanColumnHandleContextProps | null>(null);

export type KanbanBoardProps = {
  id: string;
  children: ReactNode;
  className?: string;
};

export const KanbanBoard = ({ id, children, className }: KanbanBoardProps) => {
  const { columnsReorderable } = useContext(KanbanContext);
  const sortable = useSortable({
    id,
    data: { type: 'column' },
    disabled: !columnsReorderable,
  });
  const droppable = useDroppable({
    id,
    disabled: columnsReorderable,
  });
  const isOver = columnsReorderable ? sortable.isOver : droppable.isOver;
  const setNodeRef = columnsReorderable ? sortable.setNodeRef : droppable.setNodeRef;
  const style = columnsReorderable
    ? {
        transform: CSS.Transform.toString(sortable.transform),
        transition: sortable.transition,
      }
    : undefined;

  return (
    <KanbanColumnHandleContext.Provider
      value={{
        attributes: sortable.attributes,
        listeners: sortable.listeners,
        setActivatorNodeRef: sortable.setActivatorNodeRef,
      }}
    >
      <div
        className={cn(
          'flex size-full min-h-40 flex-col divide-y overflow-hidden rounded-md border bg-secondary text-xs shadow-sm ring-2 transition-all',
          isOver ? 'ring-primary' : 'ring-transparent',
          sortable.isDragging && 'opacity-70',
          className,
        )}
        ref={setNodeRef}
        style={style}
      >
        {children}
      </div>
    </KanbanColumnHandleContext.Provider>
  );
};

export type KanbanColumnHandleProps = ButtonHTMLAttributes<HTMLButtonElement>;

export const KanbanColumnHandle = ({ className, ...props }: KanbanColumnHandleProps) => {
  const handle = useContext(KanbanColumnHandleContext);

  return (
    <button
      type="button"
      ref={handle?.setActivatorNodeRef}
      {...(handle?.attributes ?? {})}
      {...(handle?.listeners ?? {})}
      className={cn(
        'grid size-5 shrink-0 cursor-grab place-items-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground active:cursor-grabbing',
        className,
      )}
      {...props}
    />
  );
};

export type KanbanCardProps<T extends KanbanItemProps = KanbanItemProps> = T & {
  children?: ReactNode;
  className?: string;
  // Fires on a tap (pointer down→up with negligible travel) — distinct from
  // a drag. dnd-kit's listeners sit on the same node and swallow nested
  // onClick, so the host can't rely on a child button; this is the reliable
  // open-detail hook.
  onCardClick?: () => void;
};

const TAP_MOVE_THRESHOLD = 6;

export const KanbanCard = <T extends KanbanItemProps = KanbanItemProps>({
  id,
  name,
  children,
  className,
  onCardClick,
}: KanbanCardProps<T>) => {
  const { attributes, listeners, setNodeRef, transition, transform, isDragging } = useSortable({
    id,
  });
  const { activeCardId } = useContext(KanbanContext) as KanbanContextProps;
  const tapStart = useRef<{ x: number; y: number } | null>(null);

  const style = {
    transition,
    transform: CSS.Transform.toString(transform),
  };

  // Observe pointer coordinates ourselves rather than fighting the sensor:
  // a press that lifts within the move threshold is a tap → open the card.
  const handlePointerDown = (event: React.PointerEvent) => {
    tapStart.current = { x: event.clientX, y: event.clientY };
  };
  const handlePointerUp = (event: React.PointerEvent) => {
    const start = tapStart.current;
    tapStart.current = null;
    if (!start || !onCardClick) return;
    const moved = Math.hypot(event.clientX - start.x, event.clientY - start.y);
    if (moved <= TAP_MOVE_THRESHOLD) onCardClick();
  };

  return (
    <>
      <div
        style={style}
        {...listeners}
        {...attributes}
        ref={setNodeRef}
        onPointerDownCapture={handlePointerDown}
        onPointerUp={handlePointerUp}
      >
        <Card
          className={cn(
            'cursor-grab gap-4 rounded-md p-3 shadow-sm',
            isDragging && 'pointer-events-none cursor-grabbing opacity-30',
            className,
          )}
        >
          {children ?? <p className="m-0 font-medium text-sm">{name}</p>}
        </Card>
      </div>
      {activeCardId === id && (
        <t.In>
          <Card
            className={cn(
              'cursor-grab gap-4 rounded-md p-3 shadow-sm ring-2 ring-primary',
              isDragging && 'cursor-grabbing',
              className,
            )}
          >
            {children ?? <p className="m-0 font-medium text-sm">{name}</p>}
          </Card>
        </t.In>
      )}
    </>
  );
};

export type KanbanCardsProps<T extends KanbanItemProps = KanbanItemProps> = Omit<
  HTMLAttributes<HTMLDivElement>,
  'children' | 'id'
> & {
  children: (item: T) => ReactNode;
  id: string;
};

export const KanbanCards = <T extends KanbanItemProps = KanbanItemProps>({
  children,
  className,
  ...props
}: KanbanCardsProps<T>) => {
  const { data } = useContext(KanbanContext) as KanbanContextProps<T>;
  const filteredData = data.filter((item) => item.column === props.id);
  const items = filteredData.map((item) => item.id);

  return (
    <ScrollArea className="min-h-0 flex-1 overflow-hidden">
      <SortableContext items={items}>
        <div className={cn('flex min-h-full flex-grow flex-col gap-2 p-2', className)} {...props}>
          {filteredData.map(children)}
        </div>
      </SortableContext>
      <ScrollBar orientation="vertical" />
    </ScrollArea>
  );
};

export type KanbanHeaderProps = HTMLAttributes<HTMLDivElement>;

export const KanbanHeader = ({ className, ...props }: KanbanHeaderProps) => (
  <div className={cn('m-0 p-2 font-semibold text-sm', className)} {...props} />
);

export type KanbanProviderProps<
  T extends KanbanItemProps = KanbanItemProps,
  C extends KanbanColumnProps = KanbanColumnProps,
> = Omit<DndContextProps, 'children'> & {
  children: (column: C) => ReactNode;
  className?: string;
  columns: C[];
  data: T[];
  onDataChange?: (data: T[]) => void;
  onColumnsChange?: (columns: C[]) => void;
  onColumnDragEnd?: (event: DragEndEvent, columns: C[]) => void;
  onDragStart?: (event: DragStartEvent) => void;
  onDragEnd?: (event: DragEndEvent) => void;
  onDragOver?: (event: DragOverEvent) => void;
};

export const KanbanProvider = <
  T extends KanbanItemProps = KanbanItemProps,
  C extends KanbanColumnProps = KanbanColumnProps,
>({
  children,
  onDragStart,
  onDragEnd,
  onDragOver,
  className,
  columns,
  data,
  onDataChange,
  onColumnsChange,
  onColumnDragEnd,
  ...props
}: KanbanProviderProps<T, C>) => {
  const [activeCardId, setActiveCardId] = useState<string | null>(null);
  const [activeColumnId, setActiveColumnId] = useState<string | null>(null);
  const columnsReorderable = Boolean(onColumnsChange || onColumnDragEnd);

  // Activation constraints are what let a plain click through: a drag only
  // begins after real movement (mouse) or a short hold (touch). Without them
  // MouseSensor grabs the press on mousedown and the click never lands —
  // which is exactly why cards weren't opening.
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 180, tolerance: 8 } }),
    useSensor(KeyboardSensor),
  );

  const handleDragStart = (event: DragStartEvent) => {
    const column = columns.find((item) => item.id === event.active.id);
    if (column) {
      setActiveColumnId(event.active.id as string);
      onDragStart?.(event);
      return;
    }
    const card = data.find((item) => item.id === event.active.id);
    if (card) {
      setActiveCardId(event.active.id as string);
    }
    onDragStart?.(event);
  };

  const handleDragOver = (event: DragOverEvent) => {
    const { active, over } = event;

    if (!over) {
      return;
    }

    if (activeColumnId || columns.some((column) => column.id === active.id)) {
      onDragOver?.(event);
      return;
    }

    const activeItem = data.find((item) => item.id === active.id);
    const overItem = data.find((item) => item.id === over.id);

    if (!activeItem) {
      return;
    }

    const activeColumn = activeItem.column;
    const overColumn = overItem?.column || columns.find((col) => col.id === over.id)?.id || columns[0]?.id;

    if (activeColumn !== overColumn) {
      let newData = [...data];
      const activeIndex = newData.findIndex((item) => item.id === active.id);
      const overIndex = newData.findIndex((item) => item.id === over.id);

      newData[activeIndex].column = overColumn;
      newData = arrayMove(newData, activeIndex, overIndex);

      onDataChange?.(newData);
    }

    onDragOver?.(event);
  };

  const handleDragEnd = (event: DragEndEvent) => {
    setActiveCardId(null);
    setActiveColumnId(null);

    onDragEnd?.(event);

    const { active, over } = event;

    if (!over || active.id === over.id) {
      return;
    }

    const activeColumn = columns.find((column) => column.id === active.id);
    if (activeColumn) {
      const overColumnId =
        columns.find((column) => column.id === over.id)?.id ||
        data.find((item) => item.id === over.id)?.column;
      const oldIndex = columns.findIndex((column) => column.id === active.id);
      const newIndex = columns.findIndex((column) => column.id === overColumnId);
      if (oldIndex === -1 || newIndex === -1) return;
      const nextColumns = arrayMove(columns, oldIndex, newIndex);
      onColumnsChange?.(nextColumns);
      onColumnDragEnd?.(event, nextColumns);
      return;
    }

    let newData = [...data];

    const oldIndex = newData.findIndex((item) => item.id === active.id);
    const newIndex = newData.findIndex((item) => item.id === over.id);

    if (oldIndex === -1 || newIndex === -1) return;
    newData = arrayMove(newData, oldIndex, newIndex);

    onDataChange?.(newData);
  };

  const announcements: Announcements = {
    onDragStart({ active }) {
      const activeColumn = columns.find((column) => column.id === active.id);
      if (activeColumn) return `Picked up the column "${activeColumn.name}"`;
      const { name, column } = data.find((item) => item.id === active.id) ?? {};

      return `Picked up the card "${name}" from the "${column}" column`;
    },
    onDragOver({ active, over }) {
      const activeColumn = columns.find((column) => column.id === active.id);
      if (activeColumn) {
        const overColumn = columns.find((column) => column.id === over?.id)?.name;
        return `Dragged the column "${activeColumn.name}" over "${overColumn}"`;
      }
      const { name } = data.find((item) => item.id === active.id) ?? {};
      const newColumn = columns.find((column) => column.id === over?.id)?.name;

      return `Dragged the card "${name}" over the "${newColumn}" column`;
    },
    onDragEnd({ active, over }) {
      const activeColumn = columns.find((column) => column.id === active.id);
      if (activeColumn) {
        const overColumn = columns.find((column) => column.id === over?.id)?.name;
        return `Dropped the column "${activeColumn.name}" near "${overColumn}"`;
      }
      const { name } = data.find((item) => item.id === active.id) ?? {};
      const newColumn = columns.find((column) => column.id === over?.id)?.name;

      return `Dropped the card "${name}" into the "${newColumn}" column`;
    },
    onDragCancel({ active }) {
      const activeColumn = columns.find((column) => column.id === active.id);
      if (activeColumn) return `Cancelled dragging the column "${activeColumn.name}"`;
      const { name } = data.find((item) => item.id === active.id) ?? {};

      return `Cancelled dragging the card "${name}"`;
    },
  };

  return (
    <KanbanContext.Provider value={{ columns, data, activeCardId, activeColumnId, columnsReorderable }}>
      <DndContext
        accessibility={{ announcements }}
        collisionDetection={closestCenter}
        onDragEnd={handleDragEnd}
        onDragOver={handleDragOver}
        onDragStart={handleDragStart}
        sensors={sensors}
        {...props}
      >
        {/* Flex row (not auto-cols-fr grid): columns keep their fixed width
            and overflow horizontally instead of stretching to fill. */}
        <SortableContext items={columns.map((column) => column.id)}>
          <div className={cn('flex size-full gap-4', className)}>
            {columns.map((column) => children(column))}
          </div>
        </SortableContext>
        {typeof window !== 'undefined' &&
          createPortal(
            <DragOverlay>
              <t.Out />
            </DragOverlay>,
            document.body,
          )}
      </DndContext>
    </KanbanContext.Provider>
  );
};
