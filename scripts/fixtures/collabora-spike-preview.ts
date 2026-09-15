/**
 * Spike harness page: a bare Collabora iframe with host-side instrumentation.
 * Exposes window.__post(MessageId, Values), window.__inbox (every message the
 * editor sent us) and window.__state. Built by scripts/spike-collabora-customization.ts.
 */
type Session = {
  documentId: string;
  serverUrl: string;
  editorUrl: string;
  accessToken: string;
  accessTokenTtl: number;
};
declare global {
  interface Window {
    __session: Session;
    __extraParams: Record<string, string>;
    __inbox: Array<{ at: number; MessageId: string; Values: unknown }>;
    __state: string;
    __post: (MessageId: string, Values?: Record<string, unknown>) => void;
  }
}
const session = window.__session;
const url = new URL(session.editorUrl);
for (const [key, value] of Object.entries(window.__extraParams || {})) url.searchParams.set(key, value);
window.__inbox = [];
window.__state = 'Loading';
const stateLabel = document.createElement('div');
stateLabel.id = 'state';
stateLabel.textContent = window.__state;
document.body.appendChild(stateLabel);
const frame = document.createElement('iframe');
frame.name = 'spike-editor';
frame.title = 'Document editor';
frame.setAttribute('allow', 'clipboard-read; clipboard-write; fullscreen');
frame.style.cssText = 'position:fixed;inset:24px 0 0 0;width:100%;height:calc(100% - 24px);border:0';
const form = document.createElement('form');
form.action = url.toString();
form.method = 'post';
form.target = frame.name;
form.style.display = 'none';
for (const [name, value] of [
  ['access_token', session.accessToken],
  ['access_token_ttl', String(session.accessTokenTtl)],
]) {
  const input = document.createElement('input');
  input.type = 'hidden';
  input.name = name;
  input.value = value;
  form.appendChild(input);
}
document.body.appendChild(form);
document.body.appendChild(frame);
window.__post = (MessageId, Values = {}) =>
  frame.contentWindow?.postMessage(
    JSON.stringify({ MessageId, SendTime: Date.now(), Values }),
    session.serverUrl,
  );
window.addEventListener('message', (event) => {
  if (event.origin !== session.serverUrl || event.source !== frame.contentWindow) return;
  let message: any;
  try {
    message = typeof event.data === 'string' ? JSON.parse(event.data) : event.data;
  } catch {
    return;
  }
  if (!message?.MessageId) return;
  window.__inbox.push({ at: Date.now(), MessageId: message.MessageId, Values: message.Values });
  if (message.MessageId === 'App_LoadingStatus') {
    window.__post('Host_PostmessageReady');
    if (message.Values?.Status === 'Document_Loaded') window.__state = 'Ready';
  }
  if (message.MessageId === 'Doc_ModifiedStatus')
    window.__state = message.Values?.Modified ? 'Modified' : 'Ready';
  stateLabel.textContent = window.__state;
});
frame.addEventListener('load', () => window.__post('Host_PostmessageReady'));
form.submit();

export {};
