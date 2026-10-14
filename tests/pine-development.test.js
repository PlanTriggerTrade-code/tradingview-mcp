import {test} from 'node:test';
import assert from 'node:assert/strict';
import {assertEditor,registerPineDevelopment} from '../src/pine-development.js';
import {canonicalSource,updatePine,EDITOR_STATE,usesScript} from '../src/pine-development.js';
import {SNAPSHOT} from '../src/layout-safety.js';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {hash,recordScratch,PROTECTION_FILE} from '../src/layout-safety.js';
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
test('all protected layouts are refused before opening a new tab',async()=>{
 const root=await mkdtemp(join(tmpdir(),'pine-guard-'));
 const ids=['prot0001','prot0002','prot0003'];
 await writeFile(join(root,PROTECTION_FILE),JSON.stringify({layouts:ids.map(id=>({id,name:'Protected '+id}))}));
 try{
  const handlers=new Map();const z={string:()=>({}),literal:()=>({}),array:()=>({min:()=>({})})};
  registerPineDevelopment({tool:(name,d,s,h)=>handlers.set(name,h)}, {z,root,connect:()=>assert.fail('connected'),listTargets:()=>assert.fail('listed')});
  for(const layout_id of ids){
   const r=await handlers.get('pine_development_open')({layout_id});
   assert.equal(r.isError,true);assert.match(r.content[0].text,/PROTECTED_OR_INVALID/);
  }
 }finally{await rm(root,{recursive:true,force:true});}
});

test('exact staged source can resume, and cloud CRLF is content-equivalent',()=>{
 assert.doesNotThrow(()=>assertEditor({...editor,source:source+'// desired'},remote,hash(source+'// desired'),source+'// desired'));
 assert.equal(canonicalSource('a\r\nb\r\n'),'a\nb\n');
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
   if(e.includes('await action.run()')){assert.equal(canonicalSource(ctx.saved),desired);ctx.compiles++;state.state.charts[0].panes[0].sources.push({id:'new-study'});}
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
const tempRoot=()=>mkdtemp(join(tmpdir(),'pine-guard-'));

test('guarded save compiles only after verified cloud readback and preserves chart sources',async()=>{
 const root=await tempRoot();
 await recordScratch(root,'test123','Development'); // uploads compile on a scratch chart
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

test('saving a script that runs on an open real chart needs the user\'s yes and names that chart',async()=>{
 const root=await tempRoot();
 await recordScratch(root,'test123','Development');await recordScratch(root,'scr00009','Scratch with the script');
 const dev=layoutState('test123','Development');
 const others={
  real0001:layoutState('real0001','Real chart one',[scriptStudy]),
  real0002:layoutState('real0002','BTC no script',[{id:'o',type:'Study',state:{inputs:{pineId:'USER;other'}}}]),
  scr00009:layoutState('scr00009','Scratch with the script',[scriptStudy]),
 };
 try{
  let ctx=freshCtx();
  await assert.rejects(updatePine(updateArgs(dev),{root,...tabs(dev,ctx,others)}),
   e=>/PINE_SCRIPT_ON_REAL_CHARTS/.test(e.message)&&/"Real chart one" \(real0001\)/.test(e.message)
     &&!/real0002|scr00009/.test(e.message)&&/not open in TradingView cannot be checked/.test(e.message));
  assert.deepEqual(ctx.writes,[]);assert.equal(ctx.saved,source);
  ctx=freshCtx();
  const ok=await updatePine(updateArgs(dev,{user_approved:true}),{root,...tabs(dev,ctx,others)});
  assert.equal(ok.saved,true);assert.equal(ctx.compiles,1);
  // Only charts that are not real, or real charts without the script: no approval needed.
  ctx=freshCtx();const {real0001:_,...harmless}=others;
  assert.equal((await updatePine(updateArgs(dev),{root,...tabs(dev,ctx,harmless)})).saved,true);
 }finally{await rm(root,{recursive:true,force:true});}
});

test('an open tab that cannot be read, or no tab list at all, blocks an unapproved save',async()=>{
 const root=await tempRoot();await recordScratch(root,'test123','Development');
 const dev=layoutState('test123','Development');
 try{
  let ctx=freshCtx();
  await assert.rejects(updatePine(updateArgs(dev),{root,...tabs(dev,ctx,{dead0001:new Error('renderer gone')})}),
   /PINE_SCRIPT_ON_REAL_CHARTS.*unreadable tab https:\/\/www\.tradingview\.com\/chart\/dead0001\//);
  assert.deepEqual(ctx.writes,[]);
  ctx=freshCtx();const {listTargets:_,...noList}=tabs(dev,ctx);
  await assert.rejects(updatePine(updateArgs(dev),{root,...noList}),/OPEN_LAYOUTS_UNCHECKED/);
  assert.deepEqual(ctx.writes,[]);
 }finally{await rm(root,{recursive:true,force:true});}
});

test('pine_development inspect, load and update refuse a real chart without approval and work with it',async()=>{
 const root=await tempRoot();
 const dev=layoutState('real5678','Development on a real chart'); // not in the scratch registry: a real chart
 const z={string:()=>({}),literal:()=>({}),array:()=>({min:()=>({})}),boolean:()=>({optional:()=>({})})};
 try{
  for(const approved of [false,true]){
   const ctx=freshCtx();const deps=tabs(dev,ctx);
   const handlers=new Map();
   registerPineDevelopment({tool:(n,d,s,h)=>handlers.set(n,h)},{z,root,connect:deps.connect,listTargets:deps.listTargets});
   const base={target_id:'dev',layout_id:dev.uid,...(approved?{user_approved:true}:{})};
   const inspect=await handlers.get('pine_development_inspect')(base);
   const load=await handlers.get('pine_development_load')({...base,script_id:SCRIPT});
   const update=await handlers.get('pine_development_update')(updateArgs(dev,approved?{user_approved:true}:{}));
   for(const [name,r] of [['inspect',inspect],['load',load],['update',update]]){
    if(approved){assert.equal(r.isError,undefined,`${name}: ${r.content[0].text}`);}
    else{assert.equal(r.isError,true,name);assert.match(r.content[0].text,/REAL_CHART_NEEDS_PERMISSION/,name);}
   }
   if(!approved)assert.deepEqual(ctx.writes,[]);
   else assert.equal(JSON.parse(update.content[0].text).saved,true);
  }
 }finally{await rm(root,{recursive:true,force:true});}
});
