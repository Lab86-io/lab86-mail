/** Actual presentation tool cards with explicitly synthetic evidence; no account access. */
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { PresentationChoicesPart } from '../../components/ai-elements/presentation-choices';
import {
  type PresentationChoiceInput,
  type PresentationChoiceResult,
  type StoryboardSlide,
} from '../../lib/documents/presentation-choices';

function Preview() {
  const [history, setHistory] = useState<any[]>(() =>
    JSON.parse(localStorage.getItem('presentation-preview') || '[]'),
  );
  const brief = history.find((part) => part.output.stage === 'brief')?.output.brief;
  const design = history.find((part) => part.output.stage === 'design')?.output.design;
  const stage = !brief ? 'brief' : !design ? 'design' : 'storyboard';
  const slides: StoryboardSlide[] = [
    {
      id: 'cover',
      kind: 'cover',
      title: 'Where we go next',
      takeaway: 'A grounded look at our next chapter',
      recommended: 'typography',
      alternatives: [],
      evidence: ['Synthetic demo'],
    },
  ];
  if (brief) {
    for (let i = 0; i < brief.contentSlides; i++)
      slides.push({
        id: `slide-${i}`,
        kind: 'content',
        title: i === 0 ? 'Usage is growing steadily' : `Opportunity ${i + 1}`,
        takeaway: 'Monthly active users increased across the quarter.',
        recommended: 'column',
        alternatives: ['line', 'bar', 'table', 'metrics'],
        chart: {
          type: 'column',
          categories: ['Jan', 'Feb', 'Mar'],
          series: [{ name: 'Active users', values: [120, 180, 240] }],
          unit: 'users',
          source: 'Synthetic demonstration data',
        },
        evidence: ['Synthetic demonstration data, not a real company report.'],
      });
    for (let i = 0; i < brief.sectionBreaks; i++)
      slides.splice(Math.min(2 + i * 2, slides.length), 0, {
        id: `divider-${i}`,
        kind: 'divider',
        title: 'What comes next',
        takeaway: 'A pause before the next topic',
        recommended: 'typography',
        alternatives: [],
        evidence: [],
      });
  }
  slides.push({
    id: 'close',
    kind: 'close',
    title: 'Choose the next chapter',
    takeaway: 'Agree on the next step together',
    recommended: 'typography',
    alternatives: [],
    evidence: [],
  });
  const input: PresentationChoiceInput = {
    presentationId: 'demo',
    title: 'Where we go next',
    summary: 'Let’s make this feel like your presentation.',
    stage,
    contentSlides: 2,
    sectionBreaks: 1,
    ...(design ?? {}),
    ...(stage === 'storyboard' ? { slides } : {}),
  };
  const done =
    history.some((part) => part.output.stage === 'storyboard' && part.output.decision === 'continue') ||
    history.some((part) => part.output.decision === 'cancel' || part.output.delegateRemaining);
  const pending = {
    type: 'tool-ask_presentation_choices',
    toolCallId: `${stage}-${history.length}`,
    state: 'input-available',
    input,
  };
  return (
    <main
      style={{
        maxWidth: 720,
        margin: '0 auto',
        padding: '32px 16px',
        fontFamily: 'var(--font-geist-sans), sans-serif',
      }}
    >
      <header style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 24 }}>
        <strong>Albatross · Presentation studio</strong>
        <button
          type="button"
          onClick={() => {
            localStorage.removeItem('presentation-preview');
            setHistory([]);
          }}
        >
          Reset demo
        </button>
      </header>
      <p style={{ color: 'var(--color-text-muted)', marginBottom: 24 }}>Actual tool UI · synthetic preview</p>
      <p style={{ marginBottom: 16 }}>Generate a presentation about where we go next.</p>
      <div style={{ display: 'grid', gap: 20 }}>
        {history.map((part) => (
          <PresentationChoicesPart key={part.toolCallId} part={part} onResult={() => {}} />
        ))}
        {!done && (
          <PresentationChoicesPart
            part={pending}
            onResult={(output) => {
              const next = [
                ...history,
                { ...pending, state: 'output-available', output: output as PresentationChoiceResult },
              ];
              localStorage.setItem('presentation-preview', JSON.stringify(next));
              setHistory(next);
            }}
          />
        )}
        {done && <p role="status">All choices saved. This local preview does not create files.</p>}
      </div>
    </main>
  );
}
createRoot(document.getElementById('root')!).render(<Preview />);
