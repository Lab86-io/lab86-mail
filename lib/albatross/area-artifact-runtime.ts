// Deterministic bridge for model-composed Area documents. The model declares
// intent with data-action/data-payload; this injected runtime owns all script,
// and the React host validates the resulting message before navigation or a
// capture mutation. It intentionally has no access to app APIs.

import { injectAreaArtifactFontContract } from './area-artifact-fonts';
import { injectBriefArtifactReadyRuntime } from './artifact-ready';

export const AREA_ARTIFACT_MESSAGE_SOURCE = 'lab86-area-artifact';
export const AREA_ARTIFACT_HOST_SOURCE = 'lab86-host';

const MAX_ID = 200;
const MAX_CAPTURE = 2_000;

export type AreaArtifactAction =
  | { action: 'open_work'; payload: { workId: string } }
  | { action: 'open_thread'; payload: { accountId: string; threadId: string } }
  | { action: 'open_event'; payload: { accountId: string; eventId: string } }
  | { action: 'open_tasks'; payload: Record<string, never> }
  | { action: 'discuss_area'; payload: { areaId: string } }
  | { action: 'capture_intent'; payload: { areaId: string; text: string } }
  | {
      action: 'answer_question';
      payload: { questionId: string; text: string; answeredOptionId?: string };
    };

function id(value: unknown) {
  if (typeof value !== 'string') return null;
  const clean = value.trim();
  return clean && clean.length <= MAX_ID ? clean : null;
}

/** Host-side action allowlist and payload validator. */
export function parseAreaArtifactMessage(data: unknown, expectedAreaId: string): AreaArtifactAction | null {
  if (!data || typeof data !== 'object') return null;
  const message = data as { source?: unknown; action?: unknown; payload?: unknown };
  if (message.source !== AREA_ARTIFACT_MESSAGE_SOURCE || typeof message.action !== 'string') return null;
  const payload = message.payload && typeof message.payload === 'object' ? (message.payload as any) : {};
  switch (message.action) {
    case 'open_work': {
      const workId = id(payload.workId);
      return workId ? { action: 'open_work', payload: { workId } } : null;
    }
    case 'open_thread': {
      const accountId = id(payload.accountId);
      const threadId = id(payload.threadId);
      return accountId && threadId ? { action: 'open_thread', payload: { accountId, threadId } } : null;
    }
    case 'open_event': {
      const accountId = id(payload.accountId);
      const eventId = id(payload.eventId);
      return accountId && eventId ? { action: 'open_event', payload: { accountId, eventId } } : null;
    }
    case 'open_tasks':
      return { action: 'open_tasks', payload: {} };
    case 'discuss_area': {
      const areaId = id(payload.areaId);
      return areaId === expectedAreaId ? { action: 'discuss_area', payload: { areaId } } : null;
    }
    case 'capture_intent': {
      const areaId = id(payload.areaId);
      const text = typeof payload.text === 'string' ? payload.text.trim() : '';
      return areaId === expectedAreaId && text && text.length <= MAX_CAPTURE
        ? { action: 'capture_intent', payload: { areaId, text } }
        : null;
    }
    case 'answer_question': {
      const questionId = id(payload.questionId);
      const text = typeof payload.text === 'string' ? payload.text.trim() : '';
      const answeredOptionId = payload.answeredOptionId ? id(payload.answeredOptionId) : null;
      return questionId && text && text.length <= MAX_CAPTURE
        ? {
            action: 'answer_question',
            payload: {
              questionId,
              text,
              ...(answeredOptionId ? { answeredOptionId } : {}),
            },
          }
        : null;
    }
    default:
      return null;
  }
}

