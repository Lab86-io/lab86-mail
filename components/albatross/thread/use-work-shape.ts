'use client';

// The shape-owned state of one Work (list items, practice metric, milestones,
// the shape itself, and the horizon), with each choice shown until the server
// row agrees. Moved from the old Work page; the Details panel renders it.

import { useMutation } from 'convex/react';
import { useEffect, useState } from 'react';
import { api } from '@/convex/_generated/api';
import type { Id } from '@/convex/_generated/dataModel';
import type { WorkHorizon } from '@/lib/albatross/horizon';
import type { WorkShape } from '@/lib/albatross/work-shape';
import {
  mergeMetricEntries,
  visibleHorizon,
  visibleMilestones,
  visibleShape,
  type WorkDetailData,
} from '@/lib/albatross/work-view';
import { HORIZON_SAVE_ERROR } from '../HorizonControl';
import { LIST_SAVE_ERROR, visibleListItems } from '../shapes/ListBody';
import type { ListItem } from '../shapes/ListRow';
import { MILESTONES_SAVE_ERROR, type Milestone, type MilestoneRow } from '../shapes/MilestoneRail';
import { METRIC_SAVE_ERROR, type MetricEntry } from '../shapes/PracticeBody';
import { SHAPE_SAVE_ERROR } from '../shapes/ShapePicker';

export interface WorkShapeState {
  shape: WorkShape;
  shapeSaving: boolean;
  shapeError: string | null;
  saveShape: (next: WorkShape) => Promise<void>;
  horizon: WorkHorizon | null;
  horizonSaving: boolean;
  horizonError: string | null;
  saveHorizon: (next: WorkHorizon | null) => Promise<void>;
  listItems: ListItem[];
  listBusyIds: ReadonlySet<string>;
  listError: string | null;
  addListItems: (texts: string[]) => Promise<void>;
  toggleListItem: (itemId: string) => Promise<void>;
  removeListItem: (itemId: string) => Promise<void>;
  metricEntries: MetricEntry[];
  metricSaving: boolean;
  metricError: string | null;
  freshEntryId: string | null;
  logMetric: (value: number, note?: string) => Promise<void>;
  milestones: Milestone[];
  milestoneBusyIds: ReadonlySet<string>;
  milestonesSaving: boolean;
  milestoneError: string | null;
  toggleMilestone: (milestoneId: string) => Promise<void>;
  saveMilestones: (rows: MilestoneRow[]) => Promise<boolean>;
}

