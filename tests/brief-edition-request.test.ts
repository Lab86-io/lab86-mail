import { describe, expect, test } from 'bun:test';
import {
  briefEditionIdFromSearch,
  requestBriefEdition,
  useBriefEditionRequest,
} from '../components/report/brief-edition-request';

describe('brief edition request', () => {
  test('reads ?brief=<id> from the shell search string', () => {
    expect(briefEditionIdFromSearch('?view=today&brief=report-9')).toBe('report-9');
    expect(briefEditionIdFromSearch('?view=today')).toBeNull();
    expect(briefEditionIdFromSearch('?brief=%20')).toBeNull();
  });

  test('holds one trimmed request until a consumer clears it', () => {
    requestBriefEdition(' report-3 ');
    expect(useBriefEditionRequest.getState().reportId).toBe('report-3');
    useBriefEditionRequest.getState().clear();
    expect(useBriefEditionRequest.getState().reportId).toBeNull();
    requestBriefEdition(null);
    expect(useBriefEditionRequest.getState().reportId).toBeNull();
  });
});
