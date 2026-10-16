/**
 * Every tool the server registers must land in exactly one class of the layout guard:
 *   read     — changes nothing; runs as is
 *   account  — alerts, watchlist, tabs, new layouts, app window, editor buffer, local files; runs as is
 *   checked  — may change the chart in a tab; refused when the layout loaded there is protected,
 *              unless user_approved; the shared connection is pinned to the checked tab
 *   disabled — only for a tool nobody has reviewed yet (none of the real tools)
 * A new tool fails the EXPECTED check below until it is classified here and in
 * docs/LAYOUT_SAFETY.md.
 *
 * No TradingView connection: original handlers are replaced by stubs wherever a test calls them,
 * the shared connection is a fake, and the stdio check points the server at a closed local port.
 */
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
const GROUPS = await Promise.all(['health', 'chart', 'pine', 'data', 'capture', 'drawing', 'alerts', 'batch', 'replay',
  'indicators', 'watchlist', 'ui', 'pane', 'tab', 'morning'].map(async (f) => {
  const m = await import(`../src/tools/${f}.js`);
  return Object.values(m).find(v => typeof v === 'function' && v.name.startsWith('register'));
}));
const { registerPineDevelopment } = await import('../src/pine-development.js');
const {
  protectRegistrations, classify, READ_TOOLS, ACCOUNT_TOOLS, CHART_TOOLS, PINE_SAVE_TOOLS, GUARD_TOOLS, ROOT,
  DISABLED_MARK, CHECKED_NOTE, SNAPSHOT, IDENTITY, EDITOR_SCRIPT_IDS, PROTECTION_FILE,
} = await import('../src/layout-safety.js');

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');

const READ = ['chart_get_state', 'chart_get_visible_range', 'symbol_info', 'symbol_search', 'quote_get',
  'data_get_ohlcv', 'data_export_ohlcv', 'data_get_indicator', 'data_get_study_values', 'data_get_pine_lines', 'data_get_pine_labels',
  'data_get_pine_boxes', 'data_get_pine_tables', 'data_get_strategy_results', 'data_get_trades', 'data_get_equity',
  'depth_get', 'draw_list', 'draw_get_properties', 'alert_list', 'pine_check', 'pine_list_scripts', 'pine_analyze',
  'replay_status', 'layout_list', 'pane_list', 'tab_list', 'tv_health_check', 'tv_discover', 'tv_ui_state',
  'ui_find_element', 'capture_screenshot', 'watchlist_get', 'session_get',
  'pine_get_source', 'pine_get_errors', 'pine_get_console', 'pine_editor_state', 'indicator_search'];
const ACCOUNT = ['alert_create', 'alert_delete', 'watchlist_add', 'watchlist_add_bulk', 'watchlist_remove', 'tv_launch',
  'tab_new', 'tab_close', 'tab_switch', 'layout_new', 'session_save', 'ui_fullscreen',
  'pine_set_source', 'pine_open', 'ui_hover', 'ui_open_panel'];
// Each checked tool with arguments a caller would send.
const CHECKED = {
  chart_set_symbol: { symbol: 'A' }, chart_set_timeframe: { timeframe: '60' }, chart_set_type: { chart_type: 'Candles' },
  chart_set_visible_range: { from: 1, to: 2 }, chart_scroll_to_date: { date: '2025-01-15' },
  chart_manage_indicator: { action: 'remove', entity_id: 'a' }, indicator_set_inputs: { entity_id: 'a', inputs: '{"a":1}' },
  indicator_toggle_visibility: { entity_id: 'a', visible: false }, indicator_add: { query: 'RSI' },
  draw_shape: { shape: 'horizontal_line', point: { time: 1, price: 1 } }, draw_clear: {}, draw_remove_one: { entity_id: 'a' },
  morning_brief: {}, batch_run: { symbols: ['A'], action: 'screenshot' },
  pane_set_layout: { layout: '2h' }, pane_focus: { index: 0 }, pane_set_symbol: { index: 0, symbol: 'A' },
  pine_new: { type: 'indicator' }, pine_compile: {}, pine_save: {}, pine_smart_compile: {},
  replay_start: {}, replay_step: {}, replay_autoplay: {}, replay_stop: {}, replay_trade: { action: 'buy' },
  layout_switch: { name: 'x' }, ui_evaluate: { expression: '1' }, ui_click: { by: 'text', value: 'x' },
  ui_keyboard: { key: 'Escape' }, ui_type_text: { text: 'x' }, ui_mouse_click: { x: 1, y: 1 }, ui_scroll: { direction: 'down' },
};
const EXPECTED = new Map([...READ.map(n => [n, 'read']), ...ACCOUNT.map(n => [n, 'account']),
  ...Object.keys(CHECKED).map(n => [n, 'checked'])]);

