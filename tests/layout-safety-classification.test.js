/**
 * Every tool the server registers must land in exactly one class of the layout guard:
 * read (passes through), guarded write (target-bound, layout verified) or disabled.
 * A new tool that nobody classified is disabled by the guard and fails the EXPECTED check
 * below until it is reviewed and added here and to docs/LAYOUT_SAFETY.md.
 *
 * No TradingView connection: disabled handlers never connect, guarded writes are given fake
 * CDP clients, and read handlers (which would connect) are never called. The stdio check
 * points the server at a closed local port.
 */
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

// Point every connection at a closed local port BEFORE any src module loads (connection.js reads
// these once at import), so even a broken guard could not reach a running TradingView.
process.env.TV_CDP_HOST = '127.0.0.1';
process.env.TV_CDP_PORT = '9';
const { CDP_PORT } = await import('../src/connection.js');
assert.equal(CDP_PORT, 9);
const { booleanParam } = await import('../src/tools/_schema.js');
const { registerHealthTools } = await import('../src/tools/health.js');
const { registerChartTools } = await import('../src/tools/chart.js');
const { registerPineTools } = await import('../src/tools/pine.js');
const { registerDataTools } = await import('../src/tools/data.js');
const { registerCaptureTools } = await import('../src/tools/capture.js');
const { registerDrawingTools } = await import('../src/tools/drawing.js');
const { registerAlertTools } = await import('../src/tools/alerts.js');
const { registerBatchTools } = await import('../src/tools/batch.js');
const { registerReplayTools } = await import('../src/tools/replay.js');
const { registerIndicatorTools } = await import('../src/tools/indicators.js');
const { registerWatchlistTools } = await import('../src/tools/watchlist.js');
const { registerUiTools } = await import('../src/tools/ui.js');
const { registerPaneTools } = await import('../src/tools/pane.js');
const { registerTabTools } = await import('../src/tools/tab.js');
const { registerMorningTools } = await import('../src/tools/morning.js');
const { registerPineDevelopment } = await import('../src/pine-development.js');
const {
  protectRegistrations, classify, READ_TOOLS, WRITE_TOOLS, GUARD_TOOLS, ROOT, DISABLED_MARK, WRITE_NOTE,
  UI_EVALUATE_NOTE,
} = await import('../src/layout-safety.js');

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const GROUPS = [registerHealthTools, registerChartTools, registerPineTools, registerDataTools, registerCaptureTools,
  registerDrawingTools, registerAlertTools, registerBatchTools, registerReplayTools, registerIndicatorTools,
  registerWatchlistTools, registerUiTools, registerPaneTools, registerTabTools, registerMorningTools];

const READ = ['chart_get_state', 'chart_get_visible_range', 'symbol_info', 'symbol_search', 'quote_get',
  'data_get_ohlcv', 'data_get_indicator', 'data_get_study_values', 'data_get_pine_lines', 'data_get_pine_labels',
  'data_get_pine_boxes', 'data_get_pine_tables', 'data_get_strategy_results', 'data_get_trades', 'data_get_equity',
  'depth_get', 'draw_list', 'draw_get_properties', 'alert_list', 'pine_check', 'pine_list_scripts', 'pine_analyze',
  'replay_status', 'layout_list', 'pane_list', 'tab_list', 'tv_health_check', 'tv_discover', 'tv_ui_state',
  'ui_find_element', 'capture_screenshot', 'watchlist_get', 'session_get'];
const WRITE = ['chart_set_symbol', 'chart_set_timeframe', 'indicator_set_inputs', 'indicator_toggle_visibility',
  'chart_manage_indicator', 'ui_evaluate'];
