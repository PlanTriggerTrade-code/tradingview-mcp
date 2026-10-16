import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile, readFile, unlink, rmdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// The rule: automation never changes one of the user's protected charts without their yes.
// A chart is protected when the layout actually loaded in the tab (its loaded layout ID, not the
// URL) is listed in state/protected-layouts.json, by ID or by a name pattern. A tool that may
// change the chart in a tab is refused there unless the caller passes user_approved: true, which
// it may only do after the user said yes for that chart. Every other chart is free.

// Tools that change nothing in TradingView.
export const READ_TOOLS = new Set([
  'chart_get_state', 'chart_get_visible_range', 'symbol_info', 'symbol_search',
  'quote_get', 'data_get_ohlcv', 'data_export_ohlcv', 'data_get_indicator', 'data_get_study_values',
  'data_get_pine_lines', 'data_get_pine_labels', 'data_get_pine_boxes', 'data_get_pine_tables',
  'data_get_strategy_results', 'data_get_trades', 'data_get_equity', 'depth_get',
  'draw_list', 'draw_get_properties', 'alert_list', 'pine_check',
  'pine_list_scripts', 'pine_analyze', 'replay_status',
  'layout_list', 'pane_list', 'tab_list', 'tv_health_check', 'tv_discover', 'tv_ui_state',
  'ui_find_element', 'capture_screenshot', 'watchlist_get', 'session_get',
  'pine_get_source', 'pine_get_errors', 'pine_get_console', 'pine_editor_state', 'indicator_search',
]);
// Tools that change account or app state (alerts, watchlist, tabs, new layouts, the app window,
// the Pine editor's buffer or binding, local files) but not a chart. They run freely.
export const ACCOUNT_TOOLS = new Set([
  'alert_create', 'alert_delete', 'watchlist_add', 'watchlist_add_bulk', 'watchlist_remove',
  'tv_launch', 'tab_new', 'tab_close', 'tab_switch', 'layout_new', 'session_save', 'ui_fullscreen',
  'pine_set_source', 'pine_open', 'ui_hover', 'ui_open_panel',
]);
// Tools that may change the chart in the active tab. Checked: refused on a protected chart
// without user_approved.
export const CHART_TOOLS = new Set([
  'chart_set_symbol', 'chart_set_timeframe', 'chart_set_type', 'chart_set_visible_range', 'chart_scroll_to_date',
  'chart_manage_indicator', 'indicator_set_inputs', 'indicator_toggle_visibility', 'indicator_add',
  'draw_shape', 'draw_clear', 'draw_remove_one', 'morning_brief', 'batch_run',
  'pane_set_layout', 'pane_focus', 'pane_set_symbol',
  'pine_new', 'pine_compile', 'pine_save', 'pine_smart_compile',
  'replay_start', 'replay_step', 'replay_autoplay', 'replay_stop', 'replay_trade',
  'layout_switch', 'ui_evaluate', 'ui_click', 'ui_keyboard', 'ui_type_text', 'ui_mouse_click', 'ui_scroll',
]);
// Chart tools that can save the Pine script bound to the editor. Saving updates the script on
// every layout that uses it, so they also check the other open tabs.
export const PINE_SAVE_TOOLS = new Set(['pine_save', 'pine_compile', 'pine_smart_compile']);
// Tools the guard registers itself (here and in pine-development.js). They take target_id.
export const GUARD_TOOLS = Object.freeze({
  layout_safety_inspect: 'read', study_inputs_get: 'read', strategy_trades_get: 'read',
  pine_development_verify: 'read',
  pine_development_open: 'checked', pine_development_inspect: 'checked',
  pine_development_load: 'checked', pine_development_update: 'checked',
});
/** 'read' or 'account' (free), 'checked' (may change a chart) or 'disabled' (not reviewed). */
export function classify(name) {
  if (Object.hasOwn(GUARD_TOOLS, name)) return GUARD_TOOLS[name];
  if (READ_TOOLS.has(name)) return 'read';
  if (ACCOUNT_TOOLS.has(name)) return 'account';
  if (CHART_TOOLS.has(name)) return 'checked';
  return 'disabled'; // a tool nobody has reviewed yet
}
export const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
// Working files (protected-layouts.json, backups/, locks/) live in the repository's state/ folder,
// found from this module's location so the process working directory does not matter.
export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', 'state');

