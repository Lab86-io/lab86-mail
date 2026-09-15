/**
 * Themed Collabora chrome: the URL parameters, the light and dark variable
 * maps, and the ordered host messages sent after the document loads. Every
 * function here is pure so the client, the server and the live verification
 * script share one source of truth. Facts about the 26.04 build are in
 * docs/research/collabora-26.04-host-contract.md.
 */

export type EditorTheme = 'light' | 'dark';
export type EditorExtension = 'docx' | 'xlsx' | 'pptx';
export type EditorUiMode = 'classic' | 'notebookbar';

export interface HostMessage {
  MessageId: string;
  Values: Record<string, unknown>;
}

/** Id of the host button inserted before Undo. A click arrives as `Clicked_Button {Id}`. */
export const ALBATROSS_BUTTON_ID = 'albatross';
/** Path under the app origin that serves the toolbar icon. */
export const ALBATROSS_BUTTON_ICON_PATH = '/office/albatross-toolbar.svg';

/* ------------------------------------------------------------------ */
/* Color helpers                                                       */
/* ------------------------------------------------------------------ */

function clamp01(value: number) {
  return Math.min(1, Math.max(0, value));
}

function gammaEncode(linear: number) {
  const value = clamp01(linear);
  return value <= 0.0031308 ? 12.92 * value : 1.055 * value ** (1 / 2.4) - 0.055;
}

function channelToHex(value: number) {
  return Math.round(clamp01(value) * 255)
    .toString(16)
    .padStart(2, '0');
}

/**
 * Convert an OKLCH color to an sRGB hex string. Out-of-gamut channels are
 * clipped. Inputs follow the CSS form: lightness 0 to 1, chroma 0 or more,
 * hue in degrees.
 */
export function oklchToHex(lightness: number, chroma: number, hue: number) {
  const radians = (hue * Math.PI) / 180;
  const a = chroma * Math.cos(radians);
  const b = chroma * Math.sin(radians);
  const lPrime = lightness + 0.3963377774 * a + 0.2158037573 * b;
  const mPrime = lightness - 0.1055613458 * a - 0.0638541728 * b;
  const sPrime = lightness - 0.0894841775 * a - 1.291485548 * b;
  const l = lPrime ** 3;
  const m = mPrime ** 3;
  const s = sPrime ** 3;
  const red = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
  const green = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
  const blue = -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s;
  return `#${channelToHex(gammaEncode(red))}${channelToHex(gammaEncode(green))}${channelToHex(gammaEncode(blue))}`;
}

/* ------------------------------------------------------------------ */
/* Token maps                                                          */
/* ------------------------------------------------------------------ */

/**
 * Albatross defaults from app/globals.css: accent hue 156 with chroma 0.09,
 * background hue 156, surface tint 0, depth spread 1. The maps use these
 * defaults because the editor page is served once and cannot follow the
 * theme panel live.
 */
const ACCENT_HUE = 156;
const ACCENT_CHROMA = 0.09;
const BG_HUE = 156;

/** The font stack stays unquoted: the parameter parser rejects quotes. */
const FONT_STACK = 'Geist, ui-sans-serif, system-ui, sans-serif';
const RADIUS = '9.5px';

const LIGHT_TOKENS = {
  accent: oklchToHex(0.45, ACCENT_CHROMA, ACCENT_HUE),
  accentHover: oklchToHex(0.39, ACCENT_CHROMA, ACCENT_HUE),
  accentDeep: oklchToHex(0.33, ACCENT_CHROMA, ACCENT_HUE),
  accentTint: oklchToHex(0.93, 0.03, ACCENT_HUE),
  accentForeground: '#ffffff',
  text: '#17202a',
  bg: oklchToHex(0.977, 0.005, BG_HUE),
  bgElevated: oklchToHex(0.995, 0, BG_HUE),
  border: oklchToHex(0.905, 0.01, BG_HUE),
  danger: '#d54848',
  warning: '#c27803',
  success: '#159a74',
};

const DARK_TOKENS = {
  accent: oklchToHex(0.73, ACCENT_CHROMA * 0.78, ACCENT_HUE),
  accentHover: oklchToHex(0.79, ACCENT_CHROMA * 0.78, ACCENT_HUE),
  accentDeep: oklchToHex(0.85, 0.06, ACCENT_HUE),
  accentTint: oklchToHex(0.3, 0.03, ACCENT_HUE),
  accentForeground: oklchToHex(0.17, ACCENT_CHROMA * 0.4, ACCENT_HUE),
  text: '#ededed',
  bg: oklchToHex(0.145, 0.006, BG_HUE),
  bgElevated: oklchToHex(0.22, 0, BG_HUE),
  border: oklchToHex(0.31, 0, BG_HUE),
  danger: '#e1655c',
  warning: '#d49a4d',
  success: '#5fb289',
};

/** The variable map for one theme, keyed by the names the 26.04 stylesheet defines. */
export function collaboraCssVariableMap(theme: EditorTheme): Record<string, string> {
  const tokens = theme === 'dark' ? DARK_TOKENS : LIGHT_TOKENS;
  return {
    '--color-primary': tokens.accent,
    '--color-primary-dark': tokens.accentHover,
    '--color-primary-darker': tokens.accentDeep,
    '--color-primary-lighter': tokens.accentTint,
    '--color-primary-text': tokens.accentForeground,
    '--color-main-text': tokens.text,
    '--color-main-background': tokens.bg,
    '--color-background-lighter': tokens.bgElevated,
    '--color-border': tokens.border,
    '--color-toolbar-border': tokens.border,
    '--cool-font': FONT_STACK,
    '--border-radius': RADIUS,
    '--color-error': tokens.danger,
    '--color-warning': tokens.warning,
    '--color-success': tokens.success,
  };
}