const noConnect = async () => assert.fail('a TradingView connection was attempted');

// A temporary state folder: "prot0001" and anything named like "do not touch" are protected.
// The user's own state/ files never affect these tests.
const root = mkdtempSync(join(tmpdir(), 'tv-guard-'));
writeFileSync(join(root, PROTECTION_FILE), JSON.stringify({ layouts: [{ id: 'prot0001', name: 'Protected' }], names: ['do[\\s_.-]*not[\\s_.-]*touch'] }));
after(() => rmSync(root, { recursive: true, force: true }));

const layoutState = (uid, url = `https://www.tradingview.com/chart/${uid}/`, name = 'Chart ' + uid) => ({
  url, uid, name, chartId: '1', state: { name, layout: 's', charts: [{ chartId: '1', panes: [{ sources: [{ id: 'series', type: 'MainSeries' }] }] }] },
});

/**
 * A fake shared connection to the active tab: SNAPSHOT/IDENTITY answer from `page()` (IDENTITY can
 * be overridden), the Pine editor lookup answers `editor`, every other expression is recorded as a
 * write, and pin/unpin are recorded.
 */
function fakeActive(page, { editor = { title: 'Untitled script', ids: [], untitled: true }, targets = ['tab1'], identity } = {}) {
  const log = { follows: 0, snapshots: 0, writes: [], pins: [], unpins: 0 };
  let t = 0, pinned = null;
  return {
    log,
    pinnedNow: () => pinned,
    follow: async () => { log.follows++; },
    evaluate: async (e) => {
      if (e === SNAPSHOT) { log.snapshots++; return structuredClone(page()); }
      if (e === IDENTITY) { if (identity) return identity(); const s = page(); return { url: s.url, uid: s.uid }; }
      log.writes.push(e); return undefined;
    },
    evaluateAsync: async (e) => { if (e === EDITOR_SCRIPT_IDS) return typeof editor === 'function' ? editor() : editor; log.writes.push(e); return undefined; },
    targetId: async () => targets[Math.min(t++, targets.length - 1)],
    pin: (id) => { log.pins.push(id); pinned = id; },
    unpin: () => { log.unpins++; pinned = null; },
  };
}

/**
 * Registers every real tool group through the guard on a recording fake server. The tools'
 * own handlers are replaced by stubs that record their arguments and whether the shared connection
 * was pinned (they would otherwise connect); set `impl` on an entry to change what a stub does.
 */
function recordGuarded({ active, connect = noConnect, listTargets } = {}) {
  const registered = new Map(); // name -> { description, schema, handler }
  const original = new Map();   // name -> { schema, calls: [], pinned: [], impl }
  const server = {
    tool: (name, description, schema, handler) => {
      assert.ok(!registered.has(name), `${name} registered twice`);
      registered.set(name, { description, schema, handler });
    },
  };
  protectRegistrations(server, { z, connect, root, bool: booleanParam, active, listTargets });
  const guarded = server.tool;
  server.tool = (name, description, schema) => {
    const entry = { schema, calls: [], pinned: [], impl: null };
    original.set(name, entry);
    return guarded(name, description, schema, async (args) => {
      entry.calls.push(args); entry.pinned.push(active?.pinnedNow?.() ?? null);
      return entry.impl ? entry.impl(args) : { content: [{ type: 'text', text: 'ran' }] };
    });
  };
  for (const register of GROUPS) register(server);
  return { registered, original };
}
const guardNote = r => JSON.parse(r.content.at(-1).text).layout_guard;

