'use client';

import type React from 'react';
import { createContext, useContext, useEffect, useState } from 'react';
import { useLocalStorage } from '@/components/calendar/engine/hooks';
import type { IEvent, IUser } from '@/components/calendar/engine/interfaces';
import type { TCalendarView, TEventColor } from '@/components/calendar/engine/types';

// Persistence hooks supplied by the host surface: the context updates its
// local state optimistically, then hands the event to these to write through
// (Nylas via tools in our case). Live-query props resync corrects any drift.
export interface CalendarPersistence {
  onEventAdded?: (event: IEvent) => void | Promise<void>;
  onEventUpdated?: (event: IEvent, previous?: IEvent) => void | Promise<void>;
  onEventRemoved?: (event: IEvent) => void | Promise<void>;
}

interface ICalendarContext {
  selectedDate: Date;
  view: TCalendarView;
  setView: (view: TCalendarView) => void;
  agendaModeGroupBy: 'date' | 'color';
  setAgendaModeGroupBy: (groupBy: 'date' | 'color') => void;
  use24HourFormat: boolean;
  toggleTimeFormat: () => void;
  hourHeight: number;
  setHourHeight: (px: number) => void;
  setSelectedDate: (date: Date | undefined) => void;
  selectedUserId: IUser['id'] | 'all';
  setSelectedUserId: (userId: IUser['id'] | 'all') => void;
  badgeVariant: 'dot' | 'colored';
  setBadgeVariant: (variant: 'dot' | 'colored') => void;
  selectedColors: TEventColor[];
  filterEventsBySelectedColors: (colors: TEventColor) => void;
  filterEventsBySelectedUser: (userId: IUser['id'] | 'all') => void;
  users: IUser[];
  events: IEvent[];
  addEvent: (event: IEvent) => void;
  updateEvent: (event: IEvent) => void;
  removeEvent: (eventId: string) => void;
  clearFilter: () => void;
}

function applyFilters(
  events: IEvent[],
  selectedUserId: IUser['id'] | 'all',
  selectedColors: TEventColor[],
): IEvent[] {
  let filtered = events;
  if (selectedUserId !== 'all') {
    filtered = filtered.filter((event) => event.user.id === selectedUserId);
  }
  if (selectedColors.length > 0) {
    filtered = filtered.filter((event) => selectedColors.includes(event.color || 'blue'));
  }
  return filtered;
}

interface CalendarSettings {
  badgeVariant: 'dot' | 'colored';
  view: TCalendarView;
  use24HourFormat: boolean;
  agendaModeGroupBy: 'date' | 'color';
  hourHeight: number;
}

const DEFAULT_SETTINGS: CalendarSettings = {
  badgeVariant: 'colored',
  view: 'week',
  // Civilian clock by default; hourHeight is the week/day zoom level
  // (px per hour) so a work day fits the viewport.
  use24HourFormat: false,
  agendaModeGroupBy: 'date',
  hourHeight: 64,
};

const CalendarContext = createContext({} as ICalendarContext);

