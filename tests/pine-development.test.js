import {test} from 'node:test';
import assert from 'node:assert/strict';
import {assertEditor,registerPineDevelopment} from '../src/pine-development.js';
import {canonicalSource,sameSourceExpression,updatePine,EDITOR_STATE,usesScript} from '../src/pine-development.js';
import {SNAPSHOT} from '../src/layout-safety.js';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {hash,PROTECTION_FILE} from '../src/layout-safety.js';
const source='//@version=6\nstrategy("Example")\n';
const editor={source,title:'Example'};
const remote={source,scriptName:'Example'};
test('matching saved script can be updated without altering its identity',()=>{
 assert.doesNotThrow(()=>assertEditor(editor,remote,hash(source),source+'// metadata'));
});
test('wrong editor binding, stale source, unsaved source and renames are rejected',()=>{
 assert.throws(()=>assertEditor({...editor,title:'Other'},remote,hash(source),source),/BINDING/);
 assert.throws(()=>assertEditor(editor,remote,'stale',source),/SOURCE_CHANGED/);
 assert.throws(()=>assertEditor(editor,{...remote,source:'different'},hash(source),source+'// new change'),/UNSAVED_OR_DIFFERENT/);
 assert.throws(()=>assertEditor(editor,remote,hash(source),'strategy("Other")'),/TITLE_CHANGED/);
});
test('pine_development_open refuses an invalid layout ID before opening a tab',async()=>{
 const handlers=new Map();const z={string:()=>({}),literal:()=>({}),array:()=>({min:()=>({})})};
 registerPineDevelopment({tool:(name,d,s,h)=>handlers.set(name,h)}, {z,connect:()=>assert.fail('connected'),listTargets:()=>assert.fail('listed')});
 for(const layout_id of ['has space','../x','']){
  const r=await handlers.get('pine_development_open')({layout_id});
  assert.equal(r.isError,true);assert.match(r.content[0].text,/INVALID_LAYOUT_ID/);
 }
});

test('exact staged source can resume, and cloud CRLF is content-equivalent',()=>{
 assert.doesNotThrow(()=>assertEditor({...editor,source:source+'// desired'},remote,hash(source+'// desired'),source+'// desired'));
 assert.equal(canonicalSource('a\r\nb\r\n'),'a\nb');
 assert.equal(canonicalSource('a\rb\n\n'),canonicalSource('a\nb'));
 assert.notEqual(canonicalSource('a\r\nc'),canonicalSource('a\nb'));
});

// ── Fake TradingView pages (no connection) ───────────────────────────────

const SCRIPT='USER;test';
const desired=source+'input.string("", "Trial ID")\n';
const chartUrl=uid=>`https://www.tradingview.com/chart/${uid}/`;
const layoutState=(uid,name,extraSources=[])=>({url:chartUrl(uid),uid,name,chartId:'1',
 state:{name,layout:'s',charts:[{chartId:'1',panes:[{sources:[{id:'series',type:'MainSeries'},...extraSources]}]}]}});
// A study of the script being saved, as TradingView stores it in the layout state.
const scriptStudy={id:'st1',type:'Study',state:{inputs:{pineId:SCRIPT,pineVersion:'10.0'}}};

