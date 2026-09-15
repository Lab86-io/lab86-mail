import { useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { CollaboraFrame, type CollaboraHandle } from '../../components/files/CollaboraFrame';
import type { EditorTheme, EditorUiMode } from '../../lib/documents/collabora-chrome';

/**
 * Verification page for the real CollaboraFrame component. The host script
 * sets `window.__session` (with `chrome.enabled` and `extension`) and an
 * optional `window.__theme`. Every message the editor sends is copied to
 * `window.__inbox` for diagnosis. No top-level `status` binding: a bundled
 * browser script would collide with `window.status`.
 */
declare global {
  interface Window {
    __theme?: EditorTheme;
    __inbox: Array<{ at: number; MessageId: string; Values: unknown }>;
  }
}
const session = (window as any).__session;

window.__inbox = [];
window.addEventListener('message', (event) => {
  if (event.origin !== session?.serverUrl) return;
  let message: any;
  try {
    message = typeof event.data === 'string' ? JSON.parse(event.data) : event.data;
  } catch {
    return;
  }
  if (message?.MessageId)
    window.__inbox.push({ at: Date.now(), MessageId: message.MessageId, Values: message.Values });
});

function App() {
  const ref = useRef<CollaboraHandle>(null);
  const [closed, setClosed] = useState(false);
  const [ready, setReady] = useState(false);
  const [changed, setChanged] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const [uiMode, setUiMode] = useState<EditorUiMode>('classic');
  const [albatrossClicks, setAlbatrossClicks] = useState(0);
  return (
    <main style={{ height: '100vh', display: 'flex', flexDirection: 'column' }}>
      <header style={{ padding: 12 }}>
        <span id="state">{error || (ready ? (changed ? 'Modified' : 'Ready') : 'Loading')}</span>{' '}
        <button
          type="button"
          id="save"
          disabled={!ready}
          onClick={() => {
            setSaved(false);
            ref
              .current!.save()
              .then(() => setSaved(true))
              .catch((e) => setError(e.message));
          }}
        >
          Save
        </button>
        <button type="button" onClick={() => setClosed(true)}>
          Close editor
        </button>
        <button
          type="button"
          id="all-tools"
          disabled={!ready}
          aria-pressed={uiMode === 'notebookbar'}
          onClick={() => ref.current?.setUiMode(uiMode === 'notebookbar' ? 'classic' : 'notebookbar')}
        >
          {uiMode === 'notebookbar' ? 'Compact tools' : 'All tools'}
        </button>
        <span id="saved">{saved ? 'Saved' : ''}</span> <span id="uimode">{uiMode}</span>{' '}
        <span id="albatross-clicks">{albatrossClicks}</span>
      </header>
      <div style={{ flex: 1, minHeight: 0 }}>
        {!closed && (
          <CollaboraFrame
            ref={ref}
            session={session}
            theme={window.__theme}
            onReady={setReady}
            onModified={setChanged}
            onError={setError}
            onUiMode={setUiMode}
            onAlbatross={() => setAlbatrossClicks((count) => count + 1)}
          />
        )}
      </div>
    </main>
  );
}
createRoot(document.getElementById('root')!).render(<App />);
