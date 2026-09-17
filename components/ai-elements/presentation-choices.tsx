'use client';

import { type ReactNode, useRef, useState } from 'react';
import { SlideSurface } from '@/components/files/editors/SlideRenderer';
import {
  FONT_DESCRIPTIONS,
  type PresentationBriefChoices,
  type PresentationChoiceInput,
  type PresentationChoiceResult,
  type PresentationDesignChoices,
  presentationBriefChoicesSchema,
  presentationChoiceRepair,
  presentationChoiceResultSchema,
  presentationChoiceSchemaForSession,
  SOURCE_CHOICES,
  type StoryboardSlide,
  THEME_DESCRIPTIONS,
  tableForStoryboard,
  VISUAL_LABELS,
  type VisualChoice,
  visualOptionsForSlide,
} from '@/lib/documents/presentation-choices';
import {
  buildDeckTheme,
  type CompositionContent,
  composeSlide,
  FONT_PAIR_NAMES,
  PALETTE_NAMES,
} from '@/lib/documents/presentation-compositions';
import './presentation-choices.css';

const SOURCE_LABELS = {
  provided: 'This conversation & attachments',
  mail: 'Email',
  meetings: 'Meetings',
  files: 'Files',
  web: 'Web research',
};
const IMAGERY_LABELS = { none: 'Typography & data', provided: 'My images', paintings: 'Credited paintings' };

export function PresentationPreview({
  title,
  theme = 'editorial',
  fontPair = 'serif',
  slide,
  visual,
}: {
  title: string;
  theme?: PresentationDesignChoices['theme'];
  fontPair?: PresentationDesignChoices['fontPair'];
  slide?: StoryboardSlide;
  visual?: VisualChoice;
}) {
  const deckTheme = buildDeckTheme(theme, fontPair);
  const content: CompositionContent = {
    role: 'cover',
    title: title.slice(0, 65),
    kicker: 'A new perspective',
    body: 'Ideas worth sharing. A story worth telling.',
    items: [],
  };
  if (slide && visual) {
    content.title = slide.title.slice(0, 65);
    content.kicker = VISUAL_LABELS[visual];
    content.body = slide.takeaway.slice(0, 180);
    if (['column', 'bar', 'line', 'pie', 'doughnut'].includes(visual) && slide.chart) {
      content.role = 'chart';
      content.chart = {
        ...slide.chart,
        unit: slide.chart.unit ?? undefined,
        source: slide.chart.source ?? undefined,
        type: visual as NonNullable<CompositionContent['chart']>['type'],
      };
    } else if (visual === 'table') {
      content.role = 'table';
      content.table = tableForStoryboard(slide);
    } else if (visual === 'metrics' && slide.chart) {
      content.role = 'metrics';
      content.items = slide.chart.categories.slice(0, 4).map((label, index) => ({
        label: `${slide.chart!.series[0].values[index]}${slide.chart!.unit ? ` ${slide.chart!.unit}` : ''}`,
        detail: label,
      }));
    } else if (visual === 'process' || visual === 'comparison') {
      content.role = visual;
      content.items = (slide.evidence.length ? slide.evidence : [slide.takeaway])
        .slice(0, 4)
        .map((label) => ({ label: label.slice(0, 55), detail: '' }));
    } else {
      content.role = visual === 'image' ? 'image-right' : 'statement';
    }
  }
  const composed = composeSlide(content, { theme: deckTheme, slideId: 'choice-preview', index: 0, total: 1 });
  return (
    <span className="presentation-choice-preview" aria-hidden="true">
      <SlideSurface slide={composed} theme={deckTheme} />
    </span>
  );
}

function Option({
  selected,
  label,
  description,
  children,
  onClick,
}: {
  selected: boolean;
  label: string;
  description?: string;
  children?: ReactNode;
  onClick: () => void;
}) {
  return (
    <button type="button" className="presentation-choice-option" aria-pressed={selected} onClick={onClick}>
      {children}
      <span className="presentation-choice-option-label">
        <span>{label}</span>
        <span aria-hidden="true">{selected ? '✓' : ''}</span>
      </span>
      {description && <span className="presentation-choice-description">{description}</span>}
    </button>
  );
}