export function CalendarProvider({
  children,
  users,
  events,
  badge = 'colored',
  view = 'day',
  persistence,
}: {
  children: React.ReactNode;
  users: IUser[];
  events: IEvent[];
  view?: TCalendarView;
  badge?: 'dot' | 'colored';
  persistence?: CalendarPersistence;
}) {
  const [settings, setSettings] = useLocalStorage<CalendarSettings>('calendar-settings-v2', {
    ...DEFAULT_SETTINGS,
    badgeVariant: badge,
    view: view,
  });

  const [badgeVariant, setBadgeVariantState] = useState<'dot' | 'colored'>(settings.badgeVariant);
  const [currentView, setCurrentViewState] = useState<TCalendarView>(settings.view);
  const [use24HourFormat, setUse24HourFormatState] = useState<boolean>(settings.use24HourFormat);
  const [agendaModeGroupBy, setAgendaModeGroupByState] = useState<'date' | 'color'>(
    settings.agendaModeGroupBy,
  );
  const [hourHeight, setHourHeightState] = useState<number>(settings.hourHeight || 64);

  const [selectedDate, setSelectedDate] = useState(new Date());
  const [selectedUserId, setSelectedUserId] = useState<IUser['id'] | 'all'>('all');
  const [selectedColors, setSelectedColors] = useState<TEventColor[]>([]);

  const [allEvents, setAllEvents] = useState<IEvent[]>(events || []);
  const [filteredEvents, setFilteredEvents] = useState<IEvent[]>(events || []);

  const updateSettings = (newPartialSettings: Partial<CalendarSettings>) => {
    setSettings({
      ...settings,
      ...newPartialSettings,
    });
  };

  const setBadgeVariant = (variant: 'dot' | 'colored') => {
    setBadgeVariantState(variant);
    updateSettings({ badgeVariant: variant });
  };

  const setView = (newView: TCalendarView) => {
    setCurrentViewState(newView);
    updateSettings({ view: newView });
  };

  const toggleTimeFormat = () => {
    const newValue = !use24HourFormat;
    setUse24HourFormatState(newValue);
    updateSettings({ use24HourFormat: newValue });
  };

  const setAgendaModeGroupBy = (groupBy: 'date' | 'color') => {
    setAgendaModeGroupByState(groupBy);
    updateSettings({ agendaModeGroupBy: groupBy });
  };

  const setHourHeight = (px: number) => {
    const clamped = Math.min(160, Math.max(40, Math.round(px)));
    setHourHeightState(clamped);
    updateSettings({ hourHeight: clamped });
  };

  // Both filter dimensions always compose — toggling one re-applies the other.
  const filterEventsBySelectedColors = (color: TEventColor) => {
    const isColorSelected = selectedColors.includes(color);
    const newColors = isColorSelected
      ? selectedColors.filter((c) => c !== color)
      : [...selectedColors, color];
    setSelectedColors(newColors);
    setFilteredEvents(applyFilters(allEvents, selectedUserId, newColors));
  };

  const filterEventsBySelectedUser = (userId: IUser['id'] | 'all') => {
    setSelectedUserId(userId);
    setFilteredEvents(applyFilters(allEvents, userId, selectedColors));
  };

  const handleSelectDate = (date: Date | undefined) => {
    if (!date) return;
    setSelectedDate(date);
  };

  // Live-query resync: when the host pushes a fresh events prop (Convex), it
  // becomes the source of truth and current filters re-apply over it.
  useEffect(() => {
    setAllEvents(events || []);
    setFilteredEvents(applyFilters(events || [], selectedUserId, selectedColors));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [events]);

  const addEvent = (event: IEvent) => {
    setAllEvents((prev) => [...prev, event]);
    // Only surface the new event if it matches the active filters.
    setFilteredEvents((prev) =>
      applyFilters([event], selectedUserId, selectedColors).length ? [...prev, event] : prev,
    );
    void persistence?.onEventAdded?.(event);
  };

  const updateEvent = (event: IEvent) => {
    const updated = {
      ...event,
      startDate: new Date(event.startDate).toISOString(),
      endDate: new Date(event.endDate).toISOString(),
    };

    const previous = allEvents.find((e) => e.id === event.id);
    const nextAll = allEvents.map((e) => (e.id === event.id ? updated : e));
    setAllEvents(nextAll);
    // Re-derive instead of in-place mapping: the update may change fields the
    // active filters key on (calendar, color).
    setFilteredEvents(applyFilters(nextAll, selectedUserId, selectedColors));
    void persistence?.onEventUpdated?.(updated, previous);
  };

  const removeEvent = (eventId: string) => {
    const removed = allEvents.find((e) => e.id === eventId);
    setAllEvents((prev) => prev.filter((e) => e.id !== eventId));
    setFilteredEvents((prev) => prev.filter((e) => e.id !== eventId));
    if (removed) void persistence?.onEventRemoved?.(removed);
  };

  const clearFilter = () => {
    setFilteredEvents(allEvents);
    setSelectedColors([]);
    setSelectedUserId('all');
  };

  const value = {
    selectedDate,
    setSelectedDate: handleSelectDate,
    selectedUserId,
    setSelectedUserId,
    badgeVariant,
    setBadgeVariant,
    users,
    selectedColors,
    filterEventsBySelectedColors,
    filterEventsBySelectedUser,
    events: filteredEvents,
    view: currentView,
    use24HourFormat,
    toggleTimeFormat,
    hourHeight,
    setHourHeight,
    setView,
    agendaModeGroupBy,
    setAgendaModeGroupBy,
    addEvent,
    updateEvent,
    removeEvent,
    clearFilter,
  };

  return <CalendarContext.Provider value={value}>{children}</CalendarContext.Provider>;
}

export function useCalendar(): ICalendarContext {
  const context = useContext(CalendarContext);
  if (!context) throw new Error('useCalendar must be used within a CalendarProvider.');
  return context;
}
