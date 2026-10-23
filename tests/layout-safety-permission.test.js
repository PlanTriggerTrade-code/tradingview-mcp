/**
 * The rule: a tool that may change a chart is refused when the layout actually loaded in the tab
 * it acts on is protected (state/protected-layouts.json, by ID or name pattern), unless
 * user_approved is true. Every other chart is free.
 *
 * All IDs and names here are made up; the protection list is injected through `root`. The shared
 * active-tab connection and the tabs are fakes; nothing connects to TradingView.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  protectRegistrations, loadProtection, PROTECTION_FILE, SNAPSHOT, IDENTITY, EDITOR_SCRIPT_IDS,
} from '../src/layout-safety.js';

const PROTECTION = { layouts: [{ id: 'prot0001', name: 'Protected chart' }], names: ['do[\\s_.-]*not[\\s_.-]*touch'] };

const layout = (uid, name = 'Chart ' + uid, url = `https://www.tradingview.com/chart/${uid}/`) => ({
  url, uid, name, chartId: '1',
  state: { name, layout: 's', charts: [{ chartId: '1', panes: [{ sources: [{ id: 'series', type: 'MainSeries' }] }] }] },
});

/** A temporary state folder, optionally with a protected-layouts.json (object, or raw text). */
const tempRoot = async (protection = PROTECTION) => {
  const root = await mkdtemp(join(tmpdir(), 'tv-perm-'));
  if (protection !== null) {
    await writeFile(join(root, PROTECTION_FILE), typeof protection === 'string' ? protection : JSON.stringify(protection));
  }
  return root;
};

/** The shared connection to the active tab: answers from `page()`, records everything else. */
function fakeActive(page) {
  const log = { writes: [], pins: [], unpins: 0 };
  let pinned = null;
  return {
    log, pinnedNow: () => pinned,
    follow: async () => {},
    evaluate: async (e) => {
      if (e === SNAPSHOT) return structuredClone(page());
      if (e === IDENTITY) { const s = page(); return { url: s.url, uid: s.uid }; }
      log.writes.push(e); return undefined;
    },
    evaluateAsync: async (e) => (e === EDITOR_SCRIPT_IDS ? { title: 'Untitled script', ids: [], untitled: true } : undefined),
    targetId: async () => 'tab1',
    pin: (id) => { log.pins.push(id); pinned = id; },
    unpin: () => { log.unpins++; pinned = null; },
  };
}

/** One checked tool registered through the guard, with a stub handler that counts calls. */
function checkedTool(name, { root, active }) {
  const handlers = new Map();
  const server = { tool: (n, d, sc, h) => handlers.set(n, h) };
  protectRegistrations(server, { z: { string: () => ({}) }, root, active, connect: async () => assert.fail('connected') });
  const calls = [];
  server.tool(name, '', {}, async (args) => { calls.push({ args, pinned: active?.pinnedNow?.() ?? null }); return { content: [{ type: 'text', text: 'ran' }] }; });
  return { run: (args) => handlers.get(name)(args), calls };
}