const DISABLED = ['alert_create', 'alert_delete', 'batch_run', 'chart_set_type', 'chart_set_visible_range',
  'chart_scroll_to_date', 'draw_shape', 'draw_clear', 'draw_remove_one', 'tv_launch', 'indicator_search',
  'indicator_add', 'morning_brief', 'session_save', 'pane_set_layout', 'pane_focus', 'pane_set_symbol',
  'pine_get_source', 'pine_editor_state', 'pine_set_source', 'pine_compile', 'pine_get_errors', 'pine_save',
  'pine_get_console', 'pine_smart_compile', 'pine_new', 'pine_open', 'replay_start', 'replay_step',
  'replay_autoplay', 'replay_stop', 'replay_trade', 'tab_new', 'layout_new', 'tab_close', 'tab_switch',
  'ui_click', 'ui_open_panel', 'ui_fullscreen', 'layout_switch', 'ui_keyboard', 'ui_type_text', 'ui_hover',
  'ui_scroll', 'ui_mouse_click', 'watchlist_add', 'watchlist_add_bulk', 'watchlist_remove'];
const EXPECTED = new Map([...READ.map(n => [n, 'read']), ...WRITE.map(n => [n, 'write']), ...DISABLED.map(n => [n, 'disabled'])]);

const noConnect = async () => assert.fail('a TradingView connection was attempted');

/** Registers every real tool group through the guard on a recording fake server. */
function recordGuarded(connect = noConnect) {
  const registered = new Map(); // name -> { description, schema, handler }
  const originals = new Map();
  const server = {
    tool: (name, description, schema, handler) => {
      assert.ok(!registered.has(name), `${name} registered twice`);
      registered.set(name, { description, schema, handler });
    },
  };
  protectRegistrations(server, { z, connect, bool: booleanParam });
  const guarded = server.tool;
  // Remember each group's own handler so the test can prove disabled tools never reach it.
  server.tool = (name, description, schema, handler) => {
    originals.set(name, handler);
    return guarded(name, description, schema, handler);
  };
  for (const register of GROUPS) register(server);
  return { registered, originals, server };
}

