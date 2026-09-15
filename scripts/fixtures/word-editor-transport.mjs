/** Loopback-only protocol double; this does not pretend to render the real Collabora suite. */
export function wordEditorTransport() {
  let state;
  let editTimer;
  const reset = () => {
    clearTimeout(editTimer);
    editTimer = undefined;
    state = {
      title: 'Word acceptance.docx',
      text: 'Original saved content',
      currentRevision: 1,
      versions: [{ revision: 1, createdAt: Date.now(), recovery: false }],
      sessions: 0,
      events: [],
      failSave: false,
      hold: false,
    };
  };
  reset();
  return async (request, records) => {
    const url = new URL(request.url);
    const path = url.pathname;
    const json = (value, status = 200) => Response.json(value, { status });
    const metadata = () => ({ ...state, documentId: 'word-a', extension: 'docx' });
    if (path === '/fixture-reset') {
      reset();
      return null;
    }
    if (path === '/fixture-word-state') return json(state);
    if (path === '/api/office') return json({ ok: true, enabled: true, files: [metadata()] });
    if (path === '/api/office/word') {
      const input = await request.json();
      if (input.sourceDocumentId && input.expectedRevision !== records.doc.currentRevision)
        return json({ error: 'Source changed' }, 409);
      state.title = `${records.doc.title}.docx`;
      state.text = records.doc.model.blocks.map((block) => block.text).join('\n');
      state.events.push('copy');
      return json({ ok: true, document: { documentId: 'word-a', openPath: '/?view=files&office=word-a' } });
    }
    if (path === '/api/office/word-a') {
      if (request.method === 'PATCH') state.title = `${(await request.json()).title}.docx`;
      return json({ ok: true, document: metadata() });
    }
    if (path === '/api/office/word-a/session') {
      state.sessions++;
      state.events.push('open');
      return json({
        provider: 'collabora',
        sessionId: `session-${state.sessions}`,
        documentId: 'word-a',
        serverUrl: url.origin,
        editorUrl: `${url.origin}/fixture-word-frame`,
        accessToken: 'synthetic-word-token',
        accessTokenTtl: Date.now() + 60_000,
      });
    }
    if (path === '/fixture-word-save') {
      const input = await request.json();
      state.events.push('save');
      if (state.failSave) return json({ error: 'Synthetic save failed' }, 500);
      if (state.text !== input.text) {
        state.text = input.text;
        state.currentRevision++;
      }
      state.lastWopiSave = { id: input.id, revision: state.currentRevision };
      return json({ ok: true });
    }
    if (path === '/fixture-word-edit') {
      const input = await request.json();
      state.failSave = Boolean(input.failSave);
      state.hold = Boolean(input.hold);
      state.aiEdit = {
        id: crypto.randomUUID(),
        targetSessionId: `session-${state.sessions}`,
        expiresAt: Date.now() + 60_000,
        state: 'requested',
      };
      return json({ ok: true });
    }
    if (path === '/api/office/word-a/editing') {
      const input = await request.json();
      state.events.push(input.failed ? 'failed' : 'prepared');
      if (input.failed) state.aiEdit.state = 'failed';
      else {
        state.aiEdit.state = 'prepared';
        if (!state.hold)
          editTimer = setTimeout(() => {
            state.text += '\nAI edit preserved the draft.';
            state.currentRevision++;
            state.aiEdit.state = 'complete';
            state.events.push('applied');
          }, 500);
      }
      return json({ ok: true });
    }
    if (path === '/fixture-word-frame')
      return new Response(
        `<!doctype html><html><body><label>Synthetic document body<textarea id="body" style="display:block;width:90%;height:200px"></textarea></label><script>
      const field=document.getElementById('body'); field.value=${JSON.stringify(state.text).replaceAll('<', '\\u003c')};
      let announced=false; const post=(MessageId,Values)=>parent.postMessage(JSON.stringify({MessageId,Values}),location.origin);
      field.addEventListener('input',()=>post('Doc_ModifiedStatus',{Modified:true}));
      addEventListener('message',async(event)=>{
        if(event.origin!==location.origin)return;let message;try{message=JSON.parse(event.data)}catch{return}
        if(message.MessageId==='Host_PostmessageReady'&&!announced){announced=true;post('App_LoadingStatus',{Status:'Document_Loaded'});}
        if(message.MessageId==='Action_Save'){
          const result=await fetch('/fixture-word-save',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:message.Values.ExtendedData,text:field.value})});
          post('Action_Save_Resp',{success:result.ok,errorMsg:result.ok?'':'Synthetic save failed'});
        }
      });post('App_LoadingStatus',{Status:'Document_Loaded'});
    </script></body></html>`,
        { headers: { 'content-type': 'text/html' } },
      );
    return null;
  };
}
