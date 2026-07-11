import {
  checkinIsDue,
  parseWorkSplit,
  projectPromotionDecision,
  shouldComposeWorkBrief,
} from '../lib/albatross/work-v2';

type Scenario = { name: string; run: () => boolean };

const scenarios: Scenario[] = [
  {
    name: 'independent outcomes split without losing the raw capture',
    run: () => {
      const raw = 'Prepare the launch note and book the dentist appointment.';
      const parsed = parseWorkSplit(
        JSON.stringify({
          work: [
            { title: 'Prepare launch note', rawText: 'Prepare the launch note', relatedAreaNames: [] },
            { title: 'Book dentist', rawText: 'Book the dentist appointment', relatedAreaNames: [] },
          ],
        }),
        raw,
      );
      return (
        parsed.work.length === 2 &&
        parsed.work.some((item) => item.rawText.includes('launch note')) &&
        parsed.work.some((item) => item.rawText.includes('dentist appointment'))
      );
    },
  },
  {
    name: 'multi-task Work becomes a Project/Epic',
    run: () =>
      projectPromotionDecision({
        actions: [
          { kind: 'task', title: 'Outline' },
          { kind: 'task', title: 'Draft' },
          { kind: 'task', title: 'Review' },
        ],
      }).promote,
  },
  {
    name: 'simple Work does not generate a full HTML brief',
    run: () => !shouldComposeWorkBrief({ actions: [{ kind: 'task', title: 'Make the call' }] }),
  },
  {
    name: 'evening check-in respects the user local clock',
    run: () =>
      checkinIsDue(
        {
          timezone: 'America/New_York',
          eveningCheckinEnabled: true,
          eveningCheckinLocalTime: '19:00',
          emailFallbackDelayMinutes: 90,
        },
        new Date('2026-07-10T23:04:00Z'),
      ),
  },
];

let failed = 0;
for (const scenario of scenarios) {
  const passed = scenario.run();
  if (!passed) failed += 1;
  console.log(`${passed ? 'PASS' : 'FAIL'}  ${scenario.name}`);
}

if (failed) {
  console.error(`\n${failed} Albatross scenario${failed === 1 ? '' : 's'} failed.`);
  process.exit(1);
}
console.log(`\n${scenarios.length} Albatross scenarios passed.`);