/** The development page: answers the guarded Pine flow and logs every write expression. */
function devPage(state,ctx){
 return {close:async()=>{ctx.closed=true;},Runtime:{evaluate:async({expression:e})=>{
  let value;
  if(e===SNAPSHOT)value=structuredClone(state);
  else if(e===EDITOR_STATE)value={source:ctx.current,title:'Example',errors:[],actions:['vs.editor.action']};
  else if(e.includes('Saved script ID not found'))value={source:ctx.saved,version:ctx.version,scriptName:'Example',scriptIdPart:SCRIPT};
  else if(e.includes('pine-facade/list/'))value=[{id:SCRIPT,name:'Example',title:'Example',version:ctx.version}];
  else if(e.startsWith('[...document.querySelectorAll'))value=false;
  else if(e.startsWith('(async()=>')){
   ctx.writes.push(e);
   if(e.includes('m.editor.setValue'))ctx.current=desired;
   if(e.includes('pine-script-save-button')){ctx.saved=ctx.current.replace(/\n/g,'\r\n');ctx.version='11.0';}
   if(e.includes('await action.run()')){assert.equal(canonicalSource(ctx.saved),canonicalSource(desired));ctx.compiles++;state.state.charts[0].panes[0].sources.push({id:'new-study'});}
   value=true;
  }else if(e.includes('return {studies:'))value={studies:[]};
  else if(e.includes('getAllStudies'))value=[{name:'Example',inputs:['Trial ID']}];
  else throw Error('Unexpected expression '+e.slice(0,90));
  return {result:{value}};
 }}};
}
/** Another open tab: answers only the read-only snapshot. */
const otherPage=state=>({close:async()=>{},Runtime:{evaluate:async({expression:e})=>{
 if(e!==SNAPSHOT)assert.fail('wrote to another tab: '+e.slice(0,60));
 return {result:{value:structuredClone(state)}};
}}});
const freshCtx=()=>({current:source,saved:source,version:'10.0',compiles:0,closed:false,writes:[]});
const updateArgs=(dev,extra={})=>({target_id:'dev',layout_id:dev.uid,chart_id:'1',state_hash:hash(dev.state),source_hash:hash(source),
 script_id:SCRIPT,expected_version:'10.0',source:desired,development:true,expected_input_titles:['Trial ID'],...extra});
/** deps for updatePine: the dev tab plus other open tabs given as {id: state | Error}. */
function tabs(dev,ctx,others={}){
 const devState=structuredClone(dev);
 return {
  delay:async()=>{},
  listTargets:async()=>[{id:'dev',type:'page',url:dev.url},{id:'shell',type:'page',url:'file:///app/window/index.html'},
   ...Object.entries(others).map(([id,s])=>({id,type:'page',url:s instanceof Error?chartUrl(id):s.url}))],
  connect:async id=>{
   if(id==='dev')return devPage(devState,ctx);
   const s=others[id];if(!s)assert.fail('connected to unknown target '+id);
   if(s instanceof Error)return {close:async()=>{},Runtime:{evaluate:async()=>{throw s;}}};
   return otherPage(s);
  },
 };
}
// A temporary state folder whose protection list protects prot* layouts (made-up IDs).
const tempRoot=async()=>{const root=await mkdtemp(join(tmpdir(),'pine-guard-'));
 await writeFile(join(root,PROTECTION_FILE),JSON.stringify({layouts:[{id:'prot0001',name:'Protected one'},{id:'prot5678',name:'Protected dev'}]}));
 return root;};

test('guarded save compiles only after verified cloud readback and preserves chart sources',async()=>{
 const root=await tempRoot();
 const dev=layoutState('test123','Development');const ctx=freshCtx();
 try{
  const result=await updatePine(updateArgs(dev),{root,...tabs(dev,ctx)});
  assert.equal(result.saved,true);assert.equal(result.version,'11.0');assert.equal(ctx.compiles,1);assert.equal(ctx.closed,true);
 }finally{await rm(root,{recursive:true,force:true});}
});

test('usesScript finds the script ID anywhere in a layout state',()=>{
 assert.equal(usesScript(layoutState('a','A',[scriptStudy]).state,SCRIPT),true);
 assert.equal(usesScript(layoutState('a','A',[{id:'x',type:'Study',metaInfo:{scriptIdPart:SCRIPT}}]).state,SCRIPT),true);
 assert.equal(usesScript(layoutState('a','A',[{id:'x',type:'Study',state:{inputs:{pineId:'USER;other'}}}]).state,SCRIPT),false);
});

