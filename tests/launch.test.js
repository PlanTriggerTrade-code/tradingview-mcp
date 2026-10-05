/**
 * Tests for launch() in src/core/health.js.
 * Covers: no-op when the debug port is already open, the Microsoft Store
 * (MSIX) path via the COM-activation launcher, the opt-in local-copy
 * fallback, classic installer launches, and spawn failure handling.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { launch } from '../src/core/health.js';

const MSIX_DIR = 'C:\\Program Files\\WindowsApps\\TradingView.Desktop_3.1.0.7818_x64__n534cwy3pjxzj';
const MSIX_EXE = `${MSIX_DIR}\\TradingView.exe`;
const LOCAL_COPY_EXE = `${process.env.LOCALAPPDATA || ''}\\tradingview-mcp\\TradingView.Desktop_3.1.0.7818_x64__n534cwy3pjxzj\\TradingView.exe`;
const CDP_VERSION = JSON.stringify({ Browser: 'Chrome/140', 'User-Agent': 'TVDesktop/3.1.0' });

// ── Mock helpers ─────────────────────────────────────────────────────────

function mockChild({ failWith } = {}) {
  const child = new EventEmitter();
  child.pid = 12345;
  child.unref = () => {};
  if (failWith) queueMicrotask(() => child.emit('error', Object.assign(new Error(failWith), { code: failWith })));
  return child;
}

/**
 * _deps simulating a win32 machine with only the Microsoft Store build.
 *   storeCode    — exit code of the COM launcher script (0 ready, 1 not installed, 2 no port, 3 running w/o port)
 *   cdpUpAtStart — the debug port is already open before launch()
 *   copyBinds    — the debug port opens after spawning the local copy
 *   copyExists   — local copy already present
 */
function msixDeps({ storeCode = 0, cdpUpAtStart = false, copyBinds = true, copyExists = false } = {}) {
  const state = { spawned: [], spawnEnv: [], copies: [], removed: [], killed: 0, storeCalls: [], cdpUp: cdpUpAtStart };
  const deps = {
    existsSync: (p) => {
      if (p === MSIX_EXE) return true;
      if (p.includes('tradingview-mcp')) return copyExists || state.copies.length > 0;
      return false;
    },
    execSync: (cmd) => {
      if (cmd.includes('Get-AppxPackage')) return `${MSIX_DIR}\n`;
      if (cmd.includes('taskkill')) { state.killed++; return ''; }
      throw new Error(`unexpected execSync: ${cmd}`);
    },
    runStoreLauncher: (opts) => {
      state.storeCalls.push(opts);
      if (storeCode === 0) state.cdpUp = true;
      return { code: storeCode, output: `exit ${storeCode}` };
    },
    spawn: (exe, args, opts) => {
      state.spawned.push(exe);
      state.spawnEnv.push(opts?.env);
      if (copyBinds && exe.includes('tradingview-mcp')) state.cdpUp = true;
      return mockChild();
    },
    cpSync: (src, dst) => { state.copies.push({ src, dst }); },
    rmSync: (p) => { state.removed.push(p); },
    readdirSync: () => ['TradingView.Desktop_3.0.0.7652_x64__n534cwy3pjxzj'],
    delay: async () => {},
    probeCdp: async () => (state.cdpUp ? CDP_VERSION : null),
  };
  return { deps, state };
}

// launch() only takes the Windows code paths on win32; skip elsewhere.
const onWindows = process.platform === 'win32';

describe('launch() — debug port already open', () => {
  it('returns already_running without killing or spawning anything', async () => {
    const { deps, state } = msixDeps({ cdpUpAtStart: true });
    const result = await launch({ _deps: deps });
    assert.equal(result.success, true);
    assert.equal(result.already_running, true);
    assert.equal(result.cdp_url, 'http://127.0.0.1:9222');
    assert.equal(state.killed, 0);
    assert.equal(state.storeCalls.length, 0);
    assert.equal(state.spawned.length, 0);
  });
});

