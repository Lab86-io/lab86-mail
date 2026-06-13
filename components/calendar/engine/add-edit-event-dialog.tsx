import { zodResolver } from '@hookform/resolvers/zod';
import { addMinutes, format, set } from 'date-fns';
import { type ReactNode, useEffect, useMemo } from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';
import { useCalendar } from '@/components/calendar/engine/calendar-context';
import { useDisclosure } from '@/components/calendar/engine/hooks';
import type { IEvent } from '@/components/calendar/engine/interfaces';
import { eventSchema, type TEventFormData } from '@/components/calendar/engine/schemas';

import { Button } from '@/components/ui/button';
import { DateTimePicker } from '@/components/ui/date-time-picker';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import {
  Modal,
  ModalClose,
  ModalContent,
  ModalDescription,
  ModalFooter,
  ModalHeader,
  ModalTitle,
  ModalTrigger,
} from '@/components/ui/responsive-modal';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';

interface IProps {
  children: ReactNode;
  startDate?: Date;
  startTime?: { hour: number; minute: number };
  event?: IEvent;
}

export function AddEditEventDialog({ children, startDate, startTime, event }: IProps) {
  const { isOpen, onClose, onToggle } = useDisclosure();
  const { addEvent, updateEvent, writableCalendars } = useCalendar();
  const isEditing = !!event;

  const initialDates = useMemo(() => {
    if (!isEditing && !event) {
      if (!startDate) {
        const now = new Date();
        return { startDate: now, endDate: addMinutes(now, 30) };
      }
      const start = startTime
        ? set(new Date(startDate), {
            hours: startTime.hour,
            minutes: startTime.minute,
            seconds: 0,
          })
        : new Date(startDate);
      const end = addMinutes(start, 30);
      return { startDate: start, endDate: end };
    }

    return {
      startDate: new Date(event.startDate),
      endDate: new Date(event.endDate),
    };
  }, [startDate, startTime, event, isEditing]);

  const form = useForm<TEventFormData>({
    resolver: zodResolver(eventSchema),
    defaultValues: {
      title: event?.title ?? '',
      description: event?.description ?? '',
      startDate: initialDates.startDate,
      endDate: initialDates.endDate,
      calendarId: event?.calendarId ?? writableCalendars[0]?.id ?? '',
      repeat: 'none' as const,
      attendees: '',
    },
  });

  useEffect(() => {
    form.reset({
      title: event?.title ?? '',
      description: event?.description ?? '',
      startDate: initialDates.startDate,
      endDate: initialDates.endDate,
      calendarId: event?.calendarId ?? writableCalendars[0]?.id ?? '',
      repeat: 'none' as const,
      attendees: '',
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [event, initialDates, form]);

  const onSubmit = (values: TEventFormData) => {
    try {
      const chosen = writableCalendars.find((cal) => cal.id === values.calendarId);
      const attendees = (values.attendees || '')
        .split(/[,;\s]+/)
        .map((email) => email.trim())
        .filter((email) => email.includes('@'));
      const repeatRule =
        values.repeat && values.repeat !== 'none' ? [`RRULE:FREQ=${values.repeat.toUpperCase()}`] : undefined;
      const formattedEvent: IEvent = {
        title: values.title,
        description: values.description || '',
        startDate: format(values.startDate, "yyyy-MM-dd'T'HH:mm:ss"),
        endDate: format(values.endDate, "yyyy-MM-dd'T'HH:mm:ss"),
        id: isEditing ? event.id : `local_${Date.now()}_${Math.floor(Math.random() * 1e6)}`,
        user: isEditing ? event.user : { id: chosen?.id || '', name: chosen?.name || '', picturePath: null },
        color: 'blue',
        colorHex: isEditing ? event.colorHex : chosen?.colorHex,
        calendarId: isEditing ? event.calendarId : chosen?.id,
        accountId: isEditing ? event.accountId : chosen?.accountId,
        recurrence: repeatRule ?? (isEditing ? event.recurrence : undefined),
        participants: attendees.length
          ? attendees.map((email) => ({ email }))
          : isEditing
            ? event.participants
            : undefined,
      };

      if (isEditing) {
        updateEvent(formattedEvent);
        toast.success('Event updated successfully');
      } else {
        addEvent(formattedEvent);
        toast.success('Event created successfully');
      }

      onClose();
      form.reset();
    } catch (error) {
      console.error(`Error ${isEditing ? 'editing' : 'adding'} event:`, error);
      toast.error(`Failed to ${isEditing ? 'edit' : 'add'} event`);
    }
  };

  return (
    <Modal open={isOpen} onOpenChange={onToggle} modal={false}>
      <ModalTrigger asChild>{children}</ModalTrigger>
      <ModalContent>
        <ModalHeader>
          <ModalTitle>{isEditing ? 'Edit Event' : 'Add New Event'}</ModalTitle>
          <ModalDescription>
            {isEditing ? 'Modify your existing event.' : 'Create a new event for your calendar.'}
          </ModalDescription>
        </ModalHeader>

        <Form {...form}>
          <form id="event-form" onSubmit={form.handleSubmit(onSubmit)} className="grid gap-4 py-4">
            <FormField
              control={form.control}
              name="title"
              render={({ field, fieldState }) => (
                <FormItem>
                  <FormLabel htmlFor="title" className="required">
                    Title
                  </FormLabel>
                  <FormControl>
                    <Input
                      id="title"
                      placeholder="Enter a title"
                      {...field}
                      className={fieldState.invalid ? 'border-red-500' : ''}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="startDate"
              render={({ field }) => <DateTimePicker form={form} field={field} />}
            />
            <FormField
              control={form.control}
              name="endDate"
              render={({ field }) => <DateTimePicker form={form} field={field} />}
            />
            {!isEditing ? (
              <FormField
                control={form.control}
                name="calendarId"
                render={({ field, fieldState }) => (
                  <FormItem>
                    <FormLabel className="required">Calendar</FormLabel>
                    <FormControl>
                      <Select value={field.value} onValueChange={field.onChange}>
                        <SelectTrigger className={`w-full ${fieldState.invalid ? 'border-red-500' : ''}`}>
                          <SelectValue placeholder="Choose a calendar" />
                        </SelectTrigger>
                        <SelectContent>
                          {writableCalendars.map((cal) => (
                            <SelectItem value={cal.id} key={cal.id}>
                              <div className="flex items-center gap-2">
                                <div
                                  className="size-3.5 rounded-full"
                                  style={{ backgroundColor: cal.colorHex }}
                                />
                                {cal.name}
                              </div>
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            ) : null}
            <div className="grid grid-cols-2 gap-3">
              <FormField
                control={form.control}
                name="repeat"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Repeats</FormLabel>
                    <FormControl>
                      <Select value={field.value} onValueChange={field.onChange}>
                        <SelectTrigger className="w-full">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="none">Never</SelectItem>
                          <SelectItem value="daily">Daily</SelectItem>
                          <SelectItem value="weekly">Weekly</SelectItem>
                          <SelectItem value="monthly">Monthly</SelectItem>
                        </SelectContent>
                      </Select>
                    </FormControl>
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="attendees"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Invite (emails)</FormLabel>
                    <FormControl>
                      <Input {...field} placeholder="a@x.com, b@y.com" />
                    </FormControl>
                  </FormItem>
                )}
              />
            </div>
            <FormField
              control={form.control}
              name="description"
              render={({ field, fieldState }) => (
                <FormItem>
                  <FormLabel>Description</FormLabel>
                  <FormControl>
                    <Textarea
                      {...field}
                      placeholder="Enter a description"
                      className={fieldState.invalid ? 'border-red-500' : ''}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
          </form>
        </Form>
        <ModalFooter className="flex justify-end gap-2">
          <ModalClose asChild>
            <Button type="button" variant="outline">
              Cancel
            </Button>
          </ModalClose>
          <Button form="event-form" type="submit">
            {isEditing ? 'Save Changes' : 'Create Event'}
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}