function TextAnswer({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
}) {
  return (
    <label className="presentation-choice-field">
      <span>{label}</span>
      <textarea
        rows={2}
        maxLength={2000}
        value={value}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  );
}

export function PresentationChoicesPart({
  part,
  onResult,
}: {
  part: any;
  onResult: (output: Record<string, unknown>) => void;
}) {
  const parsed = presentationChoiceSchemaForSession().safeParse(part.input);
  if (
    !parsed.success ||
    part.state === 'output-error' ||
    part.output?.status === 'invalid_presentation_choices'
  )
    return <PresentationChoicesRecovery key={part.toolCallId} part={part} onResult={onResult} />;
  const result = presentationChoiceResultSchema.safeParse(part.output);
  if (part.state === 'output-available' && result.success)
    return <PresentationReceipt input={parsed.data} result={result.data} />;
  return <PresentationPicker key={part.toolCallId} input={parsed.data} onResult={onResult} />;
}

function PresentationChoicesRecovery({
  part,
  onResult,
}: {
  part: any;
  onResult: (output: Record<string, unknown>) => void;
}) {
  const sent = useRef(false);
  const [requested, setRequested] = useState(false);
  const pending = part.state === 'input-available' && !requested;
  return (
    <div className="presentation-choices" role="status">
      <strong>{pending ? 'Let’s repair this slide preview' : 'Slide preview returned for correction'}</strong>
      <p>
        Your earlier presentation choices are kept. The agent needs to correct this preview before you can
        review it.
      </p>
      {pending && (
        <div className="presentation-choice-actions">
          <button
            type="button"
            className="presentation-choice-primary"
            onClick={() => {
              if (sent.current) return;
              sent.current = true;
              setRequested(true);
              onResult(presentationChoiceRepair(part.input));
            }}
          >
            Repair these choices
          </button>
        </div>
      )}
    </div>
  );
}

function PresentationReceipt({
  input,
  result,
}: {
  input: PresentationChoiceInput;
  result: PresentationChoiceResult;
}) {
  return (
    <section
      className="presentation-choices presentation-choice-receipt"
      aria-label="Your presentation choices"
    >
      <span className="presentation-choice-eyebrow">
        {result.decision === 'cancel'
          ? 'Presentation cancelled'
          : result.decision === 'revise'
            ? 'Changes requested'
            : 'Your presentation choices'}
      </span>
      <strong>{input.title}</strong>
      {result.decision === 'continue' && result.brief && (
        <p>
          {result.brief.audience} · {result.brief.contentSlides} content slides + {result.brief.sectionBreaks}{' '}
          section breaks + opening & close
          <br />
          {result.brief.sources.map((source) => SOURCE_LABELS[source]).join(' · ')}
        </p>
      )}
      {result.decision === 'continue' && result.design && (
        <>
          <PresentationPreview
            title={input.title}
            theme={result.design.theme}
            fontPair={result.design.fontPair}
          />
          <p>
            {result.design.theme} · {FONT_DESCRIPTIONS[result.design.fontPair]}
            {result.design.imagery && ` · ${IMAGERY_LABELS[result.design.imagery]}`}
          </p>
        </>
      )}
      {result.decision === 'continue' && result.visuals && (
        <details>
          <summary>{result.visuals.length} slides confirmed</summary>
          <ol>
            {input.slides?.map((slide) => (
              <li key={slide.id}>
                {slide.title} —{' '}
                {
                  VISUAL_LABELS[
                    result.visuals!.find((entry) => entry.slideId === slide.id)?.visual ?? 'typography'
                  ]
                }
              </li>
            ))}
          </ol>
        </details>
      )}
      {result.guidance && <p>{result.guidance}</p>}
      {result.delegateRemaining && <p>Remaining choices delegated.</p>}
    </section>
  );
}

