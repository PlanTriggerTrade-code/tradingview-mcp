import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  guardedWrite, createScratch, recordScratch, scratchLayouts, protectRegistrations, loadProtection, PROTECTION_FILE,
} from '../src/layout-safety.js';

// All IDs and names here are made up. The protection list is injected through `root`.
const PROTECTION = { layouts: [{ id: 'prot0001', name: 'Protected chart' }, { id: 'prot0002', name: 'Second protected chart' }],
  names: ['do[\\s_.-]*not[\\s_.-]*touch'] };

const layout = (uid, name = 'Chart', url = `https://www.tradingview.com/chart/${uid}/`) => ({
  url, uid, name, chartId: '1',
  state: { name, layout: 's', charts: [{ chartId: '1', panes: [{ sources: [{ id: 'series', type: 'MainSeries' }] }] }] },
});

// A fake CDP client: SNAPSHOT returns the current layout, anything else is logged as a write.
function client(get, log, onWrite = () => {}) {
  return async () => ({
    close: async () => {},
    Runtime: { evaluate: async ({ expression }) => {
      if (expression.includes('chartWidgetCollectionState')) return { result: { value: structuredClone(get()) } };
      log.push(expression); onWrite(expression);
      return { result: { value: 42 } };
    } },
  });
}
/** A temporary state folder, optionally with a protected-layouts.json (object, or raw text). */
const tempRoot = async (protection = PROTECTION) => {
  const root = await mkdtemp(join(tmpdir(), 'tv-perm-'));
  if (protection !== null) {
    await writeFile(join(root, PROTECTION_FILE), typeof protection === 'string' ? protection : JSON.stringify(protection));
  }
  return root;
};