// The user's list of protected charts: local, ignored by Git. Format (see
// protected-layouts.example.json):
//   { "layouts": [{ "id": "<layout id>", "name": "<label>" }], "names": ["<regex>", ...] }
// Name patterns are case-insensitive regular expressions matched against the layout name.
// Read again on every check, so edits apply without a restart. A missing file protects nothing;
// an invalid one throws PROTECTED_LAYOUTS_INVALID, and every change refuses until it is fixed.
export const PROTECTION_FILE = 'protected-layouts.json';
export const EMPTY_PROTECTION = Object.freeze({ ids: new Set(), patterns: [], layouts: [] });
export async function loadProtection(root = ROOT) {
  const path = join(root, PROTECTION_FILE);
  const invalid = why => new Error(`PROTECTED_LAYOUTS_INVALID: ${path}: ${why}. Nothing was changed; fix or remove the file.`);
  let text;
  try { text = await readFile(path, 'utf8'); }
  catch (e) { if (e.code === 'ENOENT') return EMPTY_PROTECTION; throw invalid(e.message); }
  let data;
  try { data = JSON.parse(text.replace(/^﻿/, '')); } catch (e) { throw invalid(`not valid JSON (${e.message})`); }
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
const needsPermission = s => new Error(`PROTECTED_CHART_NEEDS_PERMISSION: "${s.name}" (${s.uid}) is a protected chart. Ask the user; pass user_approved: true only after they said yes for this chart.`);

// This expression only reads state. Includes hidden chart sections, not just activeChart().
export const SNAPSHOT = `(() => {
 const a=window.TradingViewApi, m=a?._chartWidgetCollection?.metaInfo;
 const state=a.chartWidgetCollectionState({withData:false});
 return {url:location.href, uid:m.uid.value(), name:m.name.value(),
   chartId:String(a._activeChartWidgetWV.value()._chartWidget.id()), state};
})()`;

// Checks for the Pine development tools, which work on an explicit tab and layout. For writable
// checks pass the loaded protection list (without it the check refuses) and whether the user
// approved.
export function validate(s, expected, { writable = true, protection, approved = false } = {}) {
  const url = new URL(s.url);
  const urlId = url.pathname.match(/^\/chart\/([^/]+)\/?$/)?.[1];
  if (url.hostname !== 'www.tradingview.com' || !s.uid || urlId !== s.uid || s.uid !== expected.layout_id)
    throw new Error('LAYOUT_IDENTITY_MISMATCH: URL, loaded save destination and requested layout must match. No write performed.');
  if (!Array.isArray(s.state?.charts) || !s.state.charts.length ||
      s.state.charts.some(c => !c.chartId || !Array.isArray(c.panes)))
    throw new Error('INCOMPLETE_LAYOUT: cannot back up all chart sections.');
  if (writable && !protection) throw new Error('PROTECTION_NOT_LOADED: no write performed.');
  if (writable && approved !== true && isProtected(s.uid, s.name, protection)) throw needsPermission(s);
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

// Re-checks the whole layout state inside the same evaluation as the change.
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

// Read-only inspection on an explicit tab. Never writes; protected layouts included.
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

export const DISABLED_MARK = ' [Disabled: not reviewed by the layout guard]';
export const CHECKED_NOTE = ' Refused on a protected chart (state/protected-layouts.json) unless user_approved: true, which may only be passed after the user said yes for that chart. Optional layout_id must match the layout loaded in the tab.';

// Saving a script makes TradingView update its instances on every layout it has open.
// A study uses the script when its state carries the script ID as pineId / scriptIdPart.
export function usesScript(value, scriptId) {
  if (!value || typeof value !== 'object') return false;
  for (const [k, v] of Object.entries(value)) {
    if ((k === 'pineId' || k === 'scriptIdPart') && v === scriptId) return true;
    if (v && typeof v === 'object' && usesScript(v, scriptId)) return true;
  }
  return false;
}
/**
 * Reads every open chart tab (read-only SNAPSHOT) and returns the protected charts that use the
 * script (`found`) and the tabs that could not be read (`unreadable`). Layouts that are not open in
 * TradingView cannot be checked.
 */
export async function protectedChartsUsingScript(scriptId, { connect, listTargets, root = ROOT, exclude = null }) {
  if (typeof listTargets !== 'function') return { found: [], unreadable: ['the open tabs could not be listed'] };
  const protection = await loadProtection(root);
  const tabs = (await listTargets()).filter(t => (t.type === 'page' || t.type === 'webview') && /tradingview\.com\/chart/i.test(t.url || ''));
  const found = [], unreadable = [];
  for (const t of tabs) {
    let client;
    try {
      client = await connect(t.id);
      const r = await client.Runtime.evaluate({ expression: SNAPSHOT, returnByValue: true, awaitPromise: true });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
      const s = r.result.value;
      if (s.uid !== exclude && usesScript(s.state, scriptId) && isProtected(s.uid, s.name, protection)) found.push(`"${s.name}" (${s.uid})`);
    } catch { unreadable.push(t.url); }
    finally { if (client) await client.close().catch(() => {}); }
  }
  return { found, unreadable };
}
// The saved script(s) the Pine editor in this page is bound to, by its title. untitled: a new,
// never-saved script; title null: no visible editor; error / no ids: the lookup failed.
export const EDITOR_SCRIPT_IDS = `(async()=>{
  let title=null;
  for(const b of document.querySelectorAll('[class*="nameButton"]')){if(b.offsetParent!==null){title=(b.textContent||'').trim();break;}}
  if(!title)return {title:null,ids:[]};
  if(/^Untitled script/i.test(title))return {title,ids:[],untitled:true};
  try{const r=await fetch('https://pine-facade.tradingview.com/pine-facade/list/?filter=saved',{credentials:'include'});
    if(!r.ok)return {title,ids:[],error:'HTTP '+r.status};
    return {title,ids:(await r.json()).filter(s=>s.scriptName===title||s.scriptTitle===title).map(s=>s.scriptIdPart)};
  }catch(e){return {title,ids:[],error:String(e)};}
})()`;
// Light identity read used right before a checked tool runs.
export const IDENTITY = `(()=>{const m=window.TradingViewApi?._chartWidgetCollection?.metaInfo;return {url:location.href,uid:m?.uid?.value()};})()`;
export const UNCHECKABLE = 'Layouts not open in TradingView cannot be checked.';

/**
 * Which open protected charts would saving the editor's script update? `unchecked` says why the
 * answer may be incomplete (the script or some tabs could not be read); that never refuses.
 */
export async function pineSaveScan(current, { active, connect, listTargets, root = ROOT }) {
  let bound;
  try { bound = await active.evaluateAsync(EDITOR_SCRIPT_IDS); }
  catch (e) { return { found: [], unchecked: `the Pine editor could not be read (${e.message})` }; }
  if (bound?.untitled) return { found: [], unchecked: null };
  if (!bound?.title) return { found: [], unchecked: 'no Pine editor is visible, so the script could not be identified' };
  if (bound.error || !bound.ids?.length)
    return { found: [], unchecked: `the editor's script "${bound.title}" could not be matched to a saved script${bound.error ? ` (${bound.error})` : ''}` };
  const found = [], unreadable = [];
  for (const id of bound.ids) {
    const r = await protectedChartsUsingScript(id, { connect, listTargets, root, exclude: current.uid });
    found.push(...r.found); unreadable.push(...r.unreadable);
  }
  return { title: bound.title, found: [...new Set(found)],
    unchecked: unreadable.length ? `these tabs could not be read: ${[...new Set(unreadable)].join(', ')}` : null };
}

/**
 * Reads the layout loaded in the active tab (the shared connection the tool will use) and refuses
 * a protected one without approval. `active` = { follow, evaluate, evaluateAsync, targetId, pin,
 * unpin }. Returns the checked target for pinning.
 */
export async function chartGate(name, { layout_id, user_approved }, { active, connect, listTargets, root = ROOT }) {
  const approved = user_approved === true;
  if (!active || typeof active.pin !== 'function' || typeof active.unpin !== 'function')
    throw new Error('ACTIVE_CONNECTION_UNAVAILABLE: nothing was changed.');
  const protection = await loadProtection(root);
  await active.follow();
  let s;
  try { s = await active.evaluate(SNAPSHOT); } catch (e) { s = null; if (!approved) throw new Error(`CHART_NOT_READABLE: the layout in the active tab could not be read (${e.message}), so the guard cannot tell whether it is protected. Pass user_approved: true only after the user said yes.`); }
  const target = await active.targetId();
  if (!target) throw new Error('ACTIVE_CONNECTION_UNAVAILABLE: the active tab could not be identified; nothing was changed.');
  if (layout_id !== undefined && layout_id !== null && layout_id !== s?.uid)
    throw new Error(`LAYOUT_ID_MISMATCH: the active tab has layout ${s?.uid ?? 'unknown'} loaded, not ${layout_id}; nothing was changed.`);
  if (s && !approved && isProtected(s.uid, s.name, protection)) throw needsPermission(s);
  let pine = null;
  if (s && PINE_SAVE_TOOLS.has(name)) {
    pine = await pineSaveScan(s, { active, connect, listTargets, root });
    if (pine.found.length && !approved)
      throw new Error(`PINE_SCRIPT_ON_PROTECTED_CHARTS: ${name} can save "${pine.title}", which also updates it on the protected charts ${pine.found.join(', ')}. Ask the user; pass user_approved: true only after they said yes. ${UNCHECKABLE}`);
  }
  // The tool must act on the tab and layout just checked.
  if (s) {
    const now = await active.evaluate(IDENTITY);
    if (await active.targetId() !== target || now?.uid !== s.uid || now?.url !== s.url)
      throw new Error('ACTIVE_TAB_CHANGED: the active tab or its layout changed during the check; nothing was changed. Retry.');
  }
  return { target, layout_id: s?.uid, name: s?.name, pine };
}

// Default-deny registration: a tool nobody has classified is disabled.
// Install before any tool group registers. `bool` builds the user_approved schema (server.js passes
// the repository's booleanParam). `active` gives checked tools the shared active-tab connection;
// `connect` attaches to an explicit tab; `listTargets` lists open tabs.
export function protectRegistrations(server, {z, connect, root=ROOT, bool, active, listTargets}) {
  const register=server.tool.bind(server);
  let queue=Promise.resolve();
  const serial = fn => { const result=queue.then(fn); queue=result.catch(()=>{}); return result; };
  const result=value=>({content:[{type:'text',text:JSON.stringify(value)}]});
  const error=e=>({...result({success:false,error:e.message}),isError:true});
  const optional = t => (t && typeof t.optional === 'function') ? t.optional() : t;
  const approval = () => (typeof bool === 'function' ? bool() : typeof z.boolean === 'function' ? z.boolean() : z.string());
  const follow = async () => { try { await active?.follow(); } catch { /* the tool's own connect reports errors */ } };
  server.tool=(...registration)=>{
    const [name,description,schema,handler]=registration;
    // Only the plain (name, description, shape, handler) form is understood; anything else could
    // carry a handler or schema past the checks below, so it fails at startup instead.
    if (registration.length!==4 || typeof name!=='string' || typeof description!=='string' ||
        !schema || typeof schema!=='object' || typeof handler!=='function')
      throw new Error(`UNSUPPORTED_REGISTRATION: ${String(name)} must be registered as (name, description, shape, handler).`);
    if (Object.hasOwn(GUARD_TOOLS, name)) throw new Error(`RESERVED_TOOL_NAME: ${name} belongs to the layout guard.`);
    // Read and account tools follow the tab the user is looking at, then run as they are.
    if(READ_TOOLS.has(name) || ACCOUNT_TOOLS.has(name))
      return register(name,description,schema,(...args)=>serial(async()=>{await follow();return handler(...args);}));
    if(CHART_TOOLS.has(name)) {
      for (const key of ['layout_id','user_approved']) if (Object.hasOwn(schema,key)) throw new Error(`UNSUPPORTED_REGISTRATION: ${name} already has ${key}.`);
      return register(name,description+CHECKED_NOTE,{...schema,layout_id:optional(z.string()),user_approved:optional(approval())},
        (args,...rest)=>serial(async()=>{
          const {layout_id,user_approved,...toolArgs}=args||{};
          let gate;
          try { gate=await chartGate(name,{layout_id,user_approved},{active,connect,listTargets,root}); }
          catch(e){ return error(e); }
          // Pin the shared connection to the checked tab: a reconnect while the tool runs can then
          // only reach that tab, or fail.
          try {
            active.pin(gate.target);
            const res=await handler(toolArgs,...rest);
            const pine=gate.pine;
            if (!pine || (!pine.found.length && !pine.unchecked) || !Array.isArray(res?.content)) return res;
            return {...res,content:[...res.content,{type:'text',text:JSON.stringify({layout_guard:{
              also_updates_open_protected_charts:pine.found,...(pine.unchecked?{could_not_check:pine.unchecked}:{}),note:UNCHECKABLE}})}]};
          } finally { active.unpin(); }
        }));
    }
    return register(name,description+DISABLED_MARK,schema,
      async()=>error(new Error('UNSAFE_OPERATION_DISABLED: this tool has not been reviewed by the layout guard (src/layout-safety.js).')));
  };
  // registerTool() would bypass the wrapper above; nothing in this repository uses it.
  server.registerTool=name=>{ throw new Error(`UNSUPPORTED_REGISTRATION: ${String(name)} must use server.tool so the layout guard can classify it.`); };

  // Read-only tools on an explicit tab (target_id from tab_list). Optional layout_id must match the
  // layout loaded there.
  const onTab = (expression) => async args => serial(async()=>{
    let client;
    try {
      client=await connect(args.target_id);
      const run=async e=>{const r=await client.Runtime.evaluate({expression:e,returnByValue:true,awaitPromise:true});
        if(r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);return r.result.value;};
      const s=await run(SNAPSHOT);
      if (args.layout_id && args.layout_id!==s.uid) throw new Error(`LAYOUT_ID_MISMATCH: tab ${args.target_id} has layout ${s.uid} loaded, not ${args.layout_id}.`);
      return result({target_id:args.target_id,layout_id:s.uid,name:s.name,...(await expression(s,args,run))});
    }catch(e){return error(e);}finally{if(client) await client.close();}
  });
  const tab={target_id:z.string(),layout_id:optional(z.string())};
  register('layout_safety_inspect','Read which layout is actually loaded in a tab (target_id from tab_list): its ID, name, URL, sections and whether it is protected. Read-only.',
    tab, onTab(async s=>{
      let protection, protection_error;
      try { protection=await loadProtection(root); } catch(e) { protection_error=e.message; }
      return {url:s.url,chart_id:s.chartId,...(protection?{protected:isProtected(s.uid,s.name,protection)}:{protection_error}),
        state_hash:hash(s.state),sections:s.state.charts.map(c=>({chart_id:c.chartId,panes:c.panes.length}))};
    }));
  register('study_inputs_get','Read every input (id, title, value) of a study in a tab (target_id from tab_list). Read-only; any chart.',
    {...tab,entity_id:z.string()}, onTab((s,a,run)=>run(STUDY_INPUTS(a.entity_id))));
  register('strategy_trades_get','Read a strategy study\'s closed trades (entry/exit time, bar, price, quantity) in a tab (target_id from tab_list). Read-only; any chart.',
    {...tab,entity_id:z.string()}, onTab((s,a,run)=>run(STRATEGY_TRADES(a.entity_id))));
}
