// Shared first-paint handshake for sandboxed briefs. The host keeps the iframe
// transparent until its theme variables are installed and every requested font
// has settled, preventing the fallback -> colors -> fonts cascade.

export const BRIEF_ARTIFACT_READY_SOURCE = 'lab86-brief-artifact';

export const BRIEF_ARTIFACT_READY_RUNTIME_JS = `<script id="lab86-brief-ready-js">
(function(){
if(window.__lab86BriefReadyInstalled)return;
window.__lab86BriefReadyInstalled=true;
var announced=false;
function announce(){if(announced)return;announced=true;window.parent.postMessage({source:'${BRIEF_ARTIFACT_READY_SOURCE}',type:'ready'},'*');}
function settle(){var ready=document.fonts&&document.fonts.ready?document.fonts.ready:Promise.resolve();var timeout=new Promise(function(resolve){setTimeout(resolve,2000);});Promise.race([ready,timeout]).then(function(){requestAnimationFrame(function(){requestAnimationFrame(announce);});},announce);}
window.addEventListener('message',function(e){var d=e.data;if(!d||d.source!=='lab86-host'||d.type!=='theme'||!d.theme)return;for(var k in d.theme){document.documentElement.style.setProperty(k,d.theme[k]);}settle();});
})();
</script>`;

export function isBriefArtifactReadyMessage(data: unknown): boolean {
  if (!data || typeof data !== 'object') return false;
  const message = data as { source?: unknown; type?: unknown };
  return message.source === BRIEF_ARTIFACT_READY_SOURCE && message.type === 'ready';
}

/** Idempotently append the trusted readiness runtime to a complete document. */
export function injectBriefArtifactReadyRuntime(html: string): string {
  if (!html) return html;
  let next = html.replace(
    /<script\b(?=[^>]*\bid=(["'])lab86-brief-ready-js\1)[^>]*>[\s\S]*?<\/script>/gi,
    '',
  );
  const bodyClose = next.toLowerCase().lastIndexOf('</body>');
  next =
    bodyClose >= 0
      ? `${next.slice(0, bodyClose)}${BRIEF_ARTIFACT_READY_RUNTIME_JS}${next.slice(bodyClose)}`
      : `${next}${BRIEF_ARTIFACT_READY_RUNTIME_JS}`;
  return next;
}
