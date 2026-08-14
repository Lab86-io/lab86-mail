import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const source = (path: string) => readFileSync(path, 'utf8');

describe('the execution loop owns the visible product surfaces', () => {
  test('web Today and Work Detail mount current-move guidance and recovery', () => {
    const today = source('components/report/TodaySurface.tsx');
    const detail = source('components/albatross/WorkDetail.tsx');

    expect(today).toContain('executionSnapshot');
    expect(today).toContain('Do this next');
    expect(today).toContain('<LapsePrompt');
    expect(detail).toContain('<GuidedStepPane');
  });

  test('the notification surface leads with Work and leaves mail in Mail', () => {
    const center = source('components/shell/NotificationCenter.tsx');

    expect(center).toContain('executionSnapshot');
    expect(center).toContain('Do this next');
    expect(center).toContain("row.type !== 'mail_message'");
    expect(center).toContain("row.type !== 'urgent_mail'");
    expect(center).not.toContain('SuggestionsTray');
  });

  test('mobile keeps legacy Tasks routable without making it a primary board', () => {
    const navigation = source('apps/ios/Lab86Mail/Features/Shell/NavigationModel.swift');
    const today = source('apps/ios/Lab86Mail/Features/Today/TodayView.swift');
    const activity = source('apps/ios/Lab86Mail/Features/Activity/ActivityView.swift');

    expect(navigation).toContain(
      'static let sourceList: [PrimaryTab] = [.today, .mail, .work, .calendar, .files]',
    );
    expect(navigation).toContain('case .tasks: "Tasks"');
    expect(today).toContain('workExecution.currentMove');
    expect(today).toContain('recoverWork');
    expect(activity).toContain('workExecution.currentMove');
    expect(activity).not.toContain('visibleSuggestions');
  });
});