describe('layout guard classification', () => {
  it('puts every tool of every real tool group in exactly one reviewed class; none is disabled', () => {
    const { original } = recordGuarded();
    const names = [...original.keys()];
    const unreviewed = names.filter(n => !EXPECTED.has(n));
    assert.deepEqual(unreviewed, [], `new tools must be classified here and in docs/LAYOUT_SAFETY.md: ${unreviewed}`);
    assert.equal(EXPECTED.size, READ.length + ACCOUNT.length + Object.keys(CHECKED).length, 'a tool is listed in two classes');
    for (const name of names) assert.equal(classify(name), EXPECTED.get(name), name);
    assert.deepEqual(names.slice().sort(), [...EXPECTED.keys()].sort(), 'EXPECTED lists a tool nobody registers');
    for (const set of [READ_TOOLS, ACCOUNT_TOOLS, CHART_TOOLS, PINE_SAVE_TOOLS])
      for (const name of set) assert.ok(original.has(name), `${name} is not registered by any tool group`);
    for (const name of PINE_SAVE_TOOLS) assert.equal(classify(name), 'checked', name);
    for (const name of Object.keys(GUARD_TOOLS)) assert.ok(!original.has(name), `${name} is reserved for the guard`);
  });

  it('read and account tools keep their schema; checked tools add optional layout_id and user_approved', () => {
    const { registered, original } = recordGuarded();
    for (const [name, { schema }] of original) {
      const r = registered.get(name);
      assert.ok(!r.description.endsWith(DISABLED_MARK), name);
      if (classify(name) === 'checked') {
        assert.ok(r.description.endsWith(CHECKED_NOTE), name);
        assert.deepEqual(Object.keys(r.schema).sort(), [...Object.keys(schema), 'layout_id', 'user_approved'].sort(), name);
        assert.equal(r.schema.layout_id.safeParse(undefined).success, true, `${name}: layout_id is optional`);
      } else {
        assert.equal(r.schema, schema, name);
      }
    }
  });

  it('an unreviewed tool is disabled and never reaches its handler', async () => {
    const handlers = new Map();
    const server = { tool: (n, d, sc, h) => handlers.set(n, h) };
    protectRegistrations(server, { z, connect: noConnect, root });
    let calls = 0;
    server.tool('new_future_writer', 'x', {}, async () => { calls++; return { content: [] }; });
    const r = await handlers.get('new_future_writer')({});
    assert.equal(r.isError, true);
    assert.match(r.content[0].text, /UNSAFE_OPERATION_DISABLED/);
    assert.equal(calls, 0);
  });

  it('refuses registrations that could slip past the guard', () => {
    const server = { tool: () => {}, registerTool: () => assert.fail('bypassed') };
    protectRegistrations(server, { z, connect: noConnect });
    assert.throws(() => server.registerTool('sneaky', {}, async () => {}), /UNSUPPORTED_REGISTRATION/);
    assert.throws(() => server.tool('sneaky', {}, async () => {}), /UNSUPPORTED_REGISTRATION/);
    assert.throws(() => server.tool('sneaky', 'd', {}, {}, async () => {}), /UNSUPPORTED_REGISTRATION/);
    assert.throws(() => server.tool('study_inputs_get', 'd', {}, async () => {}), /RESERVED_TOOL_NAME/);
    assert.throws(() => server.tool('draw_shape', 'd', { layout_id: z.string() }, async () => {}), /already has layout_id/);
  });

  it('the classification table in docs/LAYOUT_SAFETY.md matches the code', () => {
    const doc = readFileSync(join(REPO, 'docs', 'LAYOUT_SAFETY.md'), 'utf8');
    const rows = new Map();
    for (const line of doc.split(/\r?\n/)) {
      const m = line.match(/^\|\s*`([a-z_]+)`\s*\|\s*(read|account|checked|disabled)\s*\|/);
      if (m) { assert.ok(!rows.has(m[1]), `${m[1]} appears twice in the doc table`); rows.set(m[1], m[2]); }
    }
    const all = [...EXPECTED.keys(), ...Object.keys(GUARD_TOOLS)];
    assert.deepEqual([...rows.keys()].sort(), all.sort());
    for (const name of all) assert.equal(rows.get(name), classify(name), name);
  });

  it('keeps its working files in the repository state folder, independent of the working directory', () => {
    assert.equal(ROOT, join(REPO, 'state'));
    assert.match(readFileSync(join(REPO, '.gitignore'), 'utf8'), /^state\/$/m);
  });
});

