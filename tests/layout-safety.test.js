import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';
import { validate, withLock, guardedExpression, protectRegistrations, verifyPreserved, EMPTY_PROTECTION } from '../src/layout-safety.js';

// Made-up protection list (the real one is the user's own state/protected-layouts.json).
const protection={ids:new Set(['prot0001']),patterns:[/do[\s_.-]*not[\s_.-]*touch/i],layouts:[]};

const fixture=()=>({url:'https://www.tradingview.com/chart/test123/',uid:'test123',name:'Test',chartId:'1',state:{name:'Test',layout:'2h',charts:[
  {chartId:'1',panes:[{sources:[{id:'series',state:{symbol:'BTC'}},{id:'study',state:{inputs:{length:10}}}]}]},
  {chartId:'2',panes:[{sources:[{id:'other',state:{symbol:'ES'}}]}]}
]}});
test('a URL showing another layout than the one loaded does not authorize writes',()=>{
  const s=fixture();s.uid='prot0001';s.url='https://www.tradingview.com/chart/other001/';
  assert.throws(()=>validate(s,{layout_id:'other001'},{protection}),/IDENTITY_MISMATCH/);
});
test('a protected ID survives rename and needs approval',()=>{
  const s=fixture();s.uid='prot0001';s.name='Renamed';s.url='https://www.tradingview.com/chart/prot0001/';
  assert.throws(()=>validate(s,{layout_id:s.uid},{protection}),/PROTECTED_CHART_NEEDS_PERMISSION/);
  assert.doesNotThrow(()=>validate(s,{layout_id:s.uid},{protection,approved:true}));
});
test('writable checks refuse when no protection list was loaded',()=>{
  const s=fixture();
  assert.throws(()=>validate(s,{layout_id:s.uid}),/PROTECTION_NOT_LOADED/);
  assert.doesNotThrow(()=>validate(s,{layout_id:s.uid},{writable:false}));
  assert.doesNotThrow(()=>validate(s,{layout_id:s.uid},{protection:EMPTY_PROTECTION}));
});
test('unknown identity, changed active section, and stale state fail closed',()=>{
  const s=fixture();
  assert.throws(()=>validate({...s,uid:null},{layout_id:'test123'},{protection}),/IDENTITY/);
  assert.throws(()=>validate(s,{layout_id:s.uid,chart_id:'2'},{protection}),/ACTIVE_SECTION/);
  assert.throws(()=>validate(s,{layout_id:s.uid,state_hash:'stale'},{protection}),/LAYOUT_CHANGED/);
});
test('lock conflicts fail and successful owner releases',async()=>{
  const root=await mkdtemp(join(tmpdir(),'tv-safety-'));
  try {await withLock(root,'test123',async()=>{
    await assert.rejects(withLock(root,'test123',async()=>assert.fail()),/LAYOUT_BUSY/);
  }); await withLock(root,'test123',async()=>{});}finally{await rm(root,{recursive:true,force:true});}
});
test('atomic browser assertion rejects a change after backup without executing mutation',async()=>{
  const s=fixture();let writes=0;
  const context={location:{href:s.url},window:{TradingViewApi:{
    _chartWidgetCollection:{metaInfo:{uid:{value:()=>s.uid},name:{value:()=>s.name}}},
    chartWidgetCollectionState:()=>s.state,
    _activeChartWidgetWV:{value:()=>({_chartWidget:{id:()=>s.chartId},setSymbol:()=>writes++})}
  }}};
  const expression=guardedExpression(structuredClone(s),'c.setSymbol("ETH");');
  s.state.charts[1].panes[0].sources[0].state.symbol='NQ';
  await assert.rejects(vm.runInNewContext(expression,context),/CHANGED_BEFORE_WRITE/);
  assert.equal(writes,0);
});
test('collapsing layout, removing sources or changing siblings is detected',()=>{
  const before=fixture();let after=structuredClone(before);after.state.layout='s';assert.throws(()=>verifyPreserved(before,after),/LAYOUT_CHANGE/);
  after=structuredClone(before);after.state.charts[0].panes[0].sources.pop();assert.throws(()=>verifyPreserved(before,after),/SOURCE_REMOVED/);
  after=structuredClone(before);after.state.charts[1].panes[0].sources[0].state.symbol='NQ';assert.throws(()=>verifyPreserved(before,after),/UNRELATED_SECTION/);
});
test('checked tools without a shared connection and unreviewed tools cannot call original handlers',async()=>{
  const handlers=new Map();const server={tool:(n,d,s,h)=>handlers.set(n,h)};let calls=0,connects=0;
  protectRegistrations(server,{z:{string:()=>({})},connect:async()=>{connects++;assert.fail('connected');}});
  // Tools that may change a chart cannot run when the layout in the tab cannot be checked.
  for(const n of ['ui_evaluate','ui_click','draw_clear','pane_set_layout','pine_compile']){
    server.tool(n,'',{},async()=>calls++);
    const r=await handlers.get(n)({expression:'1'});
    assert.equal(r.isError,true);assert.match(r.content[0].text,/ACTIVE_CONNECTION_UNAVAILABLE/);
  }
  // A tool nobody has reviewed stays disabled.
  server.tool('new_future_writer','',{},async()=>calls++);
  const r=await handlers.get('new_future_writer')({});
  assert.equal(r.isError,true);assert.match(r.content[0].text,/UNSAFE_OPERATION_DISABLED/);
  assert.equal(calls,0);assert.equal(connects,0);
});
test('protected name patterns match case-insensitively with any separator',()=>{
  for(const name of ['Do Not Touch','DO_NOT_TOUCH','do-not-touch','Do.Not.Touch','DoNotTouch','do  not  touch']){
    const s=fixture();s.name=name;
    assert.throws(()=>validate(s,{layout_id:s.uid},{protection}),/PROTECTED_CHART_NEEDS_PERMISSION/,name);
  }
});
test('read-only tools retain original handlers',async()=>{
  const handlers=new Map();const server={tool:(n,d,s,h)=>handlers.set(n,h)};
  protectRegistrations(server,{z:{string:()=>({})},connect:async()=>assert.fail()});
  server.tool('chart_get_state','',{},async()=>({read:true}));
  assert.deepEqual(await handlers.get('chart_get_state')({}),{read:true});
});
