import { useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { CollaboraFrame, type CollaboraHandle } from '../../components/files/CollaboraFrame';

function App() {
  const ref = useRef<CollaboraHandle>(null);
  const [closed, setClosed] = useState(false);
  const [ready, setReady] = useState(false);
  const [changed, setChanged] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
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
        <span id="saved">{saved ? 'Saved' : ''}</span>
      </header>
      <div style={{ flex: 1, minHeight: 0 }}>
        {!closed && (
          <CollaboraFrame
            ref={ref}
            session={(window as any).__session}
            onReady={setReady}
            onModified={setChanged}
            onError={setError}
          />
        )}
      </div>
    </main>
  );
}
createRoot(document.getElementById('root')!).render(<App />);