/* ------------------------------------------------------------------ */
/* css_variables                                                       */
/* ------------------------------------------------------------------ */

/**
 * The server keeps a token only when every character is printable ASCII and
 * none of these appear: quotes, angle brackets, braces, ampersand, pipe,
 * backslash, caret, backtick, dollar sign, square brackets.
 */
const FORBIDDEN_CSS_CHARACTER = /["'<>{}&|\\^`$[\]]|[^\x20-\x7e]/;

/** True when the value survives the document server's `isValidCss` check. */
export function isSafeCssValue(value: string) {
  return value.length > 0 && !FORBIDDEN_CSS_CHARACTER.test(value);
}

/** True when the name is a custom property name without forbidden characters. */
export function isSafeCssVariableName(name: string) {
  return /^--[a-zA-Z0-9-]+$/.test(name);
}

/**
 * Serialize a variable map to the `css_variables` wire format. Entries with a
 * forbidden character are dropped, never escaped, so one bad value cannot
 * break the whole sheet.
 */
export function serializeCssVariables(variables: Record<string, string>) {
  return Object.entries(variables)
    .filter(([name, value]) => isSafeCssVariableName(name) && isSafeCssValue(value) && !value.includes(';'))
    .map(([name, value]) => `${name}=${value}`)
    .join(';');
}

/** The `css_variables` value for one theme. */
export function collaboraCssVariables(theme: EditorTheme) {
  return serializeCssVariables(collaboraCssVariableMap(theme));
}

/* ------------------------------------------------------------------ */
/* ui_defaults                                                         */
/* ------------------------------------------------------------------ */

const DOC_TYPE_PREFIX: Record<EditorExtension, string> = {
  docx: 'Text',
  xlsx: 'Spreadsheet',
  pptx: 'Presentation',
};

/**
 * Compact classic chrome: one toolbar row, no sidebar, no ruler, a status bar.
 * `SavedUIState=false` makes these defaults win over the user's saved state.
 * `UITheme=dark` darkens the chrome; the page render is restored by a
 * post-load message.
 */
export function collaboraUiDefaults(extension: EditorExtension, theme: EditorTheme) {
  const prefix = DOC_TYPE_PREFIX[extension];
  const parts = ['UIMode=classic', 'SavedUIState=false'];
  if (theme === 'dark') parts.push('UITheme=dark');
  if (extension === 'docx') parts.push('TextRuler=false');
  parts.push(`${prefix}Sidebar=false`, `${prefix}Statusbar=true`);
  return parts.join(';');
}

/* ------------------------------------------------------------------ */
/* Editor URL                                                          */
/* ------------------------------------------------------------------ */

/** Add the chrome parameters to the editor URL. Existing parameters are kept. */
export function editorUrlWithChrome(
  editorUrl: string,
  options: { theme: EditorTheme; extension: EditorExtension },
) {
  const url = new URL(editorUrl);
  url.searchParams.set('ui_defaults', collaboraUiDefaults(options.extension, options.theme));
  url.searchParams.set('css_variables', collaboraCssVariables(options.theme));
  return url.toString();
}

/* ------------------------------------------------------------------ */
/* Post-load messages                                                  */
/* ------------------------------------------------------------------ */

/**
 * The ordered host messages to post after `App_LoadingStatus` reports
 * `Document_Loaded`. Under a dark theme the last message returns the page
 * render to white while the chrome stays dark.
 */
export function postLoadHostMessages(options: { theme: EditorTheme; appOrigin: string }): HostMessage[] {
  const messages: HostMessage[] = [
    { MessageId: 'Hide_Menubar', Values: {} },
    { MessageId: 'Hide_Command', Values: { id: '.uno:Save' } },
    { MessageId: 'Hide_Command', Values: { id: '.uno:Print' } },
    {
      MessageId: 'Insert_Button',
      Values: {
        id: ALBATROSS_BUTTON_ID,
        imgurl: new URL(ALBATROSS_BUTTON_ICON_PATH, options.appOrigin).toString(),
        hint: 'Ask Albatross',
        label: 'Albatross',
        insertBefore: 'undo',
      },
    },
  ];
  if (options.theme === 'dark')
    messages.push({
      MessageId: 'Send_UNO_Command',
      Values: { Command: '.uno:ChangeTheme', Args: { NewTheme: { type: 'string', value: 'Light' } } },
    });
  return messages;
}

/** The message that switches the toolbar mode live. The editor replies with `Action_ChangeUIMode_Resp`. */
export function changeUiModeMessage(mode: EditorUiMode): HostMessage {
  return { MessageId: 'Action_ChangeUIMode', Values: { Mode: mode } };
}

/* ------------------------------------------------------------------ */
/* Theme resolution                                                    */
/* ------------------------------------------------------------------ */

/**
 * The application theme as the stylesheet sees it: next-themes writes the
 * `dark` class on the root element. Read once when the frame mounts, because
 * the editor page cannot change its theme after load.
 */
export function resolveEditorTheme(root: { classList: { contains: (token: string) => boolean } } | null) {
  return root?.classList.contains('dark') ? 'dark' : 'light';
}

/** The label of the mode toggle for the mode the editor currently shows. */
export function uiModeToggleLabel(mode: EditorUiMode) {
  return mode === 'notebookbar' ? 'Compact tools' : 'All tools';
}