export function PresentationPicker({
  input,
  onResult,
}: {
  input: PresentationChoiceInput;
  onResult: (output: Record<string, unknown>) => void;
}) {
  const [step, setStep] = useState(0);
  const [brief, setBrief] = useState<PresentationBriefChoices>({
    audience: input.audience ?? '',
    purpose: input.purpose ?? '',
    sources: input.sources?.length ? input.sources : ['provided'],
    sourceGuidance: '',
    contentSlides: input.contentSlides ?? 6,
    sectionBreaks: input.sectionBreaks ?? 1,
    detail: 'balanced',
  });
  const [design, setDesign] = useState<PresentationDesignChoices>({
    theme: input.theme ?? 'editorial',
    fontPair: input.fontPair ?? 'serif',
    guidance: '',
  });
  const [visuals, setVisuals] = useState<Record<string, VisualChoice>>(() =>
    Object.fromEntries((input.slides ?? []).map((slide) => [slide.id, visualOptionsForSlide(slide)[0]])),
  );
  const [guidance, setGuidance] = useState('');
  const [error, setError] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const sent = useRef(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const slides = input.slides ?? [];
  const count = input.stage === 'storyboard' ? slides.length + 1 : input.stage === 'design' ? 2 : 3;
  const final = step === count - 1;
  const titles =
    input.stage === 'brief'
      ? ['Who is this for?', 'What should I draw from?', 'How should the story flow?']
      : input.stage === 'design'
        ? ['Choose the mood', 'Find your voice']
        : [];
  const currentSlide = input.stage === 'storyboard' ? slides[step] : undefined;
  const title =
    titles[step] ??
    (currentSlide ? `Slide ${step + 1} · ${currentSlide.title}` : 'Ready to build your presentation?');
  function move(to: number) {
    setError('');
    setStep(to);
    requestAnimationFrame(() => heading.current?.focus());
  }
  function submit(decision: PresentationChoiceResult['decision'], delegateRemaining = false) {
    if (sent.current) return;
    if (decision === 'revise' && !guidance.trim()) {
      setError('Tell me what you would like changed.');
      return;
    }
    if (
      decision === 'continue' &&
      !delegateRemaining &&
      input.stage === 'brief' &&
      !presentationBriefChoicesSchema.safeParse(brief).success
    ) {
      setError('Add an audience and outcome, and choose at least one source.');
      return;
    }
    if (
      decision === 'continue' &&
      !delegateRemaining &&
      input.stage === 'storyboard' &&
      slides.some((slide) => !visualOptionsForSlide(slide).includes(visuals[slide.id]))
    ) {
      setError('A slide needs a supported visual. Request changes below so I can prepare another option.');
      return;
    }
    sent.current = true;
    setSubmitted(true);
    onResult({
      presentationId: input.presentationId,
      stage: input.stage,
      decision,
      delegateRemaining,
      guidance,
      ...(input.stage === 'brief' && presentationBriefChoicesSchema.safeParse(brief).success
        ? { brief }
        : {}),
      ...(input.stage === 'design' ? { design } : {}),
      ...(input.stage === 'storyboard'
        ? {
            visuals: slides.map((slide) => ({
              slideId: slide.id,
              visual: visuals[slide.id] ?? 'typography',
            })),
          }
        : {}),
    });
  }
  function next() {
    if (input.stage === 'brief' && step === 0 && (!brief.audience.trim() || !brief.purpose.trim())) {
      setError('Add an audience and the outcome you want.');
      return;
    }
    if (input.stage === 'brief' && step === 1 && !brief.sources.length) {
      setError('Choose at least one source.');
      return;
    }
    if (final) submit('continue');
    else move(step + 1);
  }
  return (
    <section className="presentation-choices" aria-label={`${input.stage} presentation choices`}>
      <div className="presentation-choice-topline">
        <span className="presentation-choice-eyebrow">
          {input.stage === 'brief'
            ? '01 · The brief'
            : input.stage === 'design'
              ? '02 · Visual direction'
              : '03 · Your storyboard'}
        </span>
        <span>
          {step + 1} / {count}
        </span>
      </div>
      <div className="presentation-choice-progress" aria-hidden="true">
        {Array.from({ length: count }, (_, index) => (
          <span key={index} data-complete={index <= step} />
        ))}
      </div>
      <h3 ref={heading} tabIndex={-1}>
        {title}
      </h3>
      {step === 0 && input.summary && <p className="presentation-choice-intro">{input.summary}</p>}
      <fieldset disabled={submitted} className="presentation-choice-body">
        <legend className="sr-only">{title}</legend>
        {input.stage === 'brief' && step === 0 && (
          <>
            <TextAnswer
              label="Who will see it?"
              value={brief.audience}
              placeholder="Leadership, customers, a room full of researchers…"
              onChange={(audience) => setBrief({ ...brief, audience })}
            />
            <div className="presentation-choice-chips">
              {['Leadership team', 'Customers', 'My team'].map((audience) => (
                <button key={audience} type="button" onClick={() => setBrief({ ...brief, audience })}>
                  {audience}
                </button>
              ))}
            </div>
            <TextAnswer
              label="What should they understand or do?"
              value={brief.purpose}
              placeholder="Make a decision, understand the findings, get excited about an idea…"
              onChange={(purpose) => setBrief({ ...brief, purpose })}
            />
          </>
        )}
        {input.stage === 'brief' && step === 1 && (
          <>
            <p>
              I’ll gather and read the relevant material before proposing slides. Choose the places to look.
            </p>
            <div className="presentation-choice-grid">
              {SOURCE_CHOICES.map((source) => (
                <Option
                  key={source}
                  label={SOURCE_LABELS[source]}
                  selected={brief.sources.includes(source)}
                  onClick={() =>
                    setBrief({
                      ...brief,
                      sources: brief.sources.includes(source)
                        ? brief.sources.filter((value) => value !== source)
                        : [...brief.sources, source],
                    })
                  }
                />
              ))}
            </div>
            <TextAnswer
              label="Anything to include or leave out?"
              value={brief.sourceGuidance}
              placeholder="Names, date ranges, files, must-have facts, things to exclude…"
              onChange={(sourceGuidance) => setBrief({ ...brief, sourceGuidance })}
            />
          </>
        )}
        {input.stage === 'brief' && step === 2 && (
          <>
            <div className="presentation-choice-counts">
              <label>
                Content slides
                <input
                  type="number"
                  min={1}
                  max={24}
                  value={brief.contentSlides}
                  onChange={(event) =>
                    setBrief({
                      ...brief,
                      contentSlides: Math.max(1, Math.min(24, Number(event.target.value) || 1)),
                    })
                  }
                />
              </label>
              <label>
                In-between section breaks
                <input
                  type="number"
                  min={0}
                  max={4}
                  value={brief.sectionBreaks}
                  onChange={(event) =>
                    setBrief({
                      ...brief,
                      sectionBreaks: Math.max(0, Math.min(4, Number(event.target.value) || 0)),
                    })
                  }
                />
              </label>
            </div>
            <div className="presentation-choice-filmstrip" aria-hidden="true">
              <span>Opening</span>
              {Array.from({ length: brief.contentSlides }, (_, index) => (
                <i key={index} />
              ))}
              {Array.from({ length: brief.sectionBreaks }, (_, index) => (
                <i key={`break-${index}`} className="is-divider" />
              ))}
              <span>Close</span>
            </div>
            <p>
              {brief.contentSlides + brief.sectionBreaks + 2} slides total, including an opening and a closing
              slide. Section breaks give the audience a pause between topics.
            </p>
            <div className="presentation-choice-grid">
              {(['concise', 'balanced', 'detailed'] as const).map((detail) => (
                <Option
                  key={detail}
                  label={detail}
                  description={
                    {
                      concise: 'One idea, lots of breathing room',
                      balanced: 'Clear ideas with supporting evidence',
                      detailed: 'More evidence, with depth in speaker notes',
                    }[detail]
                  }
                  selected={brief.detail === detail}
                  onClick={() => setBrief({ ...brief, detail })}
                />
              ))}
            </div>
          </>
        )}
        {input.stage === 'design' && step === 0 && (
          <>
            <p>Preview the colors on your opening slide. You’ll choose the type next.</p>
            <div className="presentation-choice-grid">
              {PALETTE_NAMES.map((theme) => (
                <Option
                  key={theme}
                  label={theme}
                  description={THEME_DESCRIPTIONS[theme]}
                  selected={design.theme === theme}
                  onClick={() => setDesign({ ...design, theme })}
                >
                  <PresentationPreview title={input.title} theme={theme} fontPair={design.fontPair} />
                </Option>
              ))}
            </div>
          </>
        )}
        {input.stage === 'design' && step === 1 && (
          <>
            <p>Same theme, different typography. Each pairing carries through the whole deck.</p>
            <div className="presentation-choice-grid">
              {FONT_PAIR_NAMES.map((fontPair) => (
                <Option
                  key={fontPair}
                  label={FONT_DESCRIPTIONS[fontPair].split(' · ')[0]}
                  description={FONT_DESCRIPTIONS[fontPair].split(' · ')[1]}
                  selected={design.fontPair === fontPair}
                  onClick={() => setDesign({ ...design, fontPair })}
                >
                  <PresentationPreview title={input.title} theme={design.theme} fontPair={fontPair} />
                </Option>
              ))}
            </div>
            <TextAnswer
              label="Any other design direction?"
              value={design.guidance}
              placeholder="More playful, quiet and minimal, large numbers, a specific visual reference…"
              onChange={(guidance) => setDesign({ ...design, guidance })}
            />
          </>
        )}
        {currentSlide && (
          <>
            <p>{currentSlide.takeaway}</p>
            <div className="presentation-choice-grid">
              {visualOptionsForSlide(currentSlide).map((visual) => (
                <Option
                  key={visual}
                  label={VISUAL_LABELS[visual]}
                  description={visual === currentSlide.recommended ? 'Suggested for this slide' : undefined}
                  selected={visuals[currentSlide.id] === visual}
                  onClick={() => setVisuals({ ...visuals, [currentSlide.id]: visual })}
                >
                  <PresentationPreview
                    title={input.title}
                    theme={design.theme}
                    fontPair={design.fontPair}
                    slide={currentSlide}
                    visual={visual}
                  />
                </Option>
              ))}
            </div>
            {currentSlide.evidence.length > 0 && (
              <details>
                <summary>Evidence for this slide</summary>
                <ul>
                  {currentSlide.evidence.map((source, index) => (
                    <li key={index}>{source}</li>
                  ))}
                </ul>
              </details>
            )}
            {currentSlide.chart && (
              <details>
                <summary>
                  View chart data{currentSlide.chart.unit ? ` (${currentSlide.chart.unit})` : ''}
                </summary>
                <div className="presentation-choice-data">
                  <table>
                    <thead>
                      <tr>
                        <th>Category</th>
                        {currentSlide.chart.series.map((series) => (
                          <th key={series.name}>{series.name}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {currentSlide.chart.categories.map((category, index) => (
                        <tr key={index}>
                          <th>{category}</th>
                          {currentSlide.chart!.series.map((series) => (
                            <td key={series.name}>{series.values[index]}</td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <p>{currentSlide.chart.source}</p>
              </details>
            )}
          </>
        )}
        {input.stage === 'storyboard' && final && (
          <>
            <p>Every slide below uses your chosen visual. I’ll check the copy and layout as I build.</p>
            <ol className="presentation-choice-outline">
              {slides.map((slide) => (
                <li key={slide.id}>
                  <button type="button" onClick={() => move(slides.indexOf(slide))}>
                    <span>{slide.title}</span>
                    <small>{VISUAL_LABELS[visuals[slide.id]] ?? 'Choose a visual'}</small>
                  </button>
                </li>
              ))}
            </ol>
          </>
        )}
        {input.stage === 'storyboard' && (
          <TextAnswer
            label="Changes to the story or visuals?"
            value={guidance}
            placeholder="Tell me what to research, rearrange or show differently…"
            onChange={setGuidance}
          />
        )}
      </fieldset>
      {error && (
        <p className="presentation-choice-error" role="alert">
          {error}
        </p>
      )}
      <div className="presentation-choice-actions">
        <button type="button" disabled={submitted || step === 0} onClick={() => move(step - 1)}>
          Back
        </button>
        <button type="button" className="presentation-choice-primary" disabled={submitted} onClick={next}>
          {submitted
            ? 'Choices saved'
            : !final
              ? 'Next'
              : input.stage === 'brief'
                ? 'Gather the content'
                : input.stage === 'design'
                  ? 'Plan my slides'
                  : 'Build this presentation'}
        </button>
      </div>
      <div className="presentation-choice-secondary">
        {input.stage === 'storyboard' && (
          <button type="button" disabled={submitted} onClick={() => submit('revise')}>
            Request changes
          </button>
        )}
        <button type="button" disabled={submitted} onClick={() => submit('continue', true)}>
          Decide the rest for me
        </button>
        <button type="button" disabled={submitted} onClick={() => submit('cancel')}>
          Cancel presentation
        </button>
      </div>
    </section>
  );
}
