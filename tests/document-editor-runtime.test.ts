import { expect, test } from 'bun:test';

test('real editor transactions preserve block identity, split undo/redo, marks and readonly lifecycle', async () => {
  // A separate DOM process avoids contaminating other React and server suites.
  const script = `
    import { JSDOM } from 'jsdom';
    const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual:true });
    for (const name of ['window','document','HTMLElement','Element','Node','navigator','MutationObserver','DOMParser'])
      Object.defineProperty(globalThis,name,{configurable:true,value:name==='window'?dom.window:dom.window[name]});
    globalThis.getComputedStyle=dom.window.getComputedStyle.bind(dom.window);
    globalThis.requestAnimationFrame=dom.window.requestAnimationFrame.bind(dom.window);
    globalThis.cancelAnimationFrame=dom.window.cancelAnimationFrame.bind(dom.window);
    const { Editor } = await import('@tiptap/react');
    const { closeHistory } = await import('@tiptap/pm/history');
    const { documentExtensions } = await import('./components/files/editors/doc-extensions.ts');
    const { docModelToEditorJson,editorJsonToDocModel } = await import('./components/files/editors/doc-rich-text.ts');
    let updates=0;
    const initial={kind:'doc',version:1,blocks:[{id:'first',type:'paragraph',text:'First'},{id:'second',type:'paragraph',text:'Second'}]};
    const element=document.createElement('div');document.body.append(element);
    const editor=new Editor({element,extensions:documentExtensions(),content:docModelToEditorJson(initial),onUpdate:()=>updates++});
    editor.setEditable(true,false);
    const initialUpdates=updates;
    editor.commands.setTextSelection({from:1,to:4});editor.commands.toggleBold();
    editor.commands.setHeading({level:1});
    let secondPosition=0;
    editor.state.doc.descendants((node,pos)=>{if(node.attrs.blockId==='second')secondPosition=pos});
    editor.commands.setTextSelection(secondPosition+1);editor.commands.toggleOrderedList();
    const beforeSplit=editorJsonToDocModel(editor.getJSON());
    editor.state.doc.descendants((node,pos)=>{if(node.attrs.blockId==='second')secondPosition=pos});
    editor.commands.setTextSelection(secondPosition+1+'Second'.length);
    editor.view.dispatch(closeHistory(editor.state.tr));
    editor.commands.splitListItem('listItem');
    const afterSplit=editorJsonToDocModel(editor.getJSON());
    editor.commands.undo();const afterUndo=editorJsonToDocModel(editor.getJSON());
    editor.commands.redo();const afterRedo=editorJsonToDocModel(editor.getJSON());
    const beforeLock=updates;editor.setEditable(false,false);
    const readonly={editable:editor.isEditable,updatesChanged:updates!==beforeLock};
    const plain=new Editor({element:document.createElement('div'),extensions:documentExtensions(true),content:docModelToEditorJson(initial)});
    console.log(JSON.stringify({initialUpdates,beforeSplit,afterSplit,afterUndo,afterRedo,readonly,plainHasBold:Boolean(plain.schema.marks.bold)}));
    plain.destroy();editor.destroy();dom.window.close();
  `;
  const child = Bun.spawn([process.execPath, '-e', script], {
    cwd: process.cwd(),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [output, error, exit] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect(error).toBe('');
  expect(exit).toBe(0);
  const result = JSON.parse(output.trim());
  expect(result.initialUpdates).toBe(0);
  expect(result.beforeSplit.blocks.map((block: { id: string }) => block.id)).toEqual(['first', 'second']);
  expect(result.beforeSplit.blocks[0].runs.some((run: { bold?: boolean }) => run.bold)).toBe(true);
  expect(result.afterSplit.blocks).toHaveLength(3);
  expect(result.afterSplit.blocks[1].id).toBe('second');
  expect(new Set(result.afterSplit.blocks.map((block: { id: string }) => block.id)).size).toBe(3);
  expect(result.afterUndo).toEqual(result.beforeSplit);
  expect(result.afterRedo).toEqual(result.afterSplit);
  expect(result.readonly).toEqual({ editable: false, updatesChanged: false });
  expect(result.plainHasBold).toBe(false);
}, 20_000);
