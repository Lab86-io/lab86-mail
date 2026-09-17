import { describe, expect, test } from 'bun:test';
import {
  ALBATROSS_BUTTON_ID,
  changeUiModeMessage,
  collaboraCssVariableMap,
  collaboraCssVariables,
  collaboraUiDefaults,
  editorUrlWithChrome,
  isSafeCssValue,
  oklchToHex,
  postLoadHostMessages,
  resolveEditorTheme,
  serializeCssVariables,
  uiModeToggleLabel,
} from '../lib/documents/collabora-chrome';

/** Reference values measured with Chromium's canvas for the same OKLCH inputs. */
const CHROMIUM_REFERENCE: Array<[[number, number, number], string]> = [
  [[1, 0, 0], '#ffffff'],
  [[0, 0, 0], '#000000'],
  [[0.5, 0, 0], '#636363'],
  [[0.977, 0.005, 156], '#f5f8f6'],
  [[0.905, 0.01, 156], '#dbe2dd'],
  [[0.45, 0.09, 156], '#216440'],
  [[0.39, 0.09, 156], '#095330'],
  [[0.145, 0.006, 156], '#080b09'],
  [[0.22, 0, 156], '#1b1b1b'],
  [[0.31, 0, 156], '#303030'],
  [[0.73, 0.0702, 156], '#84b595'],
  [[0.79, 0.0702, 156], '#96c9a8'],
  [[0.17, 0.036, 156], '#021409'],
  [[0.7, 0.15, 30], '#ed7665'],
  [[0.6, 0.2, 260], '#2e79f5'],
];

function channels(hex: string) {
  return [1, 3, 5].map((index) => Number.parseInt(hex.slice(index, index + 2), 16));
}

