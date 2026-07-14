// The deterministic interaction layer for plan dossiers (mirrors the Daily
// Brief's REPORT_ARTIFACT_RUNTIME_JS contract in components/report/DailyReport.tsx).
//
// The model never writes the bridge: PlansSurface injects this runtime into the
// artifact HTML at render time (so pre-existing plans gain interactivity too).
// The artifact only declares intent via [data-action]/[data-payload] markup;
// the runtime posts allowlist-shaped messages to the host, and the host posts
// step completion state back so task cards strike off — including when a card
// is completed from the task board itself (the host's Convex query is live).
//
// Message contract:
//   artifact -> host: { source: 'lab86-plan-artifact', action: 'toggle_step',
//                       payload: { stepKey: string } }
//   host -> artifact: { source: 'lab86-host', type: 'step_state',
//                       steps: [{ stepKey: string, completed: boolean }] }
//   host -> artifact: { source: 'lab86-host', action: 'toggle_step',
//                       ok: boolean, error?: string, payload: { stepKey } }
//     error 'not_applied' renders a quiet inline hint on the card.

export const PLAN_ARTIFACT_MESSAGE_SOURCE = 'lab86-plan-artifact';
export const PLAN_HOST_MESSAGE_SOURCE = 'lab86-host';

const MAX_STEP_KEY_CHARS = 80;

/** A step recorded on the plan at apply time (stepKey -> created artifact). */
export interface AppliedPlanStep {
  stepKey: string;
  kind: string;
  cardId?: string;
}

/** The completion snapshot for one board card backing a plan step. */
export interface StepCardState {
  cardId: string;
  completedAt?: number | null;
}

/** What the artifact needs to strike a card off. */
export interface PlanStepState {
  stepKey: string;
  completed: boolean;
}

/**
 * Injected <style> + <script>. Kept dependency-free ES5 so it runs in the
 * sandboxed srcDoc regardless of what the model authored. The settle animation
 * and transitions honor prefers-reduced-motion inside the frame.
 */
export const PLAN_ARTIFACT_RUNTIME_JS = `<script id="lab86-plan-runtime-js">
(function(){
if(window.__lab86PlanRuntimeInstalled)return;
window.__lab86PlanRuntimeInstalled=true;
var css=''
+'[data-step]{transition:opacity .3s ease}'
+'.plan-step-done{opacity:.55}'
+'.plan-step-done [data-step-title]{text-decoration:line-through;text-decoration-thickness:1px;text-decoration-color:color-mix(in oklab,currentColor 60%,transparent)}'
+'@keyframes lab86-step-settle{0%{transform:translateY(0)}40%{transform:translateY(2px)}100%{transform:translateY(0)}}'
+'.plan-step-settle{animation:lab86-step-settle .32s ease}'
+'.plan-step-hint{margin-top:.45rem;font-size:.74rem;line-height:1.4;color:var(--brief-muted,#6b6b6b)}'
+'@media (prefers-reduced-motion:reduce){[data-step]{transition:none}.plan-step-settle{animation:none}}';
var style=document.createElement('style');
style.id='lab86-plan-runtime-css';
style.textContent=css;
(document.head||document.documentElement).appendChild(style);
var completedByKey={};
function eachStep(fn){var nodes=document.querySelectorAll('[data-step]');for(var i=0;i<nodes.length;i++){fn(nodes[i],nodes[i].getAttribute('data-step'));}}
function updateCounts(){var done=0;for(var key in completedByKey){if(completedByKey[key])done++;}
var els=document.querySelectorAll('[data-plan-done-count]');for(var i=0;i<els.length;i++){els[i].textContent=String(done);}}
function applyStates(steps,animate){
if(!Array.isArray(steps))return;
for(var i=0;i<steps.length;i++){var s=steps[i]||{};if(typeof s.stepKey==='string'){completedByKey[s.stepKey]=!!s.completed;}}
eachStep(function(node,key){
if(key===null||!(key in completedByKey))return;
var done=completedByKey[key];
var was=node.classList.contains('plan-step-done');
node.classList.toggle('plan-step-done',done);
if(animate&&done&&!was){node.classList.remove('plan-step-settle');void node.offsetWidth;node.classList.add('plan-step-settle');}
});
updateCounts();
}
function showHint(stepKey,text){
var target=null;
eachStep(function(node,key){if(key===stepKey)target=node;});
if(!target)return;
var hint=target.querySelector('.plan-step-hint');
if(!hint){hint=document.createElement('div');hint.className='plan-step-hint';target.appendChild(hint);}
hint.textContent=text;
if(hint.__lab86Timer)clearTimeout(hint.__lab86Timer);
hint.__lab86Timer=setTimeout(function(){if(hint.parentNode)hint.parentNode.removeChild(hint);},5000);
}
window.addEventListener('message',function(e){
var d=e.data;
if(!d||d.source!=='lab86-host')return;
if(d.type==='step_state'){applyStates(d.steps||[],true);return;}
if(d.action==='toggle_step'&&d.ok===false){
var key=d.payload&&d.payload.stepKey;
if(typeof key!=='string')return;
showHint(key,d.error==='not_applied'?'Apply the plan to activate':'Could not update this step.');
}
});
document.addEventListener('click',function(e){
var el=e.target&&e.target.closest&&e.target.closest('[data-action]');
if(!el)return;
var action=el.getAttribute('data-action');
if(!action)return;
e.preventDefault();
var payload={};
try{payload=JSON.parse(el.getAttribute('data-payload')||'{}')||{};}catch(_){payload={};}
window.parent.postMessage({source:'lab86-plan-artifact',action:action,payload:payload},'*');
});
})();
</script>`;

