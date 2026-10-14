/**
 * Behaviour check for the layout guard's READ class: every read tool is run through the guard
 * against a fake CDP endpoint that records each command and evaluated expression, and the test
 * fails if any of them is a write (chart, layout, study, input, visibility, save/load, key input,
 * tab activation...). Names alone can drift; this catches a "read" tool that starts writing.
 *
 * No TradingView: the connection is pointed at a fake endpoint on a random local port before any
 * src module loads, and every network request other than that endpoint is refused.
 */
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { startFakeCdp } from './helpers/fake-cdp.js';

// Expressions answering these keep the core functions going past their existence checks.
const fake = await startFakeCdp({
  respond: (e) => (/^\s*typeof \(/.test(e) ? true : undefined),
});
process.env.TV_CDP_HOST = '127.0.0.1';
process.env.TV_CDP_PORT = String(fake.port);
const realFetch = globalThis.fetch;
const blocked = [];
globalThis.fetch = (url, opts) => {
  const u = String(url);
  if (u.startsWith(`http://127.0.0.1:${fake.port}/`)) return realFetch(url, opts);
  blocked.push(u);
  return Promise.reject(new Error('network disabled in this test'));
};
const { CDP_PORT, disconnect } = await import('../src/connection.js');
assert.equal(CDP_PORT, fake.port);
const { protectRegistrations, READ_TOOLS } = await import('../src/layout-safety.js');
const groups = await Promise.all(['health', 'chart', 'pine', 'data', 'capture', 'drawing', 'alerts', 'batch', 'replay',
  'indicators', 'watchlist', 'ui', 'pane', 'tab', 'morning'].map(async (f) => {
  const m = await import(`../src/tools/${f}.js`);
  return Object.values(m).find(v => typeof v === 'function' && v.name.startsWith('register'));
}));

// Calls and expressions that change TradingView. Anything matching fails the read class.
const WRITE_EXPRESSION = /\b(setSymbol|setResolution|createStudy|removeEntity|setInputValues|executeActionById|saveChartToServer|loadChartFromServer|createNewLayout|removeAllStudies|setVisible|applyStudyTemplate|removeAllShapes|createShape|createMultipointShape|setChartType|setVisibleRange|takeScreenshot)\s*\(|dispatchEvent\(\s*new\s+KeyboardEvent/;
const WRITE_METHOD = /^(Input\.|Page\.(navigate|reload)|Target\.(activateTarget|createTarget|closeTarget)|Emulation\.)/;
const WRITE_HTTP = /^\/json\/(activate|new|close)/;
function writesIn(entries) {
  return entries.filter(e => (e.kind === 'evaluate' && WRITE_EXPRESSION.test(e.expression))
    || (e.kind === 'cdp' && WRITE_METHOD.test(e.method || ''))
    || (e.kind === 'http' && WRITE_HTTP.test(e.path)));
}

// Arguments for each read tool. Every READ tool must be listed (checked below).
const SOURCE = '//@version=6\nindicator("x")\nplot(close)\n';
const CALLS = {
  chart_get_state: [{}], chart_get_visible_range: [{}], symbol_info: [{}], symbol_search: [{ query: 'BTC' }],
  quote_get: [{}, { symbol: 'BINANCE:BTCUSDT' }], data_get_ohlcv: [{ summary: true }, { count: 5 }],
  data_get_indicator: [{ entity_id: 'abc' }], data_get_study_values: [{}],
  data_get_pine_lines: [{}], data_get_pine_labels: [{}], data_get_pine_boxes: [{}], data_get_pine_tables: [{}],
  data_get_strategy_results: [{}], data_get_trades: [{}], data_get_equity: [{}], depth_get: [{}],
  draw_list: [{}], draw_get_properties: [{ entity_id: 'abc' }], alert_list: [{}],
  pine_check: [{ source: SOURCE }], pine_list_scripts: [{}], pine_analyze: [{ source: SOURCE }],
  replay_status: [{}], layout_list: [{}], pane_list: [{}], tab_list: [{}],
  tv_health_check: [{}], tv_discover: [{}], tv_ui_state: [{}], ui_find_element: [{ query: 'Pine' }],
  capture_screenshot: [{}, { region: 'chart' }, { method: 'api' }], watchlist_get: [{}], session_get: [{ date: '1999-01-01' }],
};

const handlers = new Map();
const server = { tool: (name, d, s, handler) => handlers.set(name, handler) };
protectRegistrations(server, { z, connect: async () => assert.fail('a guarded write connected') });
for (const register of groups) register(server);

after(async () => { await disconnect(); await fake.close(); globalThis.fetch = realFetch; });

describe('read tools never send a write', () => {
  it('lists arguments for every read tool', () => {
    assert.deepEqual(Object.keys(CALLS).sort(), [...READ_TOOLS].sort());
  });

  const perTool = new Map();
  for (const [name, argsList] of Object.entries(CALLS)) {
    it(name, { timeout: 30000 }, async (t) => {
      const start = fake.log.length;
      for (const args of argsList) await handlers.get(name)(args);
      const entries = fake.log.slice(start);
      perTool.set(name, entries.filter(e => e.kind === 'evaluate').length);
      t.diagnostic(`${perTool.get(name)} page expressions`);
      assert.deepEqual(writesIn(entries).map(e => e.expression || e.method || e.path), [], `${name} sent a write`);
    });
  }

  it('capture_screenshot method "api" (publishes a snapshot) is refused before reaching the page', async () => {
    const start = fake.log.length;
    const r = await handlers.get('capture_screenshot')({ method: 'api' });
    assert.equal(r.isError, true);
    assert.match(r.content[0].text, /SNAPSHOT_PUBLISH_DISABLED/);
    assert.equal(fake.log.length, start);
  });

  it('the detector catches real writes (positive control)', async () => {
    const chart = await import('../src/core/chart.js');
    const ui = await import('../src/core/ui.js');
    const start = fake.log.length;
    await chart.manageIndicator({ action: 'remove', entity_id: 'abc' });
    await ui.keyboard({ key: 'Escape' }).catch(() => {});
    const found = writesIn(fake.log.slice(start)).map(e => e.expression ? 'removeEntity' : e.method);
    assert.ok(found.includes('removeEntity'), 'removeEntity not detected');
    assert.ok(found.some(m => /^Input\./.test(m)), 'key input not detected');
  });

  it('reports which read tools reached the page', () => {
    // Offline or REST-only tools send no page expression; that is expected for these.
    const offline = ['pine_analyze', 'pine_check', 'symbol_search', 'session_get'];
    const silent = [...perTool].filter(([n, count]) => count === 0 && !offline.includes(n)).map(([n]) => n);
    assert.deepEqual(silent, [], `read tools that never reached the fake page: ${silent}`);
    assert.ok(blocked.every(u => /tradingview\.com/.test(u)), `unexpected network request: ${blocked}`);
  });
});