describe('oklchToHex', () => {
  test('matches Chromium within one step per channel', () => {
    for (const [[l, c, h], expected] of CHROMIUM_REFERENCE) {
      const actual = oklchToHex(l, c, h);
      expect(actual).toMatch(/^#[0-9a-f]{6}$/);
      const delta = channels(actual).map((value, index) => Math.abs(value - channels(expected)[index]));
      expect(Math.max(...delta)).toBeLessThanOrEqual(1);
    }
  });
  test('clips colors outside the sRGB gamut instead of wrapping', () => {
    expect(oklchToHex(0.9, 0.4, 145)).toMatch(/^#[0-9a-f]{6}$/);
    expect(oklchToHex(1.2, 0, 0)).toBe('#ffffff');
    expect(oklchToHex(-0.2, 0, 0)).toBe('#000000');
  });
});

describe('css_variables', () => {
  test('light and dark maps cover the variables the build defines with hex colors', () => {
    const required = [
      '--color-primary',
      '--color-primary-dark',
      '--color-primary-darker',
      '--color-primary-lighter',
      '--color-primary-text',
      '--color-main-text',
      '--color-main-background',
      '--color-background-lighter',
      '--color-border',
      '--color-toolbar-border',
      '--cool-font',
      '--border-radius',
      '--color-error',
      '--color-warning',
      '--color-success',
    ];
    for (const theme of ['light', 'dark'] as const) {
      const map = collaboraCssVariableMap(theme);
      expect(Object.keys(map).sort()).toEqual([...required].sort());
      for (const [name, value] of Object.entries(map)) {
        if (name.startsWith('--color')) expect(value).toMatch(/^#[0-9a-f]{6}$/);
      }
    }
  });
  test('light uses the Albatross light tokens and dark uses the dark tokens', () => {
    const light = collaboraCssVariableMap('light');
    const dark = collaboraCssVariableMap('dark');
    expect(light['--color-main-text']).toBe('#17202a');
    expect(light['--color-primary']).toBe('#216440');
    expect(light['--color-primary-text']).toBe('#ffffff');
    expect(light['--color-main-background']).toBe('#f5f8f6');
    expect(dark['--color-main-text']).toBe('#ededed');
    expect(dark['--color-primary']).toBe('#84b595');
    expect(dark['--color-main-background']).toBe('#080b09');
    expect(dark['--color-background-lighter']).toBe('#1b1b1b');
    expect(dark['--color-border']).toBe('#303030');
    // Dark chrome needs light text on dark surfaces; light values broke input contrast.
    expect(dark['--color-main-text']).not.toBe(light['--color-main-text']);
    expect(dark['--color-main-background']).not.toBe(light['--color-main-background']);
  });
  test('serializes as name=value pairs joined by semicolons with an unquoted font stack', () => {
    const value = collaboraCssVariables('light');
    expect(value).toContain('--color-primary=#216440;');
    expect(value).toContain('--cool-font=Geist, ui-sans-serif, system-ui, sans-serif');
    expect(value).not.toContain('"');
    expect(value).not.toContain("'");
    expect(value).not.toContain(':');
    for (const token of value.split(';')) expect(token.split('=')).toHaveLength(2);
  });
  test('drops any value with a character the server rejects', () => {
    const forbidden = ['"', "'", '<', '>', '{', '}', '&', '|', '\\', '^', '`', '$', '[', ']', 'é', '\n'];
    for (const character of forbidden) expect(isSafeCssValue(`abc${character}def`)).toBe(false);
    expect(isSafeCssValue('')).toBe(false);
    expect(isSafeCssValue('Geist, Helvetica Neue, sans-serif')).toBe(true);
    expect(isSafeCssValue('#3b5bdb')).toBe(true);
    const serialized = serializeCssVariables({
      '--color-primary': '#3b5bdb',
      '--cool-font': '"Geist", sans-serif',
      '--color-border': 'rgb(1,2,3)|x',
      '--color-main-text': '#111}body{color:red',
      '--bad name': '#000',
      '--color-warning': 'a;b',
      '--color-success': 'red',
    });
    expect(serialized).toBe('--color-primary=#3b5bdb;--color-success=red');
  });
});

describe('ui_defaults', () => {
  test('docx gets the compact classic text chrome', () => {
    expect(collaboraUiDefaults('docx', 'light')).toBe(
      'UIMode=classic;SavedUIState=false;TextRuler=false;TextSidebar=false;TextStatusbar=true',
    );
  });
  test('xlsx and pptx use their own prefixes', () => {
    expect(collaboraUiDefaults('xlsx', 'light')).toBe(
      'UIMode=classic;SavedUIState=false;SpreadsheetSidebar=false;SpreadsheetStatusbar=true',
    );
    expect(collaboraUiDefaults('pptx', 'light')).toBe(
      'UIMode=classic;SavedUIState=false;PresentationSidebar=false;PresentationStatusbar=true',
    );
  });
  test('dark adds UITheme=dark before the document type keys', () => {
    expect(collaboraUiDefaults('docx', 'dark')).toBe(
      'UIMode=classic;SavedUIState=false;UITheme=dark;TextRuler=false;TextSidebar=false;TextStatusbar=true',
    );
    expect(collaboraUiDefaults('xlsx', 'dark')).toContain('UITheme=dark');
  });
});

describe('editorUrlWithChrome', () => {
  const editorUrl =
    'https://documents.test/browser/abc123/cool.html?WOPISrc=https%3A%2F%2Fapp.test%2Fapi%2Foffice%2Fwopi%2Fdoc-1&lang=en-US';
  test('keeps the existing parameters and adds both chrome parameters', () => {
    const url = new URL(editorUrlWithChrome(editorUrl, { theme: 'light', extension: 'docx' }));
    expect(url.origin).toBe('https://documents.test');
    expect(url.pathname).toBe('/browser/abc123/cool.html');
    expect(url.searchParams.get('WOPISrc')).toBe('https://app.test/api/office/wopi/doc-1');
    expect(url.searchParams.get('lang')).toBe('en-US');
    expect(url.searchParams.get('ui_defaults')).toBe(collaboraUiDefaults('docx', 'light'));
    expect(url.searchParams.get('css_variables')).toBe(collaboraCssVariables('light'));
  });
  test('dark and spreadsheet options change only the chrome parameters', () => {
    const url = new URL(editorUrlWithChrome(editorUrl, { theme: 'dark', extension: 'xlsx' }));
    expect(url.searchParams.get('ui_defaults')).toContain('UITheme=dark');
    expect(url.searchParams.get('ui_defaults')).toContain('SpreadsheetSidebar=false');
    expect(url.searchParams.get('css_variables')).toContain('--color-main-text=#ededed');
  });
});

describe('postLoadHostMessages', () => {
  test('light posts the hides then the Albatross button, in order', () => {
    const messages = postLoadHostMessages({ theme: 'light', appOrigin: 'https://app.test' });
    expect(messages.map((message) => message.MessageId)).toEqual([
      'Hide_Menubar',
      'Hide_Command',
      'Hide_Command',
      'Insert_Button',
    ]);
    expect(messages[1].Values).toEqual({ id: '.uno:Save' });
    expect(messages[2].Values).toEqual({ id: '.uno:Print' });
    expect(messages[3].Values).toEqual({
      id: ALBATROSS_BUTTON_ID,
      imgurl: 'https://app.test/office/albatross-toolbar.svg',
      hint: 'Ask Albatross',
      label: 'Albatross',
      insertBefore: 'undo',
    });
  });
  test('dark ends with the command that returns the page render to white', () => {
    const messages = postLoadHostMessages({ theme: 'dark', appOrigin: 'https://app.test/' });
    expect(messages).toHaveLength(5);
    expect(messages[4]).toEqual({
      MessageId: 'Send_UNO_Command',
      Values: { Command: '.uno:ChangeTheme', Args: { NewTheme: { type: 'string', value: 'Light' } } },
    });
    expect(messages[3].Values.imgurl).toBe('https://app.test/office/albatross-toolbar.svg');
  });
  test('the icon URL stays on the app origin for nested app paths', () => {
    const [, , , button] = postLoadHostMessages({ theme: 'light', appOrigin: 'https://app.test/mail/' });
    expect(button.Values.imgurl).toBe('https://app.test/office/albatross-toolbar.svg');
  });
});

describe('mode toggle', () => {
  test('the message and the label follow the mode', () => {
    expect(changeUiModeMessage('notebookbar')).toEqual({
      MessageId: 'Action_ChangeUIMode',
      Values: { Mode: 'notebookbar' },
    });
    expect(changeUiModeMessage('classic').Values).toEqual({ Mode: 'classic' });
    expect(uiModeToggleLabel('classic')).toBe('All tools');
    expect(uiModeToggleLabel('notebookbar')).toBe('Compact tools');
  });
  test('the theme follows the dark class on the root element', () => {
    const root = (dark: boolean) => ({
      classList: { contains: (token: string) => dark && token === 'dark' },
    });
    expect(resolveEditorTheme(root(true))).toBe('dark');
    expect(resolveEditorTheme(root(false))).toBe('light');
    expect(resolveEditorTheme(null)).toBe('light');
  });
});
