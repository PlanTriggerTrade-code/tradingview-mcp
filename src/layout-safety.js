import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile, readFile, unlink, rmdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// The rule: automation may read any chart, but may change one of the user's real charts only
// after the user said yes in chat (the caller passes user_approved: true). Every layout is a real
// chart unless this server created it as a scratch chart (recorded automatically in
// state/scratch-layouts.json at the repository root); scratch charts can be changed freely.
// Layouts the user lists in state/protected-layouts.json (by ID or name pattern) stay real even if
// the scratch registry lists them. Every write first proves which layout it is on (URL, loaded
// save destination and requested ID must agree, checked again inside the same evaluation), so a
// write cannot land on a different layout than the URL shows.
// Tools that change nothing in TradingView: not the chart, layout, drawings, alerts, watchlist,
// panes, tabs, Pine editor or saved scripts. Everything else is a write. The full table with
// reasons is in docs/LAYOUT_SAFETY.md; tests/layout-safety-classification.test.js keeps both in step.
export const READ_TOOLS = new Set([
  'chart_get_state', 'chart_get_visible_range', 'symbol_info', 'symbol_search',
  'quote_get', 'data_get_ohlcv', 'data_get_indicator', 'data_get_study_values',
  'data_get_pine_lines', 'data_get_pine_labels', 'data_get_pine_boxes', 'data_get_pine_tables',
  'data_get_strategy_results', 'data_get_trades', 'data_get_equity', 'depth_get',
  'draw_list', 'draw_get_properties', 'alert_list', 'pine_check',
  'pine_list_scripts', 'pine_analyze', 'replay_status',
  'layout_list', 'pane_list', 'tab_list', 'tv_health_check', 'tv_discover', 'tv_ui_state',
  'ui_find_element', 'capture_screenshot', 'watchlist_get', 'session_get',
]);
// Targeted writes: real charts need user_approved, scratch charts do not.
export const WRITE_TOOLS = new Set(['chart_set_symbol', 'chart_set_timeframe',
  'indicator_set_inputs', 'indicator_toggle_visibility', 'chart_manage_indicator', 'ui_evaluate']);
// Tools the guard registers itself (here and in pine-development.js). All are target-bound.
export const GUARD_TOOLS = Object.freeze({
  layout_safety_inspect: 'read', study_inputs_get: 'read', strategy_trades_get: 'read',
  pine_development_verify: 'read',
  scratch_layout_create: 'write', pine_development_open: 'write', pine_development_inspect: 'write',
  pine_development_load: 'write', pine_development_update: 'write',
});
/** 'read', 'write' (target-bound and guarded) or 'disabled'. */
export function classify(name) {
  if (Object.hasOwn(GUARD_TOOLS, name)) return GUARD_TOOLS[name];
  if (READ_TOOLS.has(name)) return 'read';
  if (WRITE_TOOLS.has(name)) return 'write';
  return 'disabled';
}
export const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
// Working files (scratch-layouts.json, backups/, locks/) live in the repository's state/ folder,
// found from this module's location so the process working directory does not matter.
export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', 'state');

