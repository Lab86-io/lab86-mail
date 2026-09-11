import { CalendarRange, ChevronDown, Columns, Grid2X2, Grid3X3, List } from 'lucide-react';
import { memo } from 'react';
import { useCalendar } from '@/components/calendar/engine/calendar-context';
import { TCalendarView } from '@/components/calendar/engine/types';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';

const tabs = [
  {
    name: 'Agenda',
    value: 'agenda',
    icon: () => <CalendarRange className="h-4 w-4" />,
  },
  {
    name: 'Day',
    value: 'day',
    icon: () => <List className="h-4 w-4" />,
  },
  {
    name: 'Week',
    value: 'week',
    icon: () => <Columns className="h-4 w-4" />,
  },
  {
    name: 'Month',
    value: 'month',
    icon: () => <Grid3X3 className="h-4 w-4" />,
  },
  {
    name: 'Year',
    value: 'year',
    icon: () => <Grid2X2 className="h-4 w-4" />,
  },
];

function Views() {
  const { view, setView } = useCalendar();

  return (
    <>
      <div className="calendar-view-menu">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="sm" aria-label="Calendar view">
              {tabs.find((tab) => tab.value === view)?.icon()}
              {tabs.find((tab) => tab.value === view)?.name}
              <ChevronDown className="size-3.5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            <DropdownMenuRadioGroup value={view} onValueChange={(value) => setView(value as TCalendarView)}>
              {tabs.map(({ name, value, icon: Icon }) => (
                <DropdownMenuRadioItem key={value} value={value}>
                  <Icon />
                  {name}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <Tabs
        value={view}
        onValueChange={(value) => setView(value as TCalendarView)}
        className="calendar-view-tabs min-w-0"
      >
        <TabsList aria-label="Calendar view" className="h-8 gap-0.5 rounded-ui bg-[var(--color-control)] p-0">
          {tabs.map(({ icon: Icon, name, value }) => (
            <TabsTrigger
              key={value}
              value={value}
              aria-label={name}
              title={name}
              className="h-7 min-w-7 flex-none gap-1.5 px-1.5 text-xs data-[state=active]:bg-[var(--color-accent-soft)] data-[state=active]:text-[var(--color-accent)]"
            >
              <Icon />
              {view === value ? <span className="font-normal">{name}</span> : null}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>
    </>
  );
}

export default memo(Views);
