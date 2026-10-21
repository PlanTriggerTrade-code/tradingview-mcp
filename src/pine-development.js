import { SNAPSHOT, validate, backup, withLock, hash, ROOT, guardedExpression, verifyPreserved, loadProtection, protectedChartsUsingScript, UNCHECKABLE } from './layout-safety.js';
// Saving a script updates its instances on every layout TradingView has open (observed: an open
// second layout's instance moved to the new version right after a save); see
// protectedChartsUsingScript.
export { usesScript, protectedChartsUsingScript } from './layout-safety.js';
import { FIND_MONACO, OPEN_EDITOR, CLICK_PINE_BUTTON } from './core/pine.js';
// Pine edits compile by adding the script to the chart: on a protected chart that needs the
// user's yes (user_approved), checked by validate().

// The Pine editor the user can see. TradingView keeps several Monaco copies in the page (hidden
// ones from earlier scripts, detached ones without a React fiber): FIND_MONACO from core/pine.js
// searches all of them and prefers the on-screen editor (cab1f2e). It falls back to a hidden
// editor when none is on screen; these tools refuse that case (null) instead of acting on it.
export const EDITOR = `(()=>{const m=${FIND_MONACO.trim()};
 const d=m&&m.editor.getDomNode&&m.editor.getDomNode();
 return d&&d.offsetParent!==null?m:null;
})()`;
export const EDITOR_STATE = `(()=>{const m=${EDITOR};if(!m)return null;
 const model=m.editor.getModel();return {source:m.editor.getValue(),
 title:document.querySelector('[data-qa-id="pine-script-title-button"]')?.innerText?.trim(),
 errors:m.env.editor.getModelMarkers({resource:model.uri}).filter(x=>x.severity===8).map(x=>({line:x.startLineNumber,message:x.message})),
 actions:m.editor.getSupportedActions().map(x=>x.id)};
})()`;
// Content equality for Pine source: TradingView's editor and cloud normalize line endings (CRLF and
// lone CR become LF) and may add or drop the final newline, so compare without those.
export const canonicalSource=s=>s.replace(/\r\n?/g,'\n').replace(/\n+$/,'');
// The same comparison as a page expression: true when the editor text (valueExpr) is source.
export const sameSourceExpression=(valueExpr,source)=>`((${valueExpr})??'').replace(/\\r\\n?/g,'\\n').replace(/\\n+$/,'')===${JSON.stringify(canonicalSource(source))}`;
const q=JSON.stringify;
const delay=ms=>new Promise(r=>setTimeout(r,ms));
export function titleOf(source) {return source.match(/(?:strategy|indicator|library)\(\s*"([^"]+)"/)?.[1];}
export function assertEditor(editor, remote, expectedHash, source) {
 if(!editor || !editor.title || !editor.source) throw Error('PINE_EDITOR_NOT_READY');
 if(hash(editor.source)!==expectedHash) throw Error('PINE_SOURCE_CHANGED: inspect editor again');
 if(editor.title!==remote.scriptName && editor.title!==remote.scriptTitle) throw Error('PINE_BINDING_MISMATCH: editor title does not match selected saved script');
 if(editor.source!==source && editor.source.replace(/\r\n/g,'\n')!==remote.source.replace(/\r\n/g,'\n')) throw Error('PINE_UNSAVED_OR_DIFFERENT_SCRIPT: editor must match the selected saved version before update');
 if(titleOf(source)!==titleOf(editor.source)) throw Error('PINE_TITLE_CHANGED: this operation updates an existing script without renaming');
}
async function runner(client, expression) {
 const r=await client.Runtime.evaluate({expression,returnByValue:true,awaitPromise:true});
 if(r.exceptionDetails)throw Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
 return r.result.value;
}
async function remoteScript(run,id) {
 return run(`(async()=>{
  const r=await fetch('https://pine-facade.tradingview.com/pine-facade/list/?filter=saved',{credentials:'include'});
  if(!r.ok)throw Error('Cannot list scripts');const list=await r.json();
  const s=list.find(s=>s.scriptIdPart===${q(id)});if(!s)throw Error('Saved script ID not found');
  if(list.filter(x=>(x.scriptName||x.scriptTitle)===(s.scriptName||s.scriptTitle)).length!==1)throw Error('Ambiguous saved script title');
  const source=await fetch('https://pine-facade.tradingview.com/pine-facade/get/'+encodeURIComponent(s.scriptIdPart)+'/'+encodeURIComponent(s.version),{credentials:'include'});
  if(!source.ok)throw Error('Cannot read saved source');return {...s,source:(await source.json()).source};
 })()`);
}

export async function updatePine(args,deps) {
 const root=deps.root||ROOT;
 const prot=await loadProtection(root);
 return withLock(root,args.layout_id,()=>withLock(root,'pine-'+args.script_id.replace(/[^A-Za-z0-9_-]/g,'_'),async()=>{
  const client=await deps.connect(args.target_id);const run=e=>runner(client,e);
  let backupPath;
  try {
   let before=await run(SNAPSHOT);validate(before,args,{protection:prot,approved:args.user_approved===true});
   // Deliberately limited to an explicitly designated single-chart development layout.
   if(args.development!==true || before.state.layout!=='s' || before.state.charts.length!==1) throw Error('DEDICATED_DEVELOPMENT_LAYOUT_REQUIRED');
   const others=await protectedChartsUsingScript(args.script_id,{connect:deps.connect,listTargets:deps.listTargets,root,exclude:before.uid});
   if(others.found.length&&args.user_approved!==true)throw Error(`PINE_SCRIPT_ON_PROTECTED_CHARTS: saving ${args.script_id} also updates it on the protected charts ${others.found.join(', ')}. Ask the user; pass user_approved: true only after they said yes. ${UNCHECKABLE}`);
   if(await run(`[...document.querySelectorAll('[role="dialog"]')].some(e=>e.dataset.name!=='open-user-script-dialog')`))throw Error('PINE_DIALOG_OPEN: finish loading before update');
   const editor=await run(EDITOR_STATE);const remote=await remoteScript(run,args.script_id);
   if(String(remote.version)!==args.expected_version)throw Error('PINE_CLOUD_VERSION_CHANGED');
   assertEditor(editor,remote,args.source_hash,args.source);
   backupPath=await backup(root,{...before,pine:{editor,remote}},'pine_development_update');
   const checkEditor=`const m=${EDITOR};if(!m||m.editor.getValue()!==${q(editor.source)}||document.querySelector('[data-qa-id="pine-script-title-button"]')?.innerText?.trim()!==${q(editor.title)})throw Error('PINE_EDITOR_CHANGED');`;
   await run(guardedExpression(before,`${checkEditor} document.querySelector('[data-name="open-user-script-dialog"] [data-qa-id="close"]')?.click();m.editor.setValue(${q(args.source)});`));
   // Save through the Pine toolbar first; never depend on an unsaved-add confirmation.
   const preSave=await run(SNAPSHOT);validate(preSave,{layout_id:args.layout_id,chart_id:args.chart_id},{protection:prot,approved:args.user_approved===true});
   await run(guardedExpression(preSave,`const m=${EDITOR};if(!(${sameSourceExpression('m?.editor.getValue()',args.source)})||document.querySelector('[data-qa-id="pine-script-title-button"]')?.innerText?.trim()!==${q(editor.title)})throw Error('PINE_EDITOR_CHANGED');const b=document.querySelector('[data-qa-id="pine-script-save-button"]');if(!b)throw Error('PINE_SAVE_BUTTON_UNAVAILABLE');if(!b.disabled)b.click();`));
   let cloud;
   for(let i=0;i<100;i++){await (deps.delay||delay)(500);cloud=await remoteScript(run,args.script_id);if(canonicalSource(cloud.source)===canonicalSource(args.source))break;if(i===99)throw Error('PINE_CLOUD_SAVE_NOT_CONFIRMED');}
   // No global keyboard shortcut or generic Save button. Recheck layout and editor before compiling.
   before=await run(SNAPSHOT);validate(before,{layout_id:args.layout_id,chart_id:args.chart_id},{protection:prot,approved:args.user_approved===true});
   await run(guardedExpression(before,`const m=${EDITOR};if(!(${sameSourceExpression('m?.editor.getValue()',args.source)}))throw Error('PINE_SOURCE_CHANGED');
    const pending=[...document.querySelectorAll('[data-qa-id="no-btn"]')].filter(b=>b.parentElement?.parentElement?.textContent.includes("Save this script before adding?"));if(pending.length>1)throw Error('AMBIGUOUS_PINE_CONFIRMATION');pending[0]?.click();m.editor.focus();
    const action=m.editor.getSupportedActions().find(x=>x.id.endsWith(':add.to.chart'));
    if(!action)throw Error('PINE_COMPILE_ACTION_UNAVAILABLE');await action.run();`));
   let status,after;
   for(let i=0;i<100;i++){
    await (deps.delay||delay)(500);
    status=await run(EDITOR_STATE);
    if(status?.errors?.length)throw Error('PINE_COMPILE_ERRORS: '+JSON.stringify(status.errors));
    after=await run(SNAPSHOT);validate(after,{layout_id:args.layout_id,chart_id:args.chart_id},{protection:prot,approved:args.user_approved===true});
    const studies=await run(`(()=>{const c=window.TradingViewApi._activeChartWidgetWV.value();return c.getAllStudies().map(s=>({...s,inputs:c.getStudyById(s.id).study().metaInfo().inputs.map(i=>i.name)}));})()`);
    if(studies.some(s=>s.name===titleOf(args.source) && args.expected_input_titles.every(t=>s.inputs.includes(t))) && i>=5)break;
    if(i===99)throw Error('PINE_COMPILE_NOT_CONFIRMED');
   }
   verifyPreserved(before,after);
   let saved;
   for(let i=0;i<20;i++){
    await (deps.delay||delay)(500);saved=await remoteScript(run,args.script_id);
    if(canonicalSource(saved.source)===canonicalSource(args.source))break;
    if(i===19)throw Error('PINE_CLOUD_SAVE_NOT_CONFIRMED');
   }
   const final=await run(SNAPSHOT);validate(final,{layout_id:args.layout_id,chart_id:args.chart_id},{protection:prot,approved:args.user_approved===true});
   verifyPreserved(before,final);
   await backup(root,{...final,pine:{source:args.source,script_id:args.script_id,version:saved.version}},'pine_development_update:after');
   return {success:true,saved:true,script_id:args.script_id,version:saved.version,backup:backupPath,layout_id:final.uid,
    source_hash:hash(args.source),also_updates_open_protected_charts:others.found,
    ...(others.unreadable.length?{could_not_check:others.unreadable}:{}),
    note:`Cloud source verified with CRLF/LF normalization. Open layouts that use the script may move to the new version. ${UNCHECKABLE}`};
  }catch(e){throw Error(e.message+(backupPath?` Backup: ${backupPath}. Inspect before retrying.`:''));}
  finally{await client.close();}
 }));
}

// `bool` builds the user_approved schema (server.js passes the repository's booleanParam).
export function registerPineDevelopment(server,{z,connect,listTargets,root=ROOT,bool}) {
 const ok=x=>({content:[{type:'text',text:JSON.stringify(x)}]});
 const fail=e=>({...ok({success:false,error:e.message}),isError:true});
 const approval=typeof bool==='function'?bool():typeof z.boolean==='function'?z.boolean():undefined;
 const identity={target_id:z.string(),layout_id:z.string(),...(approval?{user_approved:approval.optional()}:{})};
 server.tool('pine_development_open','Open an existing saved layout in a NEW tab for development; never reuses the current tab.',{layout_id:z.string(),source_target_id:z.string(),source_layout_id:z.string()},async args=>{
  try {
   if(!/^[A-Za-z0-9_-]+$/.test(args.layout_id))throw Error('INVALID_LAYOUT_ID');
   const url='https://www.tradingview.com/chart/'+args.layout_id+'/';
   const oldIds=new Set((await listTargets()).map(t=>t.id));
   await withLock(root,args.source_layout_id,async()=>{
    const source=await connect(args.source_target_id);
    try{const state=await runner(source,SNAPSHOT);validate(state,{layout_id:args.source_layout_id},{writable:false});
     await backup(root,state,'pine_development_open:source');
     await runner(source,guardedExpression(state,`window.open(${q(url)},'_blank','noopener');`));
    }finally{await source.close();}
   });
   let target;for(let i=0;i<30;i++){
    const matches=(await listTargets()).filter(t=>!oldIds.has(t.id)&&t.url===url);
    if(matches.length>1)throw Error('AMBIGUOUS_NEW_TAB');if(matches.length===1){target=matches[0];break;}await delay(300);
   }if(!target)throw Error('DESKTOP_NEW_TAB_NOT_CONFIRMED');
   const client=await connect(target.id);
   try {for(let i=0;i<40;i++){
    let s;try{s=await runner(client,SNAPSHOT);}catch(e){if(i===39)throw e;await delay(500);continue;}
    validate(s,args,{writable:false});if(s.state.layout!=='s'||s.state.charts.length!==1)throw Error('DEDICATED_DEVELOPMENT_LAYOUT_REQUIRED');
    return ok({target_id:target.id,layout_id:s.uid,chart_id:s.chartId,state_hash:hash(s.state)});
   }}finally{await client.close();}
  }catch(e){return fail(e);}
 });
 server.tool('pine_development_inspect','Inspect/open the Pine panel on an explicit development layout. Returns editor hash and saved script IDs. On a protected chart pass user_approved: true only after the user said yes.',identity,async args=>{
  try{const prot=await loadProtection(root);return await withLock(root,args.layout_id,async()=>{
   const client=await connect(args.target_id);const run=e=>runner(client,e);
   try{
    const s=await run(SNAPSHOT);validate(s,args,{protection:prot,approved:args.user_approved===true});
    if(s.state.layout!=='s'||s.state.charts.length!==1)throw Error('DEDICATED_DEVELOPMENT_LAYOUT_REQUIRED');
    await backup(root,s,'pine_development_inspect');
    if(!await run(EDITOR_STATE)){
     // Same open sequence as core/pine.js ensurePineEditorOpen, inside the identity check.
     await run(guardedExpression(s,`${OPEN_EDITOR};${CLICK_PINE_BUTTON};`));
    }
    // Up to 30s: the first open after TradingView starts can take well over 10s (9dd3d15).
    let editor;for(let i=0;i<100;i++){editor=await run(EDITOR_STATE);if(editor)break;await delay(300);}
    const final=await run(SNAPSHOT);validate(final,args,{protection:prot,approved:args.user_approved===true});
    const scripts=await run(`fetch('https://pine-facade.tradingview.com/pine-facade/list/?filter=saved',{credentials:'include'}).then(r=>r.json()).then(a=>a.map(s=>({id:s.scriptIdPart,name:s.scriptName,title:s.scriptTitle,version:s.version})))`);
    return ok({target_id:args.target_id,layout_id:final.uid,chart_id:final.chartId,state_hash:hash(final.state),
     editor:editor?{title:editor.title,source_hash:hash(editor.source),script_title:titleOf(editor.source),errors:editor.errors,actions:editor.actions.filter(x=>x.startsWith('vs.editor'))}:null,scripts, diagnostics:await run(`(()=>{const c=window.TradingViewApi._activeChartWidgetWV.value();return {studies:c.getAllStudies().map(s=>({...s,inputs:c.getStudyById(s.id).study().metaInfo().inputs.filter(i=>!i.isHidden).slice(0,8).map(i=>({id:i.id,name:i.name}))}))};})()`)});
   }finally{await client.close();}
  });}catch(e){return fail(e);}
 });
 server.tool('pine_development_load','Open an exact saved script through the real Pine picker, preserving its editor binding. On a protected chart pass user_approved: true only after the user said yes.',{...identity,script_id:z.string()},async args=>{
  try{const prot=await loadProtection(root);return await withLock(root,args.layout_id,async()=>{const client=await connect(args.target_id);const run=e=>runner(client,e);
   try{const s=await run(SNAPSHOT);validate(s,args,{protection:prot,approved:args.user_approved===true});if(s.state.layout!=='s'||s.state.charts.length!==1)throw Error('DEDICATED_DEVELOPMENT_LAYOUT_REQUIRED');
    const remote=await remoteScript(run,args.script_id);
    await backup(root,{...s,pine:await run(EDITOR_STATE)},'pine_development_load');
    await run(guardedExpression(s,`if(!document.querySelector('[data-name="open-user-script-dialog"]')){const m=${EDITOR};const a=m?.editor.getSupportedActions().find(x=>x.id.endsWith(':open.script'));if(!a)throw Error('PINE_OPEN_ACTION_UNAVAILABLE');await a.run();}`));
    await delay(700);
    const current=await run(SNAPSHOT);validate(current,args,{protection:prot,approved:args.user_approved===true});
    await run(guardedExpression(current,`const name=${q(remote.scriptName||remote.scriptTitle)},dlg='[data-name="open-user-script-dialog"]';
     const find=()=>[...document.querySelectorAll(dlg+' [data-name="open-script-dialog-item-name"]')].filter(e=>e.textContent.trim()===name);
     let rows=find();
     if(rows.length===0){ // the picker renders only the rows in view: filter it by name
      const box=document.querySelector(dlg+' input[type="text"]');
      if(box){Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(box,name);box.dispatchEvent(new Event('input',{bubbles:true}));
       for(let i=0;i<20&&!(rows=find()).length;i++)await new Promise(r=>setTimeout(r,150));}
     }
     if(rows.length!==1)throw Error('EXACT_SCRIPT_ROW_NOT_VISIBLE');rows[0].parentElement.click();`));
    let editor;for(let i=0;i<30;i++){await delay(300);editor=await run(EDITOR_STATE);if(editor?.source?.replace(/\r\n/g,'\n')===remote.source.replace(/\r\n/g,'\n'))break;}
    assertEditor(editor,remote,hash(editor?.source),remote.source);
    const loaded=await run(SNAPSHOT);validate(loaded,args,{protection:prot,approved:args.user_approved===true});
    await run(guardedExpression(loaded,`document.querySelector('[data-name="open-user-script-dialog"] [data-qa-id="close"]')?.click();`));
    const final=await run(SNAPSHOT);validate(final,args,{protection:prot,approved:args.user_approved===true});verifyPreserved(s,final);
    return ok({target_id:args.target_id,layout_id:final.uid,chart_id:final.chartId,state_hash:hash(final.state),source_hash:hash(editor.source),script_id:args.script_id,title:editor.title});
   }finally{await client.close();}});}catch(e){return fail(e);}
 });
 server.tool('pine_development_verify','Read back a saved Pine version and compare its exact source hash; no chart or editor changes.',{...identity,script_id:z.string(),source_hash:z.string()},async args=>{
  let client;try{client=await connect(args.target_id);const run=e=>runner(client,e);
   const state=await run(SNAPSHOT);validate(state,args,{writable:false});
   const remote=await remoteScript(run,args.script_id);
   return ok({script_id:args.script_id,version:remote.version,source_hash:hash(remote.source),matches:hash(remote.source)===args.source_hash,normalized_hash:hash(remote.source.replace(/\r\n/g,'\n')),normalized_matches:hash(remote.source.replace(/\r\n/g,'\n'))===args.source_hash,
    trial_fields:['Long trial ID','Short trial ID'].filter(t=>remote.source.includes('"'+t+'"'))});
  }catch(e){return fail(e);}finally{if(client)await client.close();}
 });
 server.tool('pine_development_update','Back up, update, compile and save an existing Pine script on a verified development layout; verify cloud source readback. On a protected chart, or when an open protected chart uses the script (saving updates it there too), pass user_approved: true only after the user said yes.',
  {...identity,chart_id:z.string(),state_hash:z.string(),source_hash:z.string(),expected_version:z.string(),script_id:z.string(),source:z.string(),expected_input_titles:z.array(z.string()).min(1),development:z.literal(true)},
  async args=>{try{return ok(await updatePine(args,{connect,listTargets,root}));}catch(e){return fail(e);}});
}