describe('layout guard classification', () => {
  it('puts every tool of every real tool group in exactly one reviewed class', () => {
    const { originals } = recordGuarded();
    const names = [...originals.keys()];
    assert.equal(new Set(names).size, names.length, 'duplicate tool names');
    assert.equal(EXPECTED.size, READ.length + WRITE.length + DISABLED.length, 'a tool is listed in two classes');
    const unreviewed = names.filter(n => !EXPECTED.has(n));
    assert.deepEqual(unreviewed, [], `new tools must be classified here and in docs/LAYOUT_SAFETY.md: ${unreviewed}`);
    for (const name of names) assert.equal(classify(name), EXPECTED.get(name), name);
    assert.deepEqual(names.slice().sort(), [...EXPECTED.keys()].sort(), 'EXPECTED lists a tool nobody registers');
    // No stale entries: every read/write name is a tool that exists.
    for (const name of [...READ_TOOLS, ...WRITE_TOOLS]) assert.ok(originals.has(name), `${name} is not registered by any tool group`);
    for (const name of Object.keys(GUARD_TOOLS)) assert.ok(!originals.has(name), `${name} is reserved for the guard`);
  });

  it('read tools keep their schema and description; writes become target-bound; the rest are marked disabled', () => {
    const { registered, originals } = recordGuarded();
    for (const name of originals.keys()) {
      const { description, schema } = registered.get(name);
      const cls = classify(name);
      if (cls === 'read') {
        assert.ok(!description.endsWith(DISABLED_MARK), name);
        assert.ok(!('target_id' in schema), name);
      } else if (cls === 'write') {
        assert.ok(description.includes(WRITE_NOTE), name);
        assert.equal(description.includes(UI_EVALUATE_NOTE), name === 'ui_evaluate', name);
        for (const key of ['target_id', 'layout_id', 'user_approved']) assert.ok(key in schema, `${name}.${key}`);
      } else {
        assert.ok(description.endsWith(DISABLED_MARK), name);
      }
    }
  });

  it('disabled tools refuse without connecting and never call the original handler', async () => {
    const handlers = new Map();
    const server = { tool: (n, d, sc, h) => handlers.set(n, h) };
    protectRegistrations(server, { z, connect: noConnect });
    let calls = 0;
    for (const name of DISABLED) {
      server.tool(name, 'x', {}, async () => { calls++; return { content: [] }; });
      const r = await handlers.get(name)({});
      assert.equal(r.isError, true, name);
      assert.match(r.content[0].text, /UNSAFE_OPERATION_DISABLED/, name);
    }
    assert.equal(calls, 0);
  });

  it('guarded writes without a target refuse before connecting', async () => {
    const { registered } = recordGuarded();
    for (const name of WRITE) {
      const r = await registered.get(name).handler({ symbol: 'X', timeframe: '60', entity_id: 'a', visible: true, inputs: '{"a":1}', action: 'remove', expression: '1' });
      assert.equal(r.isError, true, name);
      assert.match(r.content[0].text, /Explicit target_id and layout_id required/, name);
    }
  });

  it('refuses registrations that could slip past the guard', () => {
    const server = { tool: () => {}, registerTool: () => assert.fail('bypassed') };
    protectRegistrations(server, { z, connect: noConnect });
    assert.throws(() => server.registerTool('sneaky', {}, async () => {}), /UNSUPPORTED_REGISTRATION/);
    assert.throws(() => server.tool('sneaky', {}, async () => {}), /UNSUPPORTED_REGISTRATION/);
    assert.throws(() => server.tool('sneaky', 'd', {}, {}, async () => {}), /UNSUPPORTED_REGISTRATION/);
    assert.throws(() => server.tool('study_inputs_get', 'd', {}, async () => {}), /RESERVED_TOOL_NAME/);
  });

  it('the classification table in docs/LAYOUT_SAFETY.md matches the code', () => {
    const doc = readFileSync(join(REPO, 'docs', 'LAYOUT_SAFETY.md'), 'utf8');
    const rows = new Map();
    for (const line of doc.split(/\r?\n/)) {
      const m = line.match(/^\|\s*`([a-z_]+)`\s*\|\s*(read|guarded write|disabled)\s*\|/);
      if (m) { assert.ok(!rows.has(m[1]), `${m[1]} appears twice in the doc table`); rows.set(m[1], m[2]); }
    }
    const all = [...EXPECTED.keys(), ...Object.keys(GUARD_TOOLS)];
    assert.deepEqual([...rows.keys()].sort(), all.sort());
    for (const name of all) {
      const cls = classify(name);
      assert.equal(rows.get(name), cls === 'write' ? 'guarded write' : cls, name);
    }
  });

  it('keeps its working files in the repository state folder, independent of the working directory', () => {
    assert.equal(ROOT, join(REPO, 'state'));
    assert.match(readFileSync(join(REPO, '.gitignore'), 'utf8'), /^state\/$/m);
  });
});