/**
 * Idempotently append the runtime to a complete artifact document, replacing
 * any previously injected copy. Composes after normalizeArtifactLinks (which
 * runs at save time); calling it on already-injected HTML is safe.
 */
export function injectPlanArtifactRuntime(html: string): string {
  if (!html) return html;
  let next = html.replace(
    /<script\b(?=[^>]*\bid=(["'])lab86-plan-runtime-js\1)[^>]*>[\s\S]*?<\/script>/gi,
    '',
  );
  const bodyClose = next.toLowerCase().lastIndexOf('</body>');
  next =
    bodyClose >= 0
      ? `${next.slice(0, bodyClose)}${PLAN_ARTIFACT_RUNTIME_JS}${next.slice(bodyClose)}`
      : `${next}${PLAN_ARTIFACT_RUNTIME_JS}`;
  return next;
}

/**
 * Host-side allowlist: accept only well-formed toggle_step messages from the
 * plan artifact. Everything else — wrong source tag, unknown action, missing
 * or oversized stepKey — is rejected with null.
 */
export function parseToggleStepMessage(data: unknown): { stepKey: string } | null {
  if (!data || typeof data !== 'object') return null;
  const message = data as { source?: unknown; action?: unknown; payload?: unknown };
  if (message.source !== PLAN_ARTIFACT_MESSAGE_SOURCE) return null;
  if (message.action !== 'toggle_step') return null;
  const payload = message.payload as { stepKey?: unknown } | undefined;
  const stepKey = payload && typeof payload.stepKey === 'string' ? payload.stepKey.trim() : '';
  if (!stepKey || stepKey.length > MAX_STEP_KEY_CHARS) return null;
  return { stepKey };
}

/** Completion state for every card-backed step, ready to post as step_state. */
export function stepStatesForArtifact(
  steps: AppliedPlanStep[],
  cardStates: StepCardState[],
): PlanStepState[] {
  const byCardId = new Map(cardStates.map((state) => [state.cardId, state]));
  return steps
    .filter((step) => step.cardId)
    .map((step) => ({
      stepKey: step.stepKey,
      completed: Boolean(byCardId.get(step.cardId!)?.completedAt),
    }));
}

export type ToggleStepDecision =
  | { kind: 'not_applied' }
  | { kind: 'unknown_step' }
  | { kind: 'toggle'; cardId: string; nextCompletedAt: number | null };

/**
 * Pure host-side decision for one toggle_step message. Unapplied plans get a
 * quiet inline hint (never a browser alert); unknown or card-less steps are
 * refused; otherwise the toggle flips the mapped card's completion.
 */
export function toggleStepDecision(
  input: {
    applied: boolean;
    steps: AppliedPlanStep[];
    cardStates: StepCardState[];
    stepKey: string;
  },
  now: number = Date.now(),
): ToggleStepDecision {
  if (!input.applied) return { kind: 'not_applied' };
  const step = input.steps.find((entry) => entry.stepKey === input.stepKey);
  if (!step?.cardId) return { kind: 'unknown_step' };
  const state = input.cardStates.find((entry) => entry.cardId === step.cardId);
  const currentlyCompleted = Boolean(state?.completedAt);
  return { kind: 'toggle', cardId: step.cardId, nextCompletedAt: currentlyCompleted ? null : now };
}