describe('checked tools (fake active tab)', () => {
  for (const [name, args] of Object.entries(CHECKED)) {
    it(name, async () => {
      let page = () => layoutState('prot0001');
      const active = fakeActive(() => page());
      const { registered, original } = recordGuarded({ active });
      const run = a => registered.get(name).handler(a);
      // Protected chart without approval: refused, the tool never runs, nothing was sent.
      let r = await run({ ...args });
      assert.equal(r.isError, true); assert.match(r.content[0].text, /PROTECTED_CHART_NEEDS_PERMISSION/);
      assert.equal(original.get(name).calls.length, 0); assert.deepEqual(active.log.writes, []); assert.deepEqual(active.log.pins, []);
      // Protected by name pattern: refused too.
      page = () => layoutState('free0009', undefined, 'DO_NOT_TOUCH copy');
      assert.match((await run({ ...args })).content[0].text, /PROTECTED_CHART_NEEDS_PERMISSION/);
      // The incident: the URL shows a free layout while a protected one is loaded.
      page = () => layoutState('prot0001', 'https://www.tradingview.com/chart/free0001/');
      assert.match((await run({ ...args })).content[0].text, /PROTECTED_CHART_NEEDS_PERMISSION/);
      assert.equal(original.get(name).calls.length, 0);
      // With approval: runs once with its own arguments, pinned to the checked tab, then unpinned.
      page = () => layoutState('prot0001');
      r = await run({ ...args, user_approved: true });
      assert.equal(r.content[0].text, 'ran');
      assert.deepEqual(original.get(name).calls, [args]);
      assert.deepEqual(original.get(name).pinned, ['tab1']);
      assert.equal(active.pinnedNow(), null);
      // Any other chart: runs with no extra parameters.
      page = () => layoutState('free0001');
      assert.equal((await run({ ...args })).content[0].text, 'ran');
      // An optional layout_id must match the loaded layout, even with approval.
      assert.match((await run({ ...args, layout_id: 'other001', user_approved: true })).content[0].text, /LAYOUT_ID_MISMATCH/);
      assert.equal(original.get(name).calls.length, 2);
    });
  }

  it('refuses when the tab, the loaded layout or its URL changes between the check and the run', async () => {
    const page = () => layoutState('free0001');
    const cases = [
      ['tab', fakeActive(page, { targets: ['tab1', 'tab2'] })],
      ['layout', fakeActive(page, { identity: () => ({ url: page().url, uid: 'prot0001' }) })],
      ['url', fakeActive(page, { identity: () => ({ url: 'https://www.tradingview.com/chart/prot0001/', uid: 'free0001' }) })],
    ];
    for (const [label, active] of cases) {
      const { registered, original } = recordGuarded({ active });
      const r = await registered.get('draw_clear').handler({ user_approved: true });
      assert.match(r.content[0].text, /ACTIVE_TAB_CHANGED/, label);
      assert.equal(original.get('draw_clear').calls.length, 0, label);
      assert.deepEqual(active.log.pins, [], label);
    }
  });

  it('unpins also when the tool throws', async () => {
    const active = fakeActive(() => layoutState('free0001'));
    const { registered, original } = recordGuarded({ active });
    original.get('draw_clear').impl = () => { throw new Error('boom'); };
    await assert.rejects(registered.get('draw_clear').handler({}), /boom/);
    assert.deepEqual(active.log.pins, ['tab1']); assert.equal(active.log.unpins, 1); assert.equal(active.pinnedNow(), null);
  });

  it('runs one tool at a time: the next check waits until the running tool finished', async () => {
    const active = fakeActive(() => layoutState('free0001'));
    const { registered, original } = recordGuarded({ active });
    let release, started;
    const running = new Promise(r => { started = r; });
    original.get('draw_clear').impl = () => new Promise(r => { release = () => r({ content: [{ type: 'text', text: 'ran' }] }); started(); });
    const first = registered.get('draw_clear').handler({});
    await running; // the first tool is running
    const second = registered.get('draw_shape').handler({ ...CHECKED.draw_shape });
    // Without the queue the second check would read the layout within this time.
    await new Promise(r => setTimeout(r, 200));
    assert.equal(active.log.snapshots, 1, 'the second check ran while the first tool was still running');
    assert.equal(active.pinnedNow(), 'tab1');
    release();
    assert.equal((await first).content[0].text, 'ran');
    assert.equal((await second).content[0].text, 'ran');
    assert.equal(active.log.snapshots, 2);
  });

  it('without a shared connection checked tools refuse', async () => {
    const { registered, original } = recordGuarded();
    const r = await registered.get('draw_clear').handler({});
    assert.match(r.content[0].text, /ACTIVE_CONNECTION_UNAVAILABLE/);
    assert.equal(original.get('draw_clear').calls.length, 0);
  });

  describe('Pine saves', () => {
    const study = { id: 'st', type: 'Study', state: { inputs: { pineId: 'USER;test' } } };
    const withScript = uid => { const l = layoutState(uid); l.state.charts[0].panes[0].sources.push(study); return l; };
    // Open tabs given as {id: layout | Error}; only read-only snapshots are allowed.
    const tabsWith = pages => ({
      listTargets: async () => Object.entries(pages).map(([id, l]) => ({ id, type: 'page', url: l instanceof Error ? `https://www.tradingview.com/chart/${id}/` : l.url })),
      connect: async id => ({ close: async () => {}, Runtime: { evaluate: async ({ expression }) => {
        assert.equal(expression, SNAPSHOT, 'only read the other tabs');
        if (pages[id] instanceof Error) throw pages[id];
        return { result: { value: structuredClone(pages[id]) } };
      } } }),
    });
    const bound = { title: 'My script', ids: ['USER;test'] };

    it('refuse when an open protected chart uses the script; approved, they run and report it', async () => {
      const deps = tabsWith({ cur: withScript('free0001'), p: withScript('prot0001'), f: withScript('free0002') });
      const active = fakeActive(() => withScript('free0001'), { editor: bound });
      const { registered, original } = recordGuarded({ active, ...deps });
      for (const name of PINE_SAVE_TOOLS) {
        const r = await registered.get(name).handler({});
        assert.match(r.content[0].text, /PINE_SCRIPT_ON_PROTECTED_CHARTS.*\(prot0001\).*cannot be checked/, name);
        assert.doesNotMatch(r.content[0].text, /free000/, name);
        assert.equal(original.get(name).calls.length, 0, name);
        const ok = await registered.get(name).handler({ user_approved: true });
        assert.equal(ok.content[0].text, 'ran', name);
        assert.deepEqual(guardNote(ok).also_updates_open_protected_charts, ['"Chart prot0001" (prot0001)'], name);
      }
    });

    it('free charts using the script, or an untitled script, need nothing and report nothing', async () => {
      for (const editor of [undefined, bound]) {
        const deps = tabsWith({ cur: withScript('free0001'), f: withScript('free0002') });
        const active = fakeActive(() => withScript('free0001'), editor ? { editor } : {});
        const { registered } = recordGuarded({ active, ...deps });
        const r = await registered.get('pine_save').handler({});
        assert.equal(r.content[0].text, 'ran');
        assert.equal(r.content.length, 1, 'nothing to report');
      }
    });

    it('when the script or a tab cannot be checked, they run and say so', async () => {
      for (const [label, editor, pages] of [
        ['no editor', { title: null, ids: [] }, {}],
        ['lookup failed', { title: 'My script', ids: [], error: 'HTTP 500' }, {}],
        ['no match', { title: 'My script', ids: [] }, {}],
        ['editor unreadable', () => { throw new Error('evaluate failed'); }, {}],
        ['tab unreadable', bound, { dead: new Error('renderer gone') }],
      ]) {
        const active = fakeActive(() => layoutState('free0001'), { editor });
        const { registered, original } = recordGuarded({ active, ...tabsWith(pages) });
        const r = await registered.get('pine_save').handler({});
        assert.equal(r.content[0].text, 'ran', label);
        assert.equal(original.get('pine_save').calls.length, 1, label);
        assert.ok(guardNote(r).could_not_check, label);
      }
    });
  });
});