export function useWorkShape(workId: string, detail: WorkDetailData | null | undefined): WorkShapeState {
  const id = workId as Id<'albatrossIntents'>;
  const setHorizonMutation = useMutation(api.albatrossWorkV2.setHorizon);
  const setShapeMutation = useMutation(api.albatrossWorkV2.setShape);
  const addListItemMutation = useMutation(api.albatrossWorkV2.addListItem);
  const toggleListItemMutation = useMutation(api.albatrossWorkV2.toggleListItem);
  const removeListItemMutation = useMutation(api.albatrossWorkV2.removeListItem);
  const logMetricMutation = useMutation(api.albatrossWorkV2.logMetric);
  const setMilestonesMutation = useMutation(api.albatrossWorkV2.setMilestones);
  const toggleMilestoneMutation = useMutation(api.albatrossWorkV2.toggleMilestone);

  const [horizonChoice, setHorizonChoice] = useState<{ value: WorkHorizon | null } | null>(null);
  const [horizonSaving, setHorizonSaving] = useState(false);
  const [horizonError, setHorizonError] = useState<string | null>(null);
  const [shapeChoice, setShapeChoice] = useState<{ value: WorkShape } | null>(null);
  const [shapeSaving, setShapeSaving] = useState(false);
  const [shapeError, setShapeError] = useState<string | null>(null);
  const [listChoices, setListChoices] = useState<ReadonlyMap<string, { done: boolean; at: number }>>(
    () => new Map(),
  );
  const [pendingListItems, setPendingListItems] = useState<ListItem[]>([]);
  const [removedListIds, setRemovedListIds] = useState<ReadonlySet<string>>(() => new Set());
  const [listBusyIds, setListBusyIds] = useState<ReadonlySet<string>>(() => new Set());
  const [listError, setListError] = useState<string | null>(null);
  const [pendingEntries, setPendingEntries] = useState<MetricEntry[]>([]);
  const [freshEntryId, setFreshEntryId] = useState<string | null>(null);
  const [metricSaving, setMetricSaving] = useState(false);
  const [metricError, setMetricError] = useState<string | null>(null);
  const [milestoneChoices, setMilestoneChoices] = useState<
    ReadonlyMap<string, { done: boolean; at: number }>
  >(() => new Map());
  const [milestoneBusyIds, setMilestoneBusyIds] = useState<ReadonlySet<string>>(() => new Set());
  const [milestonesSaving, setMilestonesSaving] = useState(false);
  const [milestoneError, setMilestoneError] = useState<string | null>(null);

  // Drop each optimistic choice once the server row carries it.
  useEffect(() => {
    if (!detail) return;
    const serverItems = detail.work.listItems ?? [];
    setListChoices((current) => {
      const next = new Map(current);
      for (const [itemId, choice] of current) {
        const item = serverItems.find((row) => row.id === itemId);
        if (!item || item.done === choice.done) next.delete(itemId);
      }
      return next.size === current.size ? current : next;
    });
    setRemovedListIds((current) => {
      const kept = [...current].filter((itemId) => serverItems.some((row) => row.id === itemId));
      return kept.length === current.size ? current : new Set(kept);
    });
    const serverMilestones = detail.work.milestones ?? [];
    setMilestoneChoices((current) => {
      const next = new Map(current);
      for (const [milestoneId, choice] of current) {
        const milestone = serverMilestones.find((row) => row.id === milestoneId);
        if (!milestone || milestone.done === choice.done) next.delete(milestoneId);
      }
      return next.size === current.size ? current : next;
    });
    const serverEntryIds = new Set((detail.metricEntries ?? []).map((entry) => entry._id));
    setPendingEntries((current) => {
      const kept = current.filter((entry) => !serverEntryIds.has(entry._id));
      return kept.length === current.length ? current : kept;
    });
  }, [detail]);

  const saveShape = async (next: WorkShape) => {
    setShapeChoice({ value: next });
    setShapeSaving(true);
    setShapeError(null);
    try {
      await setShapeMutation({ workId: id, shape: next });
    } catch {
      setShapeChoice(null);
      setShapeError(SHAPE_SAVE_ERROR);
    } finally {
      setShapeSaving(false);
    }
  };

  const saveHorizon = async (next: WorkHorizon | null) => {
    setHorizonChoice({ value: next });
    setHorizonSaving(true);
    setHorizonError(null);
    try {
      await setHorizonMutation({ workId: id, horizon: next });
    } catch {
      setHorizonChoice(null);
      setHorizonError(HORIZON_SAVE_ERROR);
    } finally {
      setHorizonSaving(false);
    }
  };

  const addListItems = async (texts: string[]) => {
    const at = Date.now();
    const drafts = texts.map((text, index) => ({
      id: `pending:${at}:${index}`,
      text,
      done: false,
      addedAt: at + index,
    }));
    setPendingListItems((current) => [...current, ...drafts]);
    setListError(null);
    for (const draft of drafts) {
      try {
        await addListItemMutation({ workId: id, text: draft.text });
      } catch {
        setListError(LIST_SAVE_ERROR);
      } finally {
        setPendingListItems((current) => current.filter((row) => row.id !== draft.id));
      }
    }
  };

  const toggleListItem = async (itemId: string) => {
    const item = (detail?.work.listItems ?? []).find((row) => row.id === itemId);
    if (!item) return;
    const shownDone = listChoices.get(itemId)?.done ?? item.done;
    setListChoices((current) => new Map(current).set(itemId, { done: !shownDone, at: Date.now() }));
    setListError(null);
    try {
      await toggleListItemMutation({ workId: id, itemId });
    } catch {
      setListChoices((current) => {
        const next = new Map(current);
        next.delete(itemId);
        return next;
      });
      setListError(LIST_SAVE_ERROR);
    }
  };

  const removeListItem = async (itemId: string) => {
    setRemovedListIds((current) => new Set([...current, itemId]));
    setListBusyIds((current) => new Set([...current, itemId]));
    setListError(null);
    try {
      await removeListItemMutation({ workId: id, itemId });
    } catch {
      setRemovedListIds((current) => {
        const next = new Set(current);
        next.delete(itemId);
        return next;
      });
      setListError(LIST_SAVE_ERROR);
    } finally {
      setListBusyIds((current) => {
        const next = new Set(current);
        next.delete(itemId);
        return next;
      });
    }
  };

  const logMetric = async (value: number, note?: string) => {
    setMetricSaving(true);
    setMetricError(null);
    try {
      const result = await logMetricMutation({ workId: id, value, ...(note ? { note } : {}) });
      const entry: MetricEntry = {
        _id: String(result.entry._id),
        at: result.entry.at,
        value: result.entry.value,
        note: result.entry.note ?? null,
      };
      setPendingEntries((current) => [...current, entry]);
      setFreshEntryId(entry._id);
    } catch {
      setMetricError(METRIC_SAVE_ERROR);
    } finally {
      setMetricSaving(false);
    }
  };

  const toggleMilestone = async (milestoneId: string) => {
    const milestone = (detail?.work.milestones ?? []).find((row) => row.id === milestoneId);
    if (!milestone) return;
    const shownDone = milestoneChoices.get(milestoneId)?.done ?? milestone.done;
    setMilestoneChoices((current) => new Map(current).set(milestoneId, { done: !shownDone, at: Date.now() }));
    setMilestoneBusyIds((current) => new Set([...current, milestoneId]));
    setMilestoneError(null);
    try {
      await toggleMilestoneMutation({ workId: id, milestoneId });
    } catch {
      setMilestoneChoices((current) => {
        const next = new Map(current);
        next.delete(milestoneId);
        return next;
      });
      setMilestoneError(MILESTONES_SAVE_ERROR);
    } finally {
      setMilestoneBusyIds((current) => {
        const next = new Set(current);
        next.delete(milestoneId);
        return next;
      });
    }
  };

  const saveMilestones = async (rows: MilestoneRow[]): Promise<boolean> => {
    setMilestonesSaving(true);
    setMilestoneError(null);
    try {
      await setMilestonesMutation({ workId: id, milestones: rows });
      return true;
    } catch {
      setMilestoneError(MILESTONES_SAVE_ERROR);
      return false;
    } finally {
      setMilestonesSaving(false);
    }
  };

  const work = detail?.work;
  return {
    shape: visibleShape(work?.shape, shapeChoice),
    shapeSaving,
    shapeError,
    saveShape,
    horizon: visibleHorizon(work?.horizon, horizonChoice),
    horizonSaving,
    horizonError,
    saveHorizon,
    listItems: visibleListItems(
      [...(work?.listItems ?? []), ...pendingListItems].filter((item) => !removedListIds.has(item.id)),
      listChoices,
    ),
    listBusyIds,
    listError,
    addListItems,
    toggleListItem,
    removeListItem,
    metricEntries: mergeMetricEntries(detail?.metricEntries ?? [], pendingEntries),
    metricSaving,
    metricError,
    freshEntryId,
    logMetric,
    milestones: visibleMilestones(work?.milestones, milestoneChoices),
    milestoneBusyIds,
    milestonesSaving,
    milestoneError,
    toggleMilestone,
    saveMilestones,
  };
}
