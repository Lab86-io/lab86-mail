import { BellIcon } from '@/components/ui/bell';
import { CalendarDaysIcon } from '@/components/ui/calendar-days';
import { CircleCheckIcon } from '@/components/ui/circle-check';
import { FileTextIcon } from '@/components/ui/file-text';
import { FolderIcon } from '@/components/ui/folder';
import { MailCheckIcon } from '@/components/ui/mail-check';
import { MessageCircleIcon } from '@/components/ui/message-circle';

/** Shared by the rail and global search so the same destination has one icon. */
export const RAIL_SURFACE_ICONS = {
  today: FileTextIcon,
  albatrosses: CircleCheckIcon,
  mail: MailCheckIcon,
  calendar: CalendarDaysIcon,
  files: FolderIcon,
  chat: MessageCircleIcon,
  notifications: BellIcon,
};