describe('layout guard on a real MCP server (zod v4, in memory)', () => {
  // An empty temporary state folder, so the user's own state/ files never affect the test.
  const root = mkdtempSync(join(tmpdir(), 'tv-guard-'));
  after(() => rmSync(root, { recursive: true, force: true }));
  async function connected(connect) {
    const server = new McpServer({ name: 'guard-test', version: '0.0.0' });
    registerPineDevelopment(server, { z, connect, root, listTargets: async () => assert.fail('listed targets'), bool: booleanParam });
    protectRegistrations(server, { z, connect, root, bool: booleanParam });
    for (const register of GROUPS) register(server);
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'guard-test-client', version: '0.0.0' });
    await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
    return client;
  }

  it('lists every tool with its class and the guard tools', async () => {
    const client = await connected(noConnect);
    const { tools } = await client.listTools();
    const byName = new Map(tools.map(t => [t.name, t]));
    assert.equal(tools.length, EXPECTED.size + Object.keys(GUARD_TOOLS).length);
    for (const [name, cls] of EXPECTED) {
      const t = byName.get(name);
      assert.equal(t.description.endsWith(DISABLED_MARK), cls === 'disabled', name);
      if (name === 'ui_evaluate') assert.match(t.description, /Always needs user_approved: true/);
      if (name === 'capture_screenshot') assert.match(t.description, /method "api" is disabled/);
      if (cls === 'write') {
        assert.ok(['target_id', 'layout_id'].every(k => t.inputSchema.required.includes(k)), name);
        assert.ok(t.inputSchema.properties.user_approved, name);
      }
    }
    for (const name of Object.keys(GUARD_TOOLS)) assert.ok(byName.has(name), name);
    assert.ok(byName.get('scratch_layout_create').inputSchema.properties.user_approved);
    await client.close();
  });

  it('a disabled tool refuses through the protocol', async () => {
    const client = await connected(noConnect);
    const r = await client.callTool({ name: 'tab_switch', arguments: { index: 1 } });
    assert.equal(r.isError, true);
    assert.match(r.content[0].text, /UNSAFE_OPERATION_DISABLED/);
    await client.close();
  });

  it('a real chart without approval is refused before any write expression is sent', async () => {
    const sent = [];
    const uid = 'real0001';
    const connect = async () => ({
      close: async () => {},
      Runtime: { evaluate: async ({ expression }) => {
        if (expression.includes('chartWidgetCollectionState')) {
          return { result: { value: { url: `https://www.tradingview.com/chart/${uid}/`, uid, name: 'Real chart', chartId: '1',
            state: { name: 'Real chart', layout: 's', charts: [{ chartId: '1', panes: [] }] } } } };
        }
        sent.push(expression); return { result: { value: true } };
      } },
    });
    const client = await connected(connect);
    const r = await client.callTool({ name: 'chart_set_symbol', arguments: { symbol: 'X', target_id: 't', layout_id: uid } });
    assert.equal(r.isError, true);
    assert.match(r.content[0].text, /REAL_CHART_NEEDS_PERMISSION/);
    // user_approved accepts only a boolean (or the words true/false), never other junk.
    const junk = await client.callTool({ name: 'chart_set_symbol', arguments: { symbol: 'X', target_id: 't', layout_id: uid, user_approved: 'yes' } });
    assert.equal(junk.isError, true);
    assert.deepEqual(sent, []);
    await client.close();
  });
});

describe('server.js', () => {
  // Starts the real server over stdio, aimed at a closed local port so it cannot reach TradingView,
  // and lists the tools. Listing never runs a tool handler.
  it('starts with the guard installed before the tool groups', async () => {
    const child = spawn(process.execPath, [join(REPO, 'src', 'server.js')], {
      cwd: REPO, stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, TV_CDP_HOST: '127.0.0.1', TV_CDP_PORT: '9' },
    });
    try {
      const responses = new Map();
      let buffer = '';
      child.stdout.on('data', chunk => {
        buffer += chunk;
        let i;
        while ((i = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, i).trim(); buffer = buffer.slice(i + 1);
          if (line) { const msg = JSON.parse(line); if (msg.id) responses.set(msg.id, msg); }
        }
      });
      const send = msg => child.stdin.write(JSON.stringify(msg) + '\n');
      const wait = async id => {
        for (let i = 0; i < 200 && !responses.has(id); i++) await new Promise(r => setTimeout(r, 50));
        assert.ok(responses.has(id), `no response to request ${id}`);
        return responses.get(id);
      };
      send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } } });
      const init = await wait(1);
      assert.match(init.result.instructions, /LAYOUT SAFETY/);
      send({ jsonrpc: '2.0', method: 'notifications/initialized' });
      send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
      const { tools } = (await wait(2)).result;
      const byName = new Map(tools.map(t => [t.name, t]));
      assert.equal(tools.length, EXPECTED.size + Object.keys(GUARD_TOOLS).length);
      for (const [name, cls] of EXPECTED) assert.equal(byName.get(name).description.endsWith(DISABLED_MARK), cls === 'disabled', name);
      for (const name of WRITE) assert.ok(byName.get(name).inputSchema.required.includes('target_id'), name);
    } finally {
      child.kill();
    }
  });
});