test('saving a script that runs on an open protected chart needs the user\'s yes and names that chart',async()=>{
 const root=await tempRoot();
 const dev=layoutState('test123','Development');
 const others={
  prot0001:layoutState('prot0001','Protected one',[scriptStudy]),
  free0002:layoutState('free0002','Free chart with the script',[scriptStudy]),
  free0003:layoutState('free0003','Free chart, other script',[{id:'o',type:'Study',state:{inputs:{pineId:'USER;other'}}}]),
 };
 try{
  let ctx=freshCtx();
  await assert.rejects(updatePine(updateArgs(dev),{root,...tabs(dev,ctx,others)}),
   e=>/PINE_SCRIPT_ON_PROTECTED_CHARTS/.test(e.message)&&/"Protected one" \(prot0001\)/.test(e.message)
     &&!/free0002|free0003/.test(e.message)&&/not open in TradingView cannot be checked/.test(e.message));
  assert.deepEqual(ctx.writes,[]);assert.equal(ctx.saved,source);
  ctx=freshCtx();
  const ok=await updatePine(updateArgs(dev,{user_approved:true}),{root,...tabs(dev,ctx,others)});
  assert.equal(ok.saved,true);assert.equal(ctx.compiles,1);
  assert.deepEqual(ok.also_updates_open_protected_charts,['"Protected one" (prot0001)']);
  // Free charts using the script need no approval.
  ctx=freshCtx();const {prot0001:_,...free}=others;
  assert.equal((await updatePine(updateArgs(dev),{root,...tabs(dev,ctx,free)})).saved,true);
 }finally{await rm(root,{recursive:true,force:true});}
});

test('an open tab that cannot be read, or no tab list at all, does not block the save but is reported',async()=>{
 const root=await tempRoot();
 const dev=layoutState('test123','Development');
 try{
  let ctx=freshCtx();
  const r=await updatePine(updateArgs(dev),{root,...tabs(dev,ctx,{dead0001:new Error('renderer gone')})});
  assert.equal(r.saved,true);assert.deepEqual(r.could_not_check,['https://www.tradingview.com/chart/dead0001/']);
  ctx=freshCtx();const {listTargets:_,...noList}=tabs(dev,ctx);
  const r2=await updatePine(updateArgs(dev),{root,...noList});
  assert.equal(r2.saved,true);assert.deepEqual(r2.could_not_check,['the open tabs could not be listed']);
 }finally{await rm(root,{recursive:true,force:true});}
});

test('pine_development inspect, load and update refuse a protected chart without approval and work with it',async()=>{
 const root=await tempRoot();
 const z={string:()=>({}),literal:()=>({}),array:()=>({min:()=>({})}),boolean:()=>({optional:()=>({})})};
 try{
  for(const [dev,needsYes] of [[layoutState('prot5678','Protected dev'),true],[layoutState('free5678','Free dev'),false]]){
   for(const approved of [false,true]){
    const ctx=freshCtx();const deps=tabs(dev,ctx);
    const handlers=new Map();
    registerPineDevelopment({tool:(n,d,s,h)=>handlers.set(n,h)},{z,root,connect:deps.connect,listTargets:deps.listTargets});
    const base={target_id:'dev',layout_id:dev.uid,...(approved?{user_approved:true}:{})};
    const inspect=await handlers.get('pine_development_inspect')(base);
    const load=await handlers.get('pine_development_load')({...base,script_id:SCRIPT});
    const update=await handlers.get('pine_development_update')(updateArgs(dev,approved?{user_approved:true}:{}));
    const refused=needsYes&&!approved;
    for(const [name,r] of [['inspect',inspect],['load',load],['update',update]]){
     if(!refused){assert.equal(r.isError,undefined,`${dev.uid} ${name}: ${r.content[0].text}`);}
     else{assert.equal(r.isError,true,name);assert.match(r.content[0].text,/PROTECTED_CHART_NEEDS_PERMISSION/,name);}
    }
    if(refused)assert.deepEqual(ctx.writes,[]);
    else assert.equal(JSON.parse(update.content[0].text).saved,true);
   }
  }
 }finally{await rm(root,{recursive:true,force:true});}
});

// The editor normalizes what it is given (CRLF to LF, final newline): the in-page check must accept
// that text as the same source and still refuse a different one (2026-10-21: an upload stopped with
// PINE_EDITOR_CHANGED only because of line endings).
test('the in-page editor check treats line endings and the final newline as the same source',()=>{
 const check=(editorText,source)=>new Function(`return ${sameSourceExpression(JSON.stringify(editorText),source)}`)();
 assert.equal(check('a\nb\n','a\r\nb\r\n'),true);
 assert.equal(check('a\nb','a\r\nb\r\n'),true);
 assert.equal(check('a\nb\n','a\nb'),true);
 assert.equal(check('a\nc\n','a\r\nb\r\n'),false);
 assert.equal(new Function(`return ${sameSourceExpression('undefined','a')}`)(),false);
});
