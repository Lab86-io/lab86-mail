import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  appendTranscript,
  CAPTURE_BUTTON_LABEL,
  looksLikeMultipleIntents,
  speechRecognitionAvailable,
  splitIntentText,
  transcriptOf,
} from '../components/albatross/IntentCapture';

describe('the capture door name', () => {
  // It used to rotate through five labels, so the most important control in
  // the product had no fixed name and its accessible name drifted from the
  // visible one.
  test('is one stable phrase', () => {
    expect(CAPTURE_BUTTON_LABEL).toBe('Get this off my mind');
  });

  test('does not describe the object as a task, an idea, or work', () => {
    expect(CAPTURE_BUTTON_LABEL.toLowerCase()).not.toContain('idea');
    expect(CAPTURE_BUTTON_LABEL.toLowerCase()).not.toContain('work');
    expect(CAPTURE_BUTTON_LABEL.toLowerCase()).not.toContain('task');
  });
});

describe('the takeover is retired', () => {
  const source = readFileSync('components/albatross/IntentCapture.tsx', 'utf8');

  test('no full-screen dialog, no floating pill, no state machine', () => {
    expect(source).not.toContain('role="dialog"');
    expect(source).not.toContain('fixed bottom-6 right-6');
    expect(source).not.toContain('nextCaptureState');
    expect(source).not.toContain('openPipWindow');
    expect(source).not.toContain('captureOpen');
  });

  test('the shell mounts no launcher', () => {
    const shell = readFileSync('components/shell/AppShell.tsx', 'utf8');
    expect(shell).not.toContain('IntentCaptureLauncher');
  });

  test('the split helpers still pass through', () => {
    expect(looksLikeMultipleIntents('renew passport\nfile taxes\ncall the dentist')).toBe(true);
    expect(splitIntentText('one loose thought')).toEqual(['one loose thought']);
  });
});

describe('voice capture', () => {
  test('joins the results of one recognition event', () => {
    expect(transcriptOf({ results: [[{ transcript: 'book the ' }], [{ transcript: 'dentist' }]] })).toBe(
      'book the dentist',
    );
    expect(transcriptOf({ results: [] })).toBe('');
  });

  test('the spoken tail follows the typed text and replaces itself as it grows', () => {
    expect(appendTranscript('', 'book the dentist')).toBe('book the dentist');
    expect(appendTranscript('  Tomorrow: ', 'book')).toBe('Tomorrow: book');
    expect(appendTranscript('Tomorrow:', 'book the dentist')).toBe('Tomorrow: book the dentist');
  });

  test('support needs a SpeechRecognition constructor', () => {
    expect(speechRecognitionAvailable(undefined)).toBe(false);
    expect(speechRecognitionAvailable({})).toBe(false);
    expect(speechRecognitionAvailable({ webkitSpeechRecognition: class {} })).toBe(true);
    expect(speechRecognitionAvailable({ SpeechRecognition: class {} })).toBe(true);
  });
});
