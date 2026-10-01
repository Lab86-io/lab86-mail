import { expect, test } from 'bun:test';

test('real editor transactions preserve block identity, split undo/redo, marks and readonly lifecycle', async () => {
  // A separate DOM process avoids contaminating other React and server suites.
  const script = `
    import { JSDOM } from 'jsdom';
    const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual:true });
    for (const name of ['window','document','HTMLElement','Element','Node','navigator','MutationObserver','DOMParser','KeyboardEvent'])
      Object.defineProperty(globalThis,name,{configurable:true,value:name==='window'?dom.window:dom.window[name]});
    globalThis.getComputedStyle=dom.window.getComputedStyle.bind(dom.window);
    globalThis.requestAnimationFrame=dom.window.requestAnimationFrame.bind(dom.window);
    globalThis.cancelAnimationFrame=dom.window.cancelAnimationFrame.bind(dom.window);
    const { Editor } = await import('@tiptap/react');
    const { closeHistory } = await import('@tiptap/pm/history');
    const { changeListLevel, documentExtensions } = await import('./components/files/editors/doc-extensions.ts');
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
    const nestedInitial={kind:'doc',version:1,blocks:[{id:'a',type:'bullet',text:'One'},{id:'b',type:'bullet',text:'Two',listLevel:1},{id:'c',type:'paragraph',text:'Site',runs:[{text:'Site',link:'https://example.com/'}]}]};
    const nested=new Editor({element:document.createElement('div'),extensions:documentExtensions(),content:docModelToEditorJson(nestedInitial)});
    const loaded=editorJsonToDocModel(nested.getJSON());
    nested.commands.setTextSelection(3);
    nested.commands.keyboardShortcut('Tab');
    const afterTab=editorJsonToDocModel(nested.getJSON());
    let paragraphPosition=0;
    nested.state.doc.descendants((node,pos)=>{if(node.attrs.blockId==='c')paragraphPosition=pos});
    nested.commands.setTextSelection(paragraphPosition+2);
    const outsideList=changeListLevel(nested,1);
    nested.commands.setTextSelection(3);
    changeListLevel(nested,-1);changeListLevel(nested,-1);
    const afterOutdent=editorJsonToDocModel(nested.getJSON());
    console.log(JSON.stringify({initialUpdates,beforeSplit,afterSplit,afterUndo,afterRedo,readonly,loaded,afterTab,outsideList,afterOutdent,hasLink:Boolean(nested.schema.marks.link)}));
    nested.destroy();editor.destroy();dom.window.close();
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
  // Links, nesting levels and their changes survive the real editor.
  expect(result.hasLink).toBe(true);
  expect(result.loaded.blocks.map((block: any) => ({ ...block, id: undefined }))).toEqual([
    { type: 'bullet', text: 'One' },
    { type: 'bullet', text: 'Two', listLevel: 1 },
    { type: 'paragraph', text: 'Site', runs: [{ text: 'Site', link: 'https://example.com/' }] },
  ]);
  expect(result.afterTab.blocks[0].listLevel).toBe(1);
  expect(result.outsideList).toBe(false);
  expect(result.afterOutdent.blocks[0].listLevel).toBeUndefined();
}, 20_000);