const SCRATCH = root => join(root, 'scratch-layouts.json');
export async function scratchLayouts(root = ROOT) {
  try { return new Set((JSON.parse(await readFile(SCRATCH(root), 'utf8')).layouts || []).map(l => l.id)); }
  catch (e) { if (e.code === 'ENOENT') return new Set(); throw e; }
}
export async function recordScratch(root, id, name) {
  if (!/^[A-Za-z0-9_-]+$/.test(id || '')) throw new Error('Invalid layout ID');
  let data = { layouts: [] };
  try { data = JSON.parse(await readFile(SCRATCH(root), 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  if (!data.layouts.some(l => l.id === id)) data.layouts.push({ id, name, createdAt: new Date().toISOString() });
  await mkdir(root, { recursive: true });
  await writeFile(SCRATCH(root), JSON.stringify(data, null, 1));
}
// The user's own list of layouts that must never count as scratch charts: local, ignored by Git.
// Format (see protected-layouts.example.json):
//   { "layouts": [{ "id": "<layout id>", "name": "<label>" }], "names": ["<regex>", ...] }
// Name patterns are case-insensitive regular expressions matched against the layout name.
// Read again on every operation, so edits apply without a restart. A missing file adds nothing
// (every layout is still real by default); an invalid one throws PROTECTED_LAYOUTS_INVALID, and
// every write refuses until it is fixed.
export const PROTECTION_FILE = 'protected-layouts.json';
export const EMPTY_PROTECTION = Object.freeze({ ids: new Set(), patterns: [], layouts: [] });
export async function loadProtection(root = ROOT) {
  const path = join(root, PROTECTION_FILE);
  const invalid = why => new Error(`PROTECTED_LAYOUTS_INVALID: ${path}: ${why}. No write performed; fix or remove the file.`);
  let text;
  try { text = await readFile(path, 'utf8'); }
  catch (e) { if (e.code === 'ENOENT') return EMPTY_PROTECTION; throw invalid(e.message); }
  let data;
  try { data = JSON.parse(text.replace(/^\uFEFF/, '')); } catch (e) { throw invalid(`not valid JSON (${e.message})`); }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw invalid('expected an object');
  const unknown = Object.keys(data).filter(k => k !== 'layouts' && k !== 'names');
  if (unknown.length) throw invalid(`unknown key(s) ${unknown.join(', ')}; only "layouts" and "names" are allowed`);
  const layouts = data.layouts ?? [], names = data.names ?? [];
  if (!Array.isArray(layouts) || !Array.isArray(names)) throw invalid('"layouts" and "names" must be arrays');
  for (const l of layouts) {
    if (!l || typeof l !== 'object' || typeof l.id !== 'string' || !/^[A-Za-z0-9_-]+$/.test(l.id))
      throw invalid(`every layout needs an "id" of letters, digits, _ or - (got ${JSON.stringify(l)})`);
    if (l.name !== undefined && typeof l.name !== 'string') throw invalid(`layout ${l.id}: "name" must be text`);
  }
  const patterns = names.map(n => {
    if (typeof n !== 'string' || !n.length) throw invalid(`name patterns must be non-empty text (got ${JSON.stringify(n)})`);
    try { return new RegExp(n, 'i'); } catch (e) { throw invalid(`bad name pattern ${JSON.stringify(n)} (${e.message})`); }
  });
  return { ids: new Set(layouts.map(l => l.id)), patterns, layouts: layouts.map(l => ({ id: l.id, name: l.name })) };
}
export const isProtected = (uid, name, protection) =>
  protection.ids.has(uid) || protection.patterns.some(p => p.test(name || ''));
export const isRealChart = (uid, name, scratch, protection = EMPTY_PROTECTION) =>
  isProtected(uid, name, protection) || !scratch.has(uid);

// This expression only reads state. Includes hidden chart sections, not just activeChart().
export const SNAPSHOT = `(() => {
 const a=window.TradingViewApi, m=a?._chartWidgetCollection?.metaInfo;
 const state=a.chartWidgetCollectionState({withData:false});
 return {url:location.href, uid:m.uid.value(), name:m.name.value(),
   chartId:String(a._activeChartWidgetWV.value()._chartWidget.id()), state};
})()`;

// For writable checks pass the loaded protection list; without it the check refuses.
export function validate(s, expected, { writable = true, protection } = {}) {
  const url = new URL(s.url);
  const urlId = url.pathname.match(/^\/chart\/([^/]+)\/?$/)?.[1];
  if (url.hostname !== 'www.tradingview.com' || !s.uid || urlId !== s.uid || s.uid !== expected.layout_id)
    throw new Error('LAYOUT_IDENTITY_MISMATCH: URL, loaded save destination and requested layout must match. No write performed.');
  if (!Array.isArray(s.state?.charts) || !s.state.charts.length ||
      s.state.charts.some(c => !c.chartId || !Array.isArray(c.panes)))
    throw new Error('INCOMPLETE_LAYOUT: cannot back up all chart sections.');
  if (writable && !protection) throw new Error('PROTECTION_NOT_LOADED: no write performed.');
  if (writable && isProtected(s.uid, s.name, protection))
    throw new Error('PROTECTED_MANUAL_LAYOUT: automation writes are disabled for this layout.');
  if (expected.chart_id && s.chartId !== expected.chart_id)
    throw new Error('ACTIVE_SECTION_CHANGED: inspect the intended section again.');
  if (expected.state_hash && hash(s.state) !== expected.state_hash)
    throw new Error('LAYOUT_CHANGED: state differs from the inspected version; no write performed.');
}

export async function withLock(root, id, work) {
  if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error('Invalid layout ID');
  const dir = join(root, 'locks', id);
  await mkdir(join(root, 'locks'), { recursive: true });
  try { await mkdir(dir); } catch (e) {
    if (e.code === 'EEXIST') throw new Error('LAYOUT_BUSY: another operation owns this layout. Never auto-steal stale locks.');
    throw e;
  }
  try {
    await writeFile(join(dir, 'owner.json'), JSON.stringify({ pid:process.pid, startedAt:new Date().toISOString() }), {flag:'wx'});
    return await work();
  } finally {
    await unlink(join(dir, 'owner.json')).catch(e => { if(e.code !== 'ENOENT') throw e; });
    await rmdir(dir);
  }
}

export async function backup(root, snapshot, tool) {
  const dir = join(root, 'backups', snapshot.uid);
  await mkdir(dir, {recursive:true});
  const path = join(dir, `${Date.now()}-${randomUUID()}.json`);
  const data = {version:1, tool, capturedAt:new Date().toISOString(), snapshot,
    coverage:'Full chart collection and embedded sources. Separately stored server drawings are not guaranteed; this is not a complete disaster-recovery backup.'};
  await writeFile(path, JSON.stringify(data), {flag:'wx'});
  if (hash(JSON.parse(await readFile(path,'utf8'))) !== hash(data)) throw new Error('BACKUP_VERIFICATION_FAILED');
  return path;
}

export function mutation(tool, args) {
  const q = JSON.stringify;
  if (tool === 'ui_evaluate') {
    if (typeof args.expression !== 'string' || !args.expression.trim()) throw new Error('Expression required');
    return `return await (${args.expression});`;
  }
  if (tool === 'chart_set_symbol') return `c.setSymbol(${q(args.symbol)}, {});`;
  if (tool === 'chart_set_timeframe') return `c.setResolution(${q(args.timeframe)}, {});`;
  if (tool === 'indicator_toggle_visibility') return `c.getStudyById(${q(args.entity_id)}).setVisible(${q(args.visible)});`;
  if (tool === 'indicator_set_inputs') {
    const inputs = typeof args.inputs === 'string' ? JSON.parse(args.inputs) : args.inputs;
    if (!inputs || typeof inputs !== 'object' || Array.isArray(inputs) || !Object.keys(inputs).length) throw new Error('Nonempty inputs object required');
    return `const study=c.getStudyById(${q(args.entity_id)}), inputs=${q(inputs)}, values=study.getInputValues();
      if(Object.keys(inputs).some(k=>!values.some(v=>v.id===k))) throw Error('Unknown input ID');
      study.setInputValues(values.map(v=>Object.hasOwn(inputs,v.id)?{...v,value:inputs[v.id]}:v));`;
  }
  if (tool === 'chart_manage_indicator' && args.action === 'add') {
    const inputs = typeof args.inputs === 'string' ? JSON.parse(args.inputs) : (args.inputs || {});
    return `await c.createStudy(${q(args.indicator)}, false, false, ${q(Object.entries(inputs).map(([id,value])=>({id,value})))});`;
  }
  if (tool === 'chart_manage_indicator' && args.action === 'remove') {
    if (!args.entity_id) throw new Error('entity_id required to remove a study');
    return `c.removeEntity(${q(args.entity_id)});`;
  }
  throw new Error('UNSUPPORTED_OPERATION');
}

// Re-check identity in the same evaluation as the change: the URL can show one layout while
// another is loaded, and a write must never land on a layout other than the requested one.
export function identityExpression(snapshot, code) {
  return `(async()=>{const a=window.TradingViewApi, m=a?._chartWidgetCollection?.metaInfo;
    if(location.href!==${JSON.stringify(snapshot.url)} || m?.uid?.value()!==${JSON.stringify(snapshot.uid)})
      throw Error('LAYOUT_CHANGED_BEFORE_WRITE');
    const c=a._activeChartWidgetWV.value(); ${code}
    return true;
  })()`;
}

export function guardedExpression(snapshot, code) {
  return `(async()=>{const s=${SNAPSHOT};
    if(s.uid!==${JSON.stringify(snapshot.uid)} || s.url!==${JSON.stringify(snapshot.url)} ||
       s.chartId!==${JSON.stringify(snapshot.chartId)} || JSON.stringify(s.state)!==${JSON.stringify(JSON.stringify(snapshot.state))})
      throw Error('LAYOUT_CHANGED_BEFORE_WRITE');
    const c=window.TradingViewApi._activeChartWidgetWV.value(); ${code}
    return true;
  })()`;
}

export function verifyPreserved(before, after) {
  if (before.uid !== after.uid || before.state.name !== after.state.name || before.state.layout !== after.state.layout)
    throw new Error('UNEXPECTED_LAYOUT_CHANGE: stop; retain backups; do not save or automatically roll back.');
  const oldCharts=before.state.charts, newCharts=after.state.charts;
  if (oldCharts.length!==newCharts.length) throw new Error('UNEXPECTED_SECTION_COUNT');
  for (const old of oldCharts) {
    const current=newCharts.find(c=>c.chartId===old.chartId);
    if (!current) throw new Error('MISSING_SECTION');
    if (String(old.chartId)!==before.chartId && hash(old)!==hash(current)) throw new Error('UNRELATED_SECTION_CHANGED');
    const ids = c => c.panes.flatMap(p=>(p.sources || []).map(s=>s.id));
    if(ids(old).some(id=>!ids(current).includes(id))) throw new Error('EXISTING_SOURCE_REMOVED');
  }
}

export function checkIdentity(s, layout_id) {
  const url = new URL(s.url);
  const urlId = url.pathname.match(/^\/chart\/([^/]+)\/?$/)?.[1];
  if (url.hostname !== 'www.tradingview.com' || !s.uid || urlId !== s.uid || s.uid !== layout_id)
    throw new Error('LAYOUT_IDENTITY_MISMATCH: URL, loaded save destination and requested layout must match. No write performed.');
}

// One write: prove the layout, require permission on a real chart, apply, prove it again.
export async function guardedWrite({target_id, layout_id, user_approved, tool, args}, deps) {
  if (![target_id,layout_id].every(x=>typeof x==='string' && x.length)) throw new Error('Explicit target_id and layout_id required (tab_list / layout_safety_inspect)');
  // Arbitrary JavaScript can reach any layout, alert or saved script from a scratch chart
  // (loadChartFromServer, saveChartToServer, fetch...), so the identity check cannot contain it:
  // ui_evaluate always needs the user's yes, on every chart. Refused before connecting.
  if (tool === 'ui_evaluate' && user_approved !== true)
    throw new Error('UI_EVALUATE_NEEDS_PERMISSION: ui_evaluate runs arbitrary JavaScript and always needs the user\'s yes (user_approved: true), also on scratch charts.');
  const code = mutation(tool, args);
  const root = deps.root || ROOT;
  const protection = await loadProtection(root);
  const client = await deps.connect(target_id);
  const run = async expression => {
    const r=await client.Runtime.evaluate({expression, returnByValue:true, awaitPromise:true});
    if(r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };
  try {
    const before=await run(SNAPSHOT);
    checkIdentity(before, layout_id);
    const real = isRealChart(before.uid, before.name, await scratchLayouts(root), protection);
    if (real && user_approved !== true)
      throw new Error(`REAL_CHART_NEEDS_PERMISSION: "${before.name}" (${before.uid}) is one of the user's charts. Ask the user; pass user_approved: true only after they said yes for this chart.`);
    const value=await run(identityExpression(before,code));
    const after=await run(SNAPSHOT);
    checkIdentity(after, layout_id);
    return {success:true, layout_id:after.uid, layout_name:after.name, real_chart:real,
      ...(tool==='ui_evaluate' ? {result:value} : {}), chart_id:after.chartId, saved:false};
  } finally { await client.close(); }
}

// A new scratch chart in the given tab. The layout that was showing stays saved as it is, but it
// leaves the tab: on one of the user's real charts that needs the user's yes.
export const NEW_LAYOUT = `(async()=>{const a=window.TradingViewApi;await a.createNewLayout();return true;})()`;
// A freshly created layout: one chart section whose panes hold only the main series.
export function isEmptyLayout(state) {
  if (!Array.isArray(state?.charts) || state.charts.length !== 1) return false;
  const sources = (state.charts[0].panes || []).flatMap(p => p.sources || []);
  return sources.length === 1 && sources[0]?.type === 'MainSeries';
}
export async function createScratch({target_id, layout_id, name, user_approved}, deps) {
  const root = deps.root || ROOT;
  const protection = await loadProtection(root);
  const client = await deps.connect(target_id);
  const run = async expression => {
    const r=await client.Runtime.evaluate({expression, returnByValue:true, awaitPromise:true});
    if(r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };
  try {
    const before=await run(SNAPSHOT);
    checkIdentity(before, layout_id);
    if (isRealChart(before.uid, before.name, await scratchLayouts(root), protection) && user_approved !== true)
      throw new Error(`REAL_CHART_NEEDS_PERMISSION: "${before.name}" (${before.uid}) is one of the user's charts and would leave this tab. Use a tab showing a scratch chart, or pass user_approved: true after the user said yes.`);
    await run(NEW_LAYOUT);
    let after;
    for (let i=0; i<40; i++) {
      await (deps.delay || (ms=>new Promise(r=>setTimeout(r,ms))))(500);
      try { after=await run(SNAPSHOT); } catch { continue; }
      if (after.uid && after.uid !== before.uid) break;
    }
    if (!after || !after.uid || after.uid === before.uid) throw new Error('NEW_LAYOUT_NOT_CONFIRMED: no new saved layout loaded; nothing recorded, nothing written.');
    checkIdentity(after, after.uid);
    // Record only what is provably the new empty layout: never a protected layout (by ID or name),
    // never one that already has studies, drawings or several sections.
    if (isProtected(after.uid, after.name, protection) || !isEmptyLayout(after.state))
      throw new Error(`SCRATCH_NOT_CONFIRMED: the layout now in the tab ("${after.name}", ${after.uid}) is not a new empty layout; nothing recorded.`);
    await recordScratch(root, after.uid, name || after.name);
    return {success:true, target_id, layout_id:after.uid, name:after.name, previous_layout:before.uid,
      note:'Recorded as a scratch chart: writes there need no permission (ui_evaluate always does). The previous chart was not changed.'};
  } finally { await client.close(); }
}

// Read-only inspection on an explicit tab and layout. Never writes; protected layouts included.
export const STUDY_INPUTS = id => `(()=>{const c=window.TradingViewApi.activeChart();
  const st=c.getStudyById(${JSON.stringify(id)});const vals=st.getInputValues();const by={};
  for(const v of vals)by[v.id]=v.value;
  return {name:(c.getAllStudies().find(s=>s.id===${JSON.stringify(id)})||{}).name,visible:st.isVisible(),
    inputs:st.getInputsInfo().map(i=>({id:i.id,name:i.name,value:(typeof by[i.id]==='string'&&by[i.id].length>200)?'<long text>':by[i.id]}))};
})()`;
export const STRATEGY_TRADES = id => `(()=>{const a=window.TradingViewApi,w=a._activeChartWidgetWV.value();
  const model=(w._chartWidget?w._chartWidget.model():w.model()).model();
  const ds=model.dataSources().find(s=>s.id&&s.id()===${JSON.stringify(id)});
  if(!ds)throw Error('STUDY_NOT_FOUND');let rep=ds.reportData&&ds.reportData();if(rep&&rep.value)rep=rep.value();
  if(!rep)throw Error('REPORT_NOT_AVAILABLE: the strategy is hidden or still calculating');
  return {currency:rep.currency,trades:rep.trades.map(t=>({entry:{comment:t.e.c,time:t.e.tm,bar:t.e.b,price:t.e.p},
    quantity:t.q,exit:{comment:t.x.c,time:t.x.tm,bar:t.x.b,price:t.x.p},profit:t.tp&&t.tp.v}))};
})()`;

export const DISABLED_MARK = ' [Disabled: no target-bound implementation]';
// Read tools with an argument that would change something outside the chart.
export const READ_ARGUMENT_GUARDS = Object.freeze({
  // takeScreenshot() publishes a snapshot to TradingView's servers.
  capture_screenshot: args => (args?.method === 'api'
    ? 'SNAPSHOT_PUBLISH_DISABLED: method "api" publishes a snapshot to TradingView\'s servers; use the default CDP capture.' : null),
});
const READ_ARGUMENT_NOTES = Object.freeze({ capture_screenshot: ' [method "api" is disabled by the layout guard]' });
export const UI_EVALUATE_NOTE = ' Always needs user_approved: true (the user\'s yes), also on scratch charts: arbitrary JavaScript can reach any layout.';
export const WRITE_NOTE = ' Pass target_id and layout_id (tab_list). On one of the user\'s real charts also user_approved: true, only after the user said yes for that chart; charts made with scratch_layout_create need no approval.';

// Default-deny registration: tools without a target-bound implementation cannot write.
// Install before any tool group registers, so a new or unreviewed tool is disabled by default.
// `bool` builds the user_approved schema (server.js passes the repository's booleanParam).
export function protectRegistrations(server, {z, connect, root=ROOT, bool}) {
  const register=server.tool.bind(server);
  let queue=Promise.resolve();
  const serial = fn => { const result=queue.then(fn); queue=result.catch(()=>{}); return result; };
  const result=value=>({content:[{type:'text',text:JSON.stringify(value)}]});
  const error=e=>({...result({success:false,error:e.message}),isError:true});
  const optional = t => (t && typeof t.optional === 'function') ? t.optional() : t;
  const approval = () => (typeof bool === 'function' ? bool() : typeof z.boolean === 'function' ? z.boolean() : z.string());
  server.tool=(...registration)=>{
    const [name,description,schema,handler]=registration;
    // Only the plain (name, description, shape, handler) form is understood; anything else could
    // carry a handler or schema past the checks below, so it fails at startup instead.
    if (registration.length!==4 || typeof name!=='string' || typeof description!=='string' ||
        !schema || typeof schema!=='object' || typeof handler!=='function')
      throw new Error(`UNSUPPORTED_REGISTRATION: ${String(name)} must be registered as (name, description, shape, handler).`);
    if (Object.hasOwn(GUARD_TOOLS, name)) throw new Error(`RESERVED_TOOL_NAME: ${name} belongs to the layout guard.`);
    if(READ_TOOLS.has(name)) {
      const check=READ_ARGUMENT_GUARDS[name];
      return register(name,description+(READ_ARGUMENT_NOTES[name]||''),schema,(...args)=>serial(()=>{
        const refusal=check?.(args[0]);
        return refusal ? error(new Error(refusal)) : handler(...args);
      }));
    }
    if(WRITE_TOOLS.has(name)) return register(name,description+WRITE_NOTE+(name==='ui_evaluate'?UI_EVALUATE_NOTE:''),
      {...schema,target_id:z.string(),layout_id:z.string(),user_approved:optional(approval())},
      args=>serial(async()=>{try{return result(await guardedWrite({...args,tool:name,args},{connect,root}));}catch(e){return error(e);}}));
    return register(name,description+DISABLED_MARK,schema,
      async()=>error(new Error('UNSAFE_OPERATION_DISABLED: this tool cannot prove which layout it acts on. Use the target-bound tools instead.')));
  };
  // registerTool() would bypass the wrapper above; nothing in this repository uses it.
  server.registerTool=name=>{ throw new Error(`UNSUPPORTED_REGISTRATION: ${String(name)} must use server.tool so the layout guard can classify it.`); };
  const inspectRead = (expression) => async args => serial(async()=>{
    let client;
    try {
      client=await connect(args.target_id);
      const run=async e=>{const r=await client.Runtime.evaluate({expression:e,returnByValue:true,awaitPromise:true});
        if(r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);return r.result.value;};
      const s=await run(SNAPSHOT);
      checkIdentity(s,args.layout_id);
      return result({layout_id:s.uid,name:s.name,...(await run(expression(args)))});
    }catch(e){return error(e);}finally{if(client) await client.close();}
  });
  register('layout_safety_inspect','Read the actual layout on an explicit tab (target_id from tab_list): its ID, name, sections and whether it is one of the user\'s real charts. Does not change charts.',
    {target_id:z.string(),layout_id:z.string()}, args=>serial(async()=>{
      let client;
      try {
        client=await connect(args.target_id);
        const r=await client.Runtime.evaluate({expression:SNAPSHOT,returnByValue:true});
        if(r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
        const s=r.result.value;
        checkIdentity(s,args.layout_id);
        let protection, protection_error;
        try { protection=await loadProtection(root); } catch(e) { protection_error=e.message; }
        return result({target_id:args.target_id,layout_id:s.uid,chart_id:s.chartId,name:s.name,
          real_chart:protection ? isRealChart(s.uid,s.name,await scratchLayouts(root),protection) : true,
          ...(protection ? {protected:isProtected(s.uid,s.name,protection)} : {protection_error}),state_hash:hash(s.state),
          sections:s.state.charts.map(c=>({chart_id:c.chartId,panes:c.panes.length}))});
      }catch(e){return error(e);}finally{if(client) await client.close();}
    }));
  register('study_inputs_get','Read every input (id, title, value) of a study on an explicit tab and layout. Read-only; any chart.',
    {target_id:z.string(),layout_id:z.string(),entity_id:z.string()}, inspectRead(a=>STUDY_INPUTS(a.entity_id)));
  register('strategy_trades_get','Read a strategy study\'s closed trades (entry/exit time, bar, price, quantity) on an explicit tab and layout. Read-only; any chart.',
    {target_id:z.string(),layout_id:z.string(),entity_id:z.string()}, inspectRead(a=>STRATEGY_TRADES(a.entity_id)));
  register('scratch_layout_create','Create a new empty chart layout in the given tab and record it as a scratch chart (changes there need no permission). The chart that was showing in the tab is not changed, but it leaves the tab: if it is one of the user\'s real charts, pass user_approved: true only after the user said yes.',
    {target_id:z.string(),layout_id:z.string(),name:optional(z.string()),user_approved:optional(approval())},
    args=>serial(async()=>{try{return result(await createScratch(args,{connect,root}));}catch(e){return error(e);}}));
}
