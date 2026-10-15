// Invented sample data for the Word templates. Used by the tests and by
// scripts/preview-document-templates.ts. No real people or companies.
import type { InvoiceData } from '../../lib/documents/templates/invoice';
import type { LetterData } from '../../lib/documents/templates/letter';
import type { MemoData } from '../../lib/documents/templates/memo';
import type { ReportData } from '../../lib/documents/templates/report';

export const sampleInvoice: InvoiceData = {
  from: {
    name: 'Mara Ellison',
    lines: ['Ellison Design Studio', '214 Harbor Street, Portland, ME 04101', 'mara@example.com'],
  },
  billTo: { name: 'Northwind Clinic', lines: ['Attn: Accounts Payable', '88 Elm Avenue, Salem, MA 01970'] },
  number: 'INV-1042',
  issued: '2026-10-15',
  period: 'July 1 to September 30, 2026',
  engagement: 'Design services under the agreement of June 2, 2026.',
  items: [
    {
      title: 'July 2026',
      summary: 'Patient intake form redesign and two rounds of review with the front desk.',
      hours: 32,
      rate: 95,
    },
    { title: 'August 2026', hours: 41.5, rate: 95 },
    { title: 'September 2026', summary: 'Accessibility audit of the booking pages.', hours: 18, rate: 95 },
  ],
  currency: 'USD',
  notes: 'Thank you for your business.',
};

export const sampleLetter: LetterData = {
  from: { name: 'Mara Ellison', lines: ['214 Harbor Street, Portland, ME 04101', 'mara@example.com'] },
  to: { name: 'Dr. Lena Ortiz', lines: ['Northwind Clinic', '88 Elm Avenue', 'Salem, MA 01970'] },
  date: '2026-10-15',
  subject: 'Proposal for the patient portal redesign',
  body: [
    'Thank you for the meeting last Tuesday. This letter gives the scope and the schedule that we discussed.',
    'The work has three parts:',
    '- A new booking flow that patients can finish in under two minutes.',
    '- A clear view of upcoming visits and forms.',
    '- An accessibility review against WCAG 2.2 AA.',
    'I can start on November 3 and finish by December 19. The fee is $14,200, in two payments.',
  ],
  closing: 'Kind regards,',
  signature: { title: 'Principal, Ellison Design Studio' },
};

export const sampleMemo: MemoData = {
  to: 'Front desk staff',
  from: 'Lena Ortiz, Practice Manager',
  date: '2026-10-15',
  subject: 'New check-in process from November 3',
  body: [
    'From Monday, November 3, patients check in on the tablet at the front desk.',
    '- Ask each patient to confirm the insurance card on the screen.',
    '- Scan a new card when the patient has one.',
    '- Give the tablet a wipe after each use.',
    'Training is on Thursday, October 30, at 8:00 in the break room. Each session takes 30 minutes.',
  ],
};

export const sampleReport: ReportData = {
  title: 'Patient portal use, third quarter 2026',
  subtitle: 'Northwind Clinic',
  author: 'Mara Ellison',
  sections: [
    {
      heading: 'Summary',
      paragraphs: [
        'Online bookings grew in each month of the quarter. Phone bookings fell by about one fifth.',
        'Most patients who started a booking finished it. The intake form is the step where most patients stop.',
      ],
    },
    {
      heading: 'Bookings by month',
      paragraphs: ['The table gives the bookings for each channel.'],
      table: {
        columns: ['Month', 'Online', 'Phone', 'Share online'],
        rows: [
          ['July', '412', '288', '58.9%'],
          ['August', '465', '251', '64.9%'],
          ['September', '503', '230', '68.6%'],
        ],
        caption: 'Source: clinic booking system export of October 2, 2026.',
      },
    },
    {
      heading: 'Next steps',
      paragraphs: [
        '- Shorten the intake form from 22 to 12 questions.',
        '- Send a reminder text 24 hours before each visit.',
      ],
    },
  ],
};