describe('account tools (fake active tab)', () => {
  it('run without layout_id or approval, after following the active tab', async () => {
    const active = fakeActive(() => layoutState('prot0001'));
    const { registered, original } = recordGuarded({ active });
    for (const name of ACCOUNT) {
      const r = await registered.get(name).handler({});
      assert.equal(r.content[0].text, 'ran', name);
      assert.equal(original.get(name).calls.length, 1, name);
    }
    assert.equal(active.log.follows, ACCOUNT.length);
    assert.equal(active.log.snapshots, 0);
    assert.deepEqual(active.log.pins, []);
  });
});

describe('layout guard on a real MCP server (zod v4, in memory)', () => {
  async function connected({ connect = noConnect, active } = {}) {
    const server = new McpServer({ name: 'guard-test', version: '0.0.0' });
    registerPineDevelopment(server, { z, connect, root, listTargets: async () => assert.fail('listed targets'), bool: booleanParam });
    protectRegistrations(server, { z, connect, root, active, bool: booleanParam });
    for (const register of GROUPS) register(server);
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'guard-test-client', version: '0.0.0' });
    await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
    return client;
  }

  it('lists every tool with its class and the guard tools; none is disabled', async () => {
    const client = await connected();
    const { tools } = await client.listTools();
    const byName = new Map(tools.map(t => [t.name, t]));
    assert.equal(tools.length, EXPECTED.size + Object.keys(GUARD_TOOLS).length);
    for (const t of tools) assert.ok(!t.description.endsWith(DISABLED_MARK), t.name);
    for (const [name, cls] of EXPECTED) {
      const t = byName.get(name);
      if (cls === 'checked') {
        assert.ok(t.inputSchema.properties.layout_id && t.inputSchema.properties.user_approved, name);
        assert.ok(!(t.inputSchema.required || []).includes('layout_id'), `${name}: layout_id is optional`);
      } else {
        assert.ok(!t.inputSchema.properties?.user_approved, name);
      }
    }
    await client.close();
  });

  it('a protected chart is refused through the protocol without approval', async () => {
    const active = fakeActive(() => layoutState('prot0001'));
    const client = await connected({ active });
    const r = await client.callTool({ name: 'draw_clear', arguments: {} });
    assert.equal(r.isError, true);
    assert.match(r.content[0].text, /PROTECTED_CHART_NEEDS_PERMISSION/);
    const junk = await client.callTool({ name: 'chart_set_symbol', arguments: { symbol: 'X', user_approved: 'yes' } });
    assert.equal(junk.isError, true);
    assert.deepEqual(active.log.writes, []);
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
      for (const t of tools) assert.ok(!t.description.endsWith(DISABLED_MARK), t.name);
      for (const name of Object.keys(CHECKED)) assert.ok(byName.get(name).description.endsWith(CHECKED_NOTE), name);
    } finally {
      child.kill();
    }
  });
});