test('a protected chart is refused without approval: nothing is sent and the tool never runs', async () => {
  const root = await tempRoot();
  try {
    const active = fakeActive(() => layout('prot0001', 'Protected chart'));
    const { run, calls } = checkedTool('chart_set_symbol', { root, active });
    const r = await run({ symbol: 'X' });
    assert.equal(r.isError, true);
    assert.match(r.content[0].text, /PROTECTED_CHART_NEEDS_PERMISSION.*Protected chart.*\(prot0001\)/);
    assert.equal(calls.length, 0); assert.deepEqual(active.log.writes, []); assert.deepEqual(active.log.pins, []);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('with the user\'s yes a protected chart can be changed, pinned to the checked tab', async () => {
  const root = await tempRoot();
  try {
    const active = fakeActive(() => layout('prot0001', 'Protected chart'));
    const { run, calls } = checkedTool('chart_set_symbol', { root, active });
    const r = await run({ symbol: 'X', user_approved: true });
    assert.equal(r.content[0].text, 'ran');
    assert.deepEqual(calls, [{ args: { symbol: 'X' }, pinned: 'tab1' }]);
    assert.equal(active.pinnedNow(), null);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('any other chart is free, without parameters', async () => {
  const root = await tempRoot();
  try {
    for (const tool of ['chart_set_symbol', 'ui_evaluate', 'ui_click', 'draw_clear', 'replay_start']) {
      const active = fakeActive(() => layout('free0001', 'My chart'));
      const { run, calls } = checkedTool(tool, { root, active });
      const r = await run({});
      assert.equal(r.content[0].text, 'ran', tool);
      assert.equal(calls.length, 1, tool);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('the loaded layout counts, not the URL: a URL of a free chart over a loaded protected one is refused', async () => {
  const root = await tempRoot();
  try {
    const active = fakeActive(() => layout('prot0001', 'Protected chart', 'https://www.tradingview.com/chart/free0001/'));
    const { run, calls } = checkedTool('draw_clear', { root, active });
    const r = await run({});
    assert.match(r.content[0].text, /PROTECTED_CHART_NEEDS_PERMISSION.*prot0001/);
    assert.equal(calls.length, 0);
    // And the reverse: a protected URL over a loaded free chart is free.
    const free = fakeActive(() => layout('free0001', 'My chart', 'https://www.tradingview.com/chart/prot0001/'));
    assert.equal((await checkedTool('draw_clear', { root, active: free }).run({})).content[0].text, 'ran');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('name patterns protect a chart whatever its ID, case-insensitively', async () => {
  const root = await tempRoot();
  try {
    for (const name of ['Do Not Touch', 'DO_NOT_TOUCH', 'my do-not-touch chart']) {
      const { run, calls } = checkedTool('draw_clear', { root, active: fakeActive(() => layout('free0002', name)) });
      assert.match((await run({})).content[0].text, /PROTECTED_CHART_NEEDS_PERMISSION/, name);
      assert.equal(calls.length, 0, name);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('an optional layout_id must match the loaded layout, even with approval', async () => {
  const root = await tempRoot();
  try {
    const { run, calls } = checkedTool('draw_clear', { root, active: fakeActive(() => layout('free0001')) });
    assert.match((await run({ layout_id: 'other001', user_approved: true })).content[0].text, /LAYOUT_ID_MISMATCH/);
    assert.equal((await run({ layout_id: 'free0001' })).content[0].text, 'ran');
    assert.equal(calls.length, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('without a protected-layouts file every chart is free', async () => {
  const root = await tempRoot(null);
  try {
    assert.equal((await loadProtection(root)).ids.size, 0);
    const { run } = checkedTool('draw_clear', { root, active: fakeActive(() => layout('prot0001', 'Protected chart')) });
    assert.equal((await run({})).content[0].text, 'ran');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('an invalid protected-layouts file refuses every change until it is fixed', async () => {
  const bad = [
    ['not JSON', '{"layouts": ['],
    ['not an object', '[]'],
    ['unknown key (typo)', JSON.stringify({ layout: [{ id: 'prot0001' }] })],
    ['layouts not an array', JSON.stringify({ layouts: 'prot0001' })],
    ['layout without id', JSON.stringify({ layouts: [{ name: 'x' }] })],
    ['bad id', JSON.stringify({ layouts: [{ id: 'has space' }] })],
    ['bad pattern', JSON.stringify({ names: ['(unclosed'] })],
    ['empty pattern', JSON.stringify({ names: [''] })],
  ];
  for (const [label, text] of bad) {
    const root = await tempRoot(text);
    try {
      await assert.rejects(loadProtection(root), /PROTECTED_LAYOUTS_INVALID/, label);
      const active = fakeActive(() => layout('free0001'));
      const { run, calls } = checkedTool('draw_clear', { root, active });
      assert.match((await run({})).content[0].text, /PROTECTED_LAYOUTS_INVALID/, label);
      assert.equal(calls.length, 0, label);
    } finally { await rm(root, { recursive: true, force: true }); }
  }
});

test('the protected-layouts file is read again on every check and may start with a BOM', async () => {
  const root = await tempRoot({ layouts: [] });
  try {
    const { run, calls } = checkedTool('draw_clear', { root, active: fakeActive(() => layout('free0001')) });
    assert.equal((await run({})).content[0].text, 'ran');
    await writeFile(join(root, PROTECTION_FILE), '﻿' + JSON.stringify({ layouts: [{ id: 'free0001' }] }));
    assert.match((await run({})).content[0].text, /PROTECTED_CHART_NEEDS_PERMISSION/);
    assert.equal(calls.length, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('an unreadable active tab is refused without approval', async () => {
  const root = await tempRoot();
  try {
    const active = fakeActive(() => { throw new Error('not a chart page'); });
    const { run, calls } = checkedTool('ui_click', { root, active });
    assert.match((await run({})).content[0].text, /CHART_NOT_READABLE/);
    assert.equal(calls.length, 0);
    assert.equal((await run({ user_approved: true })).content[0].text, 'ran');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('read tools on an explicit tab work on any chart and never write', async () => {
  const root = await tempRoot();
  try {
    const handlers = new Map(); const log = [];
    const s = layout('prot0001', 'Protected chart');
    const connect = async () => ({ close: async () => {}, Runtime: { evaluate: async ({ expression }) => {
      if (expression === SNAPSHOT) return { result: { value: structuredClone(s) } };
      log.push(expression); return { result: { value: {} } };
    } } });
    protectRegistrations({ tool: (n, d, sc, h) => handlers.set(n, h) }, { z: { string: () => ({}) }, root, connect });
    const ok = await handlers.get('study_inputs_get')({ target_id: 't', entity_id: 'abc' });
    assert.equal(ok.isError, undefined);
    assert.equal(log.length, 1); assert.match(log[0], /getInputValues/); assert.doesNotMatch(log[0], /setInputValues|removeEntity|setSymbol/);
    const bad = await handlers.get('strategy_trades_get')({ target_id: 't', layout_id: 'someoneElse', entity_id: 'abc' });
    assert.equal(bad.isError, true); assert.match(bad.content[0].text, /LAYOUT_ID_MISMATCH/);
    const inspect = JSON.parse((await handlers.get('layout_safety_inspect')({ target_id: 't' })).content[0].text);
    assert.equal(inspect.layout_id, 'prot0001'); assert.equal(inspect.protected, true);
  } finally { await rm(root, { recursive: true, force: true }); }
});
