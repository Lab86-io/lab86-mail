'use client';

// One view per shape kind (docs/chat-agentic-pass.md, section 3). The card
// owns the action status for its rows so an outcome ("Archived") shows in
// place and the used action disables, with no navigation and no toast.

import type { ToolShape } from '@/lib/ai/tool-shapes';
import { AreaCard } from './AreaCard';
import { BoardCard } from './BoardCard';
import { ContactCard } from './ContactCard';
import { CountCard } from './CountCard';
import { DocumentCard } from './DocumentCard';
import { EventCard } from './EventCard';
import { EventsCard } from './EventsCard';
import { FilesCard } from './FilesCard';
import { ReceiptCard } from './ReceiptCard';
import { SlotsCard } from './SlotsCard';
import { SourcesCard } from './SourcesCard';
import { ShapeActionsContext, useShapeActions } from './shape-actions';
import { TaskCard } from './TaskCard';
import { TasksCard } from './TasksCard';
import { TextCard } from './TextCard';
import { ThreadCard } from './ThreadCard';
import { ThreadsCard } from './ThreadsCard';
import { WorkCard } from './WorkCard';
import { WorksCard } from './WorksCard';

export function ShapeCardBody({ shape }: { shape: ToolShape }) {
  switch (shape.kind) {
    case 'threads':
      return <ThreadsCard shape={shape} />;
    case 'thread':
      return <ThreadCard shape={shape} />;
    case 'events':
      return <EventsCard shape={shape} />;
    case 'event':
      return <EventCard shape={shape} />;
    case 'slots':
      return <SlotsCard shape={shape} />;
    case 'tasks':
      return <TasksCard shape={shape} />;
    case 'task':
      return <TaskCard shape={shape} />;
    case 'board':
      return <BoardCard shape={shape} />;
    case 'work':
      return <WorkCard shape={shape} />;
    case 'works':
      return <WorksCard shape={shape} />;
    case 'area':
      return <AreaCard shape={shape} />;
    case 'document':
      return <DocumentCard shape={shape} />;
    case 'files':
      return <FilesCard shape={shape} />;
    case 'contact':
      return <ContactCard shape={shape} />;
    case 'count':
      return <CountCard shape={shape} />;
    case 'receipt':
      return <ReceiptCard shape={shape} />;
    case 'sources':
      return <SourcesCard shape={shape} />;
    case 'text':
      return <TextCard shape={shape} />;
    default:
      return null;
  }
}

export function ShapeCard({ shape }: { shape: ToolShape }) {
  const api = useShapeActions();
  return (
    <ShapeActionsContext.Provider value={api}>
      <div data-shape-kind={shape.kind} className="w-full min-w-0">
        <ShapeCardBody shape={shape} />
      </div>
    </ShapeActionsContext.Provider>
  );
}