export const AREA_ARTIFACT_RUNTIME_JS = `<script id="lab86-area-runtime-js">
(function(){
if(window.__lab86AreaRuntimeInstalled)return;
window.__lab86AreaRuntimeInstalled=true;
function payloadFor(el){var payload={};try{payload=JSON.parse(el.getAttribute('data-payload')||'{}')||{};}catch(_){payload={};}return payload;}
function post(action,payload){window.parent.postMessage({source:'${AREA_ARTIFACT_MESSAGE_SOURCE}',action:action,payload:payload||{}},'*');}
function submitCapture(form,button){
var control=form&&form.querySelector('[data-capture-input]');var text=control&&typeof control.value==='string'?control.value.trim():'';if(!text||!button)return;
var payload=payloadFor(button);payload.text=text;button.setAttribute('aria-busy','true');button.setAttribute('disabled','');form.setAttribute('data-capture-state','saving');post('capture_intent',payload);
}
function submitQuestion(form,button){
var control=form&&(form.querySelector('[data-question-input]:checked')||form.querySelector('select[data-question-input],textarea[data-question-input],input[data-question-input]:not([type="radio"]):not([type="checkbox"])'));var text=control&&typeof control.value==='string'?control.value.trim():'';if(!text||!button)return;
var payload=payloadFor(button);payload.text=text;if(control&&control.getAttribute){var optionId=control.getAttribute('data-option-id');if(optionId)payload.answeredOptionId=optionId;}button.setAttribute('aria-busy','true');button.setAttribute('disabled','');form.setAttribute('data-question-state','saving');post('answer_question',payload);
}
window.addEventListener('message',function(e){
var d=e.data;if(!d||d.source!=='${AREA_ARTIFACT_HOST_SOURCE}')return;
if(d.type==='theme'&&d.theme){for(var k in d.theme){document.documentElement.style.setProperty(k,d.theme[k]);}return;}
if(d.action==='capture_intent'){
var form=document.querySelector('[data-area-capture]');if(!form)return;
var control=form.querySelector('[data-capture-input]');var button=form.querySelector('[data-action="capture_intent"]');
if(button){button.removeAttribute('aria-busy');button.removeAttribute('disabled');}
if(d.ok){if(control)control.value='';form.setAttribute('data-capture-state','saved');}
else{form.setAttribute('data-capture-state','error');}
}
if(d.action==='answer_question'){
var forms=document.querySelectorAll('[data-area-question]');var form=null;for(var i=0;i<forms.length;i++){if(forms[i].getAttribute('data-question-id')===String(d.payload&&d.payload.questionId||'')){form=forms[i];break;}}if(!form)return;
var button=form.querySelector('[data-action="answer_question"]');if(button){button.removeAttribute('aria-busy');button.removeAttribute('disabled');}
if(d.ok){form.setAttribute('data-question-state','saved');var controls=form.querySelectorAll('[data-question-input]');for(var j=0;j<controls.length;j++){controls[j].setAttribute('disabled','');}}
else{form.setAttribute('data-question-state','error');}
}
});
document.addEventListener('click',function(e){
var el=e.target&&e.target.closest&&e.target.closest('[data-action]');if(!el)return;
var action=el.getAttribute('data-action');if(!action)return;
if(action==='capture_intent'&&el.closest('[data-area-capture]')){e.preventDefault();submitCapture(el.closest('[data-area-capture]'),el);return;}
if(action==='answer_question'&&el.closest('[data-area-question]')){e.preventDefault();submitQuestion(el.closest('[data-area-question]'),el);return;}
e.preventDefault();post(action,payloadFor(el));
});
document.addEventListener('submit',function(e){
var capture=e.target&&e.target.closest&&e.target.closest('[data-area-capture]');if(capture){e.preventDefault();submitCapture(capture,capture.querySelector('[data-action="capture_intent"]'));return;}
var question=e.target&&e.target.closest&&e.target.closest('[data-area-question]');if(question){e.preventDefault();submitQuestion(question,question.querySelector('[data-action="answer_question"]'));}
});
})();
</script>`;

/** Idempotently append the trusted runtime to a complete Area document. */
export function injectAreaArtifactRuntime(html: string) {
  if (!html) return html;
  let next = injectAreaArtifactFontContract(html).replace(
    /<script\b(?=[^>]*\bid=(["'])lab86-area-runtime-js\1)[^>]*>[\s\S]*?<\/script>/gi,
    '',
  );
  const bodyCloseMatch = /<\/body\s*>(?![\s\S]*<\/body\s*>)/i.exec(next);
  const bodyClose = bodyCloseMatch ? bodyCloseMatch.index : -1;
  next =
    bodyClose >= 0
      ? `${next.slice(0, bodyClose)}${AREA_ARTIFACT_RUNTIME_JS}${next.slice(bodyClose)}`
      : `${next}${AREA_ARTIFACT_RUNTIME_JS}`;
  return injectBriefArtifactReadyRuntime(next);
}