describe('launch() — Microsoft Store (MSIX) build', { skip: !onWindows }, () => {
  it('launches through the COM launcher without spawning or copying', async () => {
    const { deps, state } = msixDeps({ storeCode: 0 });
    const result = await launch({ _deps: deps });
    assert.equal(result.success, true);
    assert.equal(result.launch_method, 'com_activation');
    assert.equal(result.cdp_url, 'http://127.0.0.1:9222');
    assert.equal(state.spawned.length, 0);
    assert.equal(state.copies.length, 0);
    assert.deepEqual(state.storeCalls, [{ cdpPort: 9222, killFirst: true }]);
  });

  it('passes kill_existing:false through to the launcher', async () => {
    const { deps, state } = msixDeps({ storeCode: 0 });
    await launch({ kill_existing: false, _deps: deps });
    assert.equal(state.storeCalls[0].killFirst, false);
  });

  it('reports TradingView running without the port when told not to kill it', async () => {
    const { deps } = msixDeps({ storeCode: 3 });
    await assert.rejects(() => launch({ kill_existing: false, _deps: deps }), /running without the debug port/);
  });

  it('does not copy the package unless allow_local_copy is set', async () => {
    const { deps, state } = msixDeps({ storeCode: 2 });
    await assert.rejects(() => launch({ _deps: deps }), /allow_local_copy/);
    assert.equal(state.copies.length, 0);
    assert.equal(state.spawned.length, 0);
  });

  it('with allow_local_copy, falls back to a local copy of the package', async () => {
    const { deps, state } = msixDeps({ storeCode: 2 });
    const result = await launch({ allow_local_copy: true, _deps: deps });
    assert.equal(result.success, true);
    assert.equal(result.msix_local_copy, true);
    assert.equal(result.binary, LOCAL_COPY_EXE);
    assert.equal(state.copies.length, 1);
    assert.match(state.copies[0].src, /WindowsApps/);
    // a stale cached copy of another release is cleaned up first
    assert.equal(state.removed.length, 1);
    assert.match(state.removed[0], /3\.0\.0\.7652/);
    // the port-less instance is closed before relaunching from the copy
    assert.ok(state.killed >= 1);
    assert.deepEqual(state.spawned, [LOCAL_COPY_EXE]);
  });

  it('reuses an existing local copy without re-copying', async () => {
    const { deps, state } = msixDeps({ storeCode: 2, copyExists: true });
    const result = await launch({ allow_local_copy: true, _deps: deps });
    assert.equal(result.msix_local_copy, true);
    assert.equal(state.copies.length, 0);
  });

  it('returns a cdp_ready:false warning when the local copy never opens the port', async () => {
    const { deps } = msixDeps({ storeCode: 2, copyBinds: false });
    const result = await launch({ allow_local_copy: true, _deps: deps });
    assert.equal(result.success, true);
    assert.equal(result.cdp_ready, false);
    assert.ok(result.warning);
  });

  it('falls through to "not found" when the Store build is not installed', async () => {
    const { deps } = msixDeps({ storeCode: 1 });
    deps.existsSync = () => false;
    deps.execSync = () => { throw new Error('not found'); };
    await assert.rejects(() => launch({ _deps: deps }), /TradingView not found/);
  });
});

describe('launch() — classic install path', { skip: !onWindows }, () => {
  const classicExe = `${process.env.LOCALAPPDATA}\\TradingView\\TradingView.exe`;
  const classicDeps = (spawn) => {
    const state = { spawned: [], env: null, cdpUp: false };
    return {
      state,
      deps: {
        existsSync: (p) => p === classicExe,
        execSync: (cmd) => { if (cmd.includes('taskkill')) return ''; throw new Error(`unexpected: ${cmd}`); },
        runStoreLauncher: () => { throw new Error('should not use the Store launcher'); },
        spawn: spawn || ((exe, args, opts) => { state.spawned.push(exe); state.env = opts?.env; state.cdpUp = true; return mockChild(); }),
        cpSync: () => { throw new Error('should not copy'); },
        rmSync: () => {},
        readdirSync: () => [],
        delay: async () => {},
        probeCdp: async () => (state.cdpUp ? CDP_VERSION : null),
      },
    };
  };

  it('launches the installer build directly', async () => {
    const { deps, state } = classicDeps();
    const result = await launch({ _deps: deps });
    assert.equal(result.success, true);
    assert.equal(result.binary, classicExe);
    assert.equal(result.msix_local_copy, undefined);
    assert.deepEqual(state.spawned, [classicExe]);
  });

  it('strips ELECTRON_RUN_AS_NODE from the child environment', async () => {
    const before = process.env.ELECTRON_RUN_AS_NODE;
    process.env.ELECTRON_RUN_AS_NODE = '1';
    try {
      const { deps, state } = classicDeps();
      await launch({ _deps: deps });
      assert.ok(state.env, 'spawn received an env');
      assert.equal(state.env.ELECTRON_RUN_AS_NODE, undefined);
    } finally {
      if (before === undefined) delete process.env.ELECTRON_RUN_AS_NODE; else process.env.ELECTRON_RUN_AS_NODE = before;
    }
  });

  it('reports a spawn that throws synchronously (EPERM) instead of crashing', async () => {
    const { deps } = classicDeps(() => { throw Object.assign(new Error('spawn EPERM'), { code: 'EPERM' }); });
    await assert.rejects(() => launch({ _deps: deps }), /Failed to start .*EPERM/);
  });

  it('reports an asynchronous spawn error (EACCES) instead of crashing', async () => {
    const { deps } = classicDeps(() => mockChild({ failWith: 'EACCES' }));
    await assert.rejects(() => launch({ _deps: deps }), /Failed to start .*EACCES/);
  });
});