test('a real chart is never changed without the user\'s yes', async () => {
  const root = await tempRoot(); const log = [];
  try {
    await assert.rejects(guardedWrite({ target_id: 't', layout_id: 'real0001', tool: 'chart_set_symbol', args: { symbol: 'X' } },
      { root, connect: client(() => layout('real0001', 'Real chart'), log) }), /REAL_CHART_NEEDS_PERMISSION/);
    assert.equal(log.length, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('with the user\'s yes a real chart can be changed, protected ones included', async () => {
  const root = await tempRoot(); const log = [];
  try {
    for (const uid of ['real0001', 'prot0001']) {
      const r = await guardedWrite({ target_id: 't', layout_id: uid, user_approved: true, tool: 'indicator_toggle_visibility', args: { entity_id: 's', visible: false } },
        { root, connect: client(() => layout(uid), log) });
      assert.equal(r.success, true); assert.equal(r.real_chart, true);
    }
    assert.equal(log.length, 2);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a scratch chart needs no permission for typed writes', async () => {
  const root = await tempRoot(); const log = [];
  try {
    await recordScratch(root, 'scratch01', 'Scratch');
    const r = await guardedWrite({ target_id: 't', layout_id: 'scratch01', tool: 'chart_manage_indicator', args: { action: 'remove', entity_id: 'abc' } },
      { root, connect: client(() => layout('scratch01'), log) });
    assert.equal(r.real_chart, false);
    assert.match(log[0], /removeEntity\("abc"\)/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('ui_evaluate always needs the user\'s yes, also on a scratch chart, and is refused before connecting', async () => {
  const root = await tempRoot(); const log = []; let connects = 0;
  try {
    await recordScratch(root, 'scratch01', 'Scratch');
    const connect = async (...a) => { connects++; return client(() => layout('scratch01'), log)(...a); };
    // From a scratch chart, raw JS could load, change and save a real layout.
    const attack = 'TradingViewApi.loadChartFromServer("real0001")';
    await assert.rejects(guardedWrite({ target_id: 't', layout_id: 'scratch01', tool: 'ui_evaluate', args: { expression: attack } },
      { root, connect }), /UI_EVALUATE_NEEDS_PERMISSION/);
    await assert.rejects(guardedWrite({ target_id: 't', layout_id: 'scratch01', user_approved: 'true', tool: 'ui_evaluate', args: { expression: attack } },
      { root, connect }), /UI_EVALUATE_NEEDS_PERMISSION/);
    assert.equal(connects, 0); assert.equal(log.length, 0);
    const r = await guardedWrite({ target_id: 't', layout_id: 'scratch01', user_approved: true, tool: 'ui_evaluate', args: { expression: '6*7' } },
      { root, connect });
    assert.equal(r.real_chart, false); assert.equal(r.result, 42);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('URL showing one layout while another is loaded refuses even with approval', async () => {
  const root = await tempRoot(); const log = [];
  try {
    await recordScratch(root, 'scratch01', 'looks like scratch');
    const loaded = layout('prot0001', 'Protected chart', 'https://www.tradingview.com/chart/scratch01/');
    await assert.rejects(guardedWrite({ target_id: 't', layout_id: 'scratch01', user_approved: true, tool: 'ui_evaluate', args: { expression: '1' } },
      { root, connect: client(() => loaded, log) }), /IDENTITY_MISMATCH/);
    assert.equal(log.length, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('the protected-layouts file is honoured: listed IDs and name patterns stay real even if the registry lists them', async () => {
  const root = await tempRoot(); const log = [];
  try {
    await recordScratch(root, 'prot0001', 'wrongly listed'); await recordScratch(root, 'scratch02', 'x');
    await assert.rejects(guardedWrite({ target_id: 't', layout_id: 'prot0001', tool: 'chart_set_symbol', args: { symbol: 'X' } },
      { root, connect: client(() => layout('prot0001', 'Renamed'), log) }), /REAL_CHART_NEEDS_PERMISSION/);
    for (const name of ['Do Not Touch', 'DO_NOT_TOUCH', 'do-not-touch', 'my donottouch chart']) {
      await assert.rejects(guardedWrite({ target_id: 't', layout_id: 'scratch02', tool: 'chart_set_symbol', args: { symbol: 'X' } },
        { root, connect: client(() => layout('scratch02', name), log) }), /REAL_CHART_NEEDS_PERMISSION/, name);
    }
    // The same registry entry with an ordinary name is a scratch chart.
    await guardedWrite({ target_id: 't', layout_id: 'scratch02', tool: 'chart_set_symbol', args: { symbol: 'X' } },
      { root, connect: client(() => layout('scratch02', 'Scratch'), log) });
    assert.equal(log.length, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('without a protected-layouts file every layout is still real by default', async () => {
  const root = await tempRoot(null); const log = [];
  try {
    assert.equal((await loadProtection(root)).ids.size, 0);
    await assert.rejects(guardedWrite({ target_id: 't', layout_id: 'real0001', tool: 'chart_set_symbol', args: { symbol: 'X' } },
      { root, connect: client(() => layout('real0001', 'Real chart'), log) }), /REAL_CHART_NEEDS_PERMISSION/);
    await recordScratch(root, 'scratch01', 'Scratch');
    await guardedWrite({ target_id: 't', layout_id: 'scratch01', tool: 'chart_set_symbol', args: { symbol: 'X' } },
      { root, connect: client(() => layout('scratch01'), log) });
    assert.equal(log.length, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('an invalid protected-layouts file fails closed for writes, before connecting', async () => {
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
    const root = await tempRoot(text); let connects = 0;
    try {
      await recordScratch(root, 'scratch01', 'Scratch');
      const connect = async () => { connects++; return client(() => layout('scratch01'), [])(); };
      await assert.rejects(loadProtection(root), /PROTECTED_LAYOUTS_INVALID/, label);
      await assert.rejects(guardedWrite({ target_id: 't', layout_id: 'scratch01', tool: 'chart_set_symbol', args: { symbol: 'X' } },
        { root, connect }), /PROTECTED_LAYOUTS_INVALID/, label);
      await assert.rejects(createScratch({ target_id: 't', layout_id: 'scratch01' }, { root, connect, delay: async () => {} }),
        /PROTECTED_LAYOUTS_INVALID/, label);
      assert.equal(connects, 0, label);
      // Read-only inspection still works and reports the layout as real.
      const handlers = new Map();
      protectRegistrations({ tool: (n, d, sc, h) => handlers.set(n, h) }, { z: { string: () => ({}) }, root, connect });
      const r = JSON.parse((await handlers.get('layout_safety_inspect')({ target_id: 't', layout_id: 'scratch01' })).content[0].text);
      assert.equal(r.real_chart, true, label); assert.match(r.protection_error, /PROTECTED_LAYOUTS_INVALID/, label);
    } finally { await rm(root, { recursive: true, force: true }); }
  }
});

test('the protected-layouts file is read again on every operation and may start with a BOM', async () => {
  const root = await tempRoot({ layouts: [] }); const log = [];
  try {
    await recordScratch(root, 'scratch01', 'Scratch');
    const write = () => guardedWrite({ target_id: 't', layout_id: 'scratch01', tool: 'chart_set_symbol', args: { symbol: 'X' } },
      { root, connect: client(() => layout('scratch01'), log) });
    await write();
    await writeFile(join(root, PROTECTION_FILE), '﻿' + JSON.stringify({ layouts: [{ id: 'scratch01' }] }));
    await assert.rejects(write(), /REAL_CHART_NEEDS_PERMISSION/);
    assert.equal(log.length, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('scratch_layout_create records only a confirmed new layout and leaves the old one alone', async () => {
  const root = await tempRoot(); const log = [];
  try {
    await recordScratch(root, 'scratch01', 'old scratch');
    let current = layout('scratch01', 'old scratch');
    const r = await createScratch({ target_id: 't', layout_id: 'scratch01', name: 'New scratch' },
      { root, delay: async () => {}, connect: client(() => current, log, e => { if (e.includes('createNewLayout')) current = layout('new00001', 'Unnamed'); }) });
    assert.equal(r.layout_id, 'new00001'); assert.equal(r.previous_layout, 'scratch01');
    assert.deepEqual([...await scratchLayouts(root)].sort(), ['new00001', 'scratch01']);
    assert.equal(log.length, 1);
    // Nothing new loaded: refuse and record nothing.
    current = layout('scratch01', 'old scratch');
    await assert.rejects(createScratch({ target_id: 't', layout_id: 'scratch01' }, { root, delay: async () => {}, connect: client(() => current, log) }), /NOT_CONFIRMED/);
    assert.deepEqual([...await scratchLayouts(root)].sort(), ['new00001', 'scratch01']);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('scratch_layout_create on a tab showing a real chart needs the user\'s yes', async () => {
  const root = await tempRoot();
  try {
    for (const [uid, name] of [['real0001', 'Real chart'], ['prot0001', 'Protected chart']]) {
      const log = []; let current = layout(uid, name);
      const deps = { root, delay: async () => {}, connect: client(() => current, log, e => { if (e.includes('createNewLayout')) current = layout('new0000' + log.length, 'Unnamed'); }) };
      await assert.rejects(createScratch({ target_id: 't', layout_id: uid }, deps), /REAL_CHART_NEEDS_PERMISSION/);
      assert.equal(log.length, 0, 'no layout created without approval');
      const r = await createScratch({ target_id: 't', layout_id: uid, user_approved: true }, deps);
      assert.equal(r.previous_layout, uid); assert.equal(log.length, 1);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('scratch_layout_create never records a layout that is not new and empty (registry poisoning)', async () => {
  const withStudy = uid => { const l = layout(uid); l.state.charts[0].panes[0].sources.push({ id: 'st1', type: 'Study' }); return l; };
  const withDrawing = uid => { const l = layout(uid); l.state.charts[0].panes.push({ sources: [{ id: 'd1', type: 'LineToolHorzLine' }] }); return l; };
  const twoSections = uid => { const l = layout(uid); l.state.layout = '2h'; l.state.charts.push({ chartId: '2', panes: [{ sources: [{ id: 's2', type: 'MainSeries' }] }] }); return l; };
  const cases = [
    ['protected ID', () => layout('prot0002', 'Unnamed')],
    ['protected name pattern', () => layout('new00002', 'do_not_touch copy')],
    ['has a study', () => withStudy('new00003')],
    ['has a drawing', () => withDrawing('new00004')],
    ['two sections', () => twoSections('new00005')],
    ['no main series type', () => { const l = layout('new00006'); delete l.state.charts[0].panes[0].sources[0].type; return l; }],
  ];
  for (const [label, next] of cases) {
    const root = await tempRoot();
    try {
      await recordScratch(root, 'scratch01', 'old scratch');
      let current = layout('scratch01', 'old scratch');
      await assert.rejects(createScratch({ target_id: 't', layout_id: 'scratch01' },
        { root, delay: async () => {}, connect: client(() => current, [], e => { if (e.includes('createNewLayout')) current = next(); }) }),
      /SCRATCH_NOT_CONFIRMED/, label);
      assert.deepEqual([...await scratchLayouts(root)], ['scratch01'], label);
    } finally { await rm(root, { recursive: true, force: true }); }
  }
});

test('read tools work on any chart, verify identity and never write', async () => {
  const root = await tempRoot();
  try {
    const handlers = new Map(); const log = [];
    const s = layout('prot0001');
    protectRegistrations({ tool: (n, d, sc, h) => handlers.set(n, h) }, { z: { string: () => ({}) }, root, connect: client(() => s, log) });
    const ok = await handlers.get('study_inputs_get')({ target_id: 't', layout_id: s.uid, entity_id: 'abc' });
    assert.equal(ok.isError, undefined);
    assert.equal(log.length, 1); assert.match(log[0], /getInputValues/); assert.doesNotMatch(log[0], /setInputValues|removeEntity|setSymbol/);
    const bad = await handlers.get('strategy_trades_get')({ target_id: 't', layout_id: 'someoneElse', entity_id: 'abc' });
    assert.equal(bad.isError, true); assert.match(bad.content[0].text, /IDENTITY_MISMATCH/);
    const inspect = JSON.parse((await handlers.get('layout_safety_inspect')({ target_id: 't', layout_id: s.uid })).content[0].text);
    assert.equal(inspect.real_chart, true); assert.equal(inspect.protected, true);
  } finally { await rm(root, { recursive: true, force: true }); }
});
