/**
 * Core health/discovery/launch logic.
 */
import { getClient, getTargetInfo, evaluate, CDP_HOST, CDP_PORT } from '../connection.js';
import { existsSync, cpSync, rmSync, readdirSync } from 'fs';
import { execSync, execFileSync, spawn, spawnSync } from 'child_process';
import { dirname, basename, join } from 'path';
import { fileURLToPath } from 'url';

const STORE_LAUNCHER = fileURLToPath(new URL('../../scripts/launch_tv_debug_store.ps1', import.meta.url));

export async function healthCheck() {
  await getClient();
  const target = await getTargetInfo();

  const state = await evaluate(`
    (function() {
      var result = { url: window.location.href, title: document.title };
      try {
        var chart = window.TradingViewApi._activeChartWidgetWV.value();
        result.symbol = chart.symbol();
        result.resolution = chart.resolution();
        result.chartType = chart.chartType();
        result.apiAvailable = true;
      } catch(e) {
        result.symbol = 'unknown';
        result.resolution = 'unknown';
        result.chartType = null;
        result.apiAvailable = false;
        result.apiError = e.message;
      }
      return result;
    })()
  `);

  return {
    success: true,
    cdp_connected: true,
    target_id: target.id,
    target_url: target.url,
    target_title: target.title,
    chart_symbol: state?.symbol || 'unknown',
    chart_resolution: state?.resolution || 'unknown',
    chart_type: state?.chartType ?? null,
    api_available: state?.apiAvailable ?? false,
  };
}

export async function discover() {
  const paths = await evaluate(`
    (function() {
      var results = {};
      try {
        var chart = window.TradingViewApi._activeChartWidgetWV.value();
        var methods = [];
        for (var k in chart) { if (typeof chart[k] === 'function') methods.push(k); }
        results.chartApi = { available: true, path: 'window.TradingViewApi._activeChartWidgetWV.value()', methodCount: methods.length, methods: methods.slice(0, 50) };
      } catch(e) { results.chartApi = { available: false, error: e.message }; }
      try {
        var col = window.TradingViewApi._chartWidgetCollection;
        var colMethods = [];
        for (var k in col) { if (typeof col[k] === 'function') colMethods.push(k); }
        results.chartWidgetCollection = { available: !!col, path: 'window.TradingViewApi._chartWidgetCollection', methodCount: colMethods.length, methods: colMethods.slice(0, 30) };
      } catch(e) { results.chartWidgetCollection = { available: false, error: e.message }; }
      try {
        var ws = window.ChartApiInstance;
        var wsMethods = [];
        for (var k in ws) { if (typeof ws[k] === 'function') wsMethods.push(k); }
        results.chartApiInstance = { available: !!ws, path: 'window.ChartApiInstance', methodCount: wsMethods.length, methods: wsMethods.slice(0, 30) };
      } catch(e) { results.chartApiInstance = { available: false, error: e.message }; }
      try {
        var bwb = window.TradingView && window.TradingView.bottomWidgetBar;
        var bwbMethods = [];
        if (bwb) { for (var k in bwb) { if (typeof bwb[k] === 'function') bwbMethods.push(k); } }
        results.bottomWidgetBar = { available: !!bwb, path: 'window.TradingView.bottomWidgetBar', methodCount: bwbMethods.length, methods: bwbMethods.slice(0, 20) };
      } catch(e) { results.bottomWidgetBar = { available: false, error: e.message }; }
      try {
        var replay = window.TradingViewApi._replayApi;
        results.replayApi = { available: !!replay, path: 'window.TradingViewApi._replayApi' };
      } catch(e) { results.replayApi = { available: false, error: e.message }; }
      try {
        var alerts = window.TradingViewApi._alertService;
        results.alertService = { available: !!alerts, path: 'window.TradingViewApi._alertService' };
      } catch(e) { results.alertService = { available: false, error: e.message }; }
      return results;
    })()
  `);

  const available = Object.values(paths).filter(v => v.available).length;
  const total = Object.keys(paths).length;

  return { success: true, apis_available: available, apis_total: total, apis: paths };
}

export async function uiState() {
  const state = await evaluate(`
    (function() {
      var ui = {};
      var bottom = document.querySelector('[class*="layout__area--bottom"]');
      ui.bottom_panel = { open: !!(bottom && bottom.offsetHeight > 50), height: bottom ? bottom.offsetHeight : 0 };
      var right = document.querySelector('[class*="layout__area--right"]');
      ui.right_panel = { open: !!(right && right.offsetWidth > 50), width: right ? right.offsetWidth : 0 };
      var monacoEl = document.querySelector('.monaco-editor.pine-editor-monaco');
      ui.pine_editor = { open: !!monacoEl, width: monacoEl ? monacoEl.offsetWidth : 0, height: monacoEl ? monacoEl.offsetHeight : 0 };
      var stratPanel = document.querySelector('[data-name="backtesting"]') || document.querySelector('[class*="strategyReport"]');
      ui.strategy_tester = { open: !!(stratPanel && stratPanel.offsetParent) };
      var widgetbar = document.querySelector('[data-name="widgetbar-wrap"]');
      ui.widgetbar = { open: !!(widgetbar && widgetbar.offsetWidth > 50) };
      ui.buttons = {};
      var btns = document.querySelectorAll('button');
      var seen = {};
      for (var i = 0; i < btns.length; i++) {
        var b = btns[i];
        if (b.offsetParent === null || b.offsetWidth < 15) continue;
        var text = b.textContent.trim();
        var aria = b.getAttribute('aria-label') || '';
        var dn = b.getAttribute('data-name') || '';
        var label = text || aria || dn;
        if (!label || label.length > 60) continue;
        var key = label.replace(/[^a-zA-Z0-9 ]/g, '').substring(0, 40);
        if (seen[key]) continue;
        seen[key] = true;
        var rect = b.getBoundingClientRect();
        var region = 'other';
        if (rect.y < 50) region = 'top_bar';
        else if (rect.y < 90 && rect.x < 650) region = 'toolbar';
        else if (rect.x < 45) region = 'left_sidebar';
        else if (rect.x > 650 && rect.y < 100) region = 'pine_header';
        else if (rect.y > 750) region = 'bottom_bar';
        if (!ui.buttons[region]) ui.buttons[region] = [];
        ui.buttons[region].push({ label: label.substring(0, 40), disabled: b.disabled, x: Math.round(rect.x), y: Math.round(rect.y) });
      }
      ui.key_buttons = {};
      var keyLabels = {
        'add_to_chart': /add to chart/i, 'save_and_add': /save and add/i,
        'update_on_chart': /update on chart/i, 'save': /^Save(Save)?$/,
        'saved': /^Saved/, 'publish_script': /publish script/i,
        'compile_errors': /error/i, 'unsaved_version': /unsaved version/i,
      };
      for (var i = 0; i < btns.length; i++) {
        var b = btns[i];
        if (b.offsetParent === null) continue;
        var text = b.textContent.trim();
        for (var k in keyLabels) {
          if (keyLabels[k].test(text)) {
            ui.key_buttons[k] = { text: text.substring(0, 40), disabled: b.disabled, visible: b.offsetWidth > 0 };
          }
        }
      }
      try {
        var chart = window.TradingViewApi._activeChartWidgetWV.value();
        ui.chart = { symbol: chart.symbol(), resolution: chart.resolution(), chartType: chart.chartType(), study_count: chart.getAllStudies().length };
      } catch(e) { ui.chart = { error: e.message }; }
      try {
        var replay = window.TradingViewApi._replayApi;
        function unwrap(v) { return (v && typeof v === 'object' && typeof v.value === 'function') ? v.value() : v; }
        ui.replay = { available: unwrap(replay.isReplayAvailable()), started: unwrap(replay.isReplayStarted()) };
      } catch(e) { ui.replay = { error: e.message }; }
      return ui;
    })()
  `);

  return { success: true, ...state };
}

function _resolveLaunchDeps(deps) {
  return {
    spawn: deps?.spawn || spawn,
    execSync: deps?.execSync || execSync,
    execFileSync: deps?.execFileSync || execFileSync,
    existsSync: deps?.existsSync || existsSync,
    cpSync: deps?.cpSync || cpSync,
    rmSync: deps?.rmSync || rmSync,
    readdirSync: deps?.readdirSync || readdirSync,
    delay: deps?.delay || ((ms) => new Promise((r) => setTimeout(r, ms))),
    probeCdp: deps?.probeCdp || _probeCdp,
    runStoreLauncher: deps?.runStoreLauncher || _runStoreLauncher,
  };
}

// An MCP host built on Electron (VS Code, some desktop apps) can leak
// ELECTRON_RUN_AS_NODE into our environment; TradingView (also Electron) then
// starts as plain Node and exits immediately.
function _launchEnv() {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  return env;
}

/**
 * Launch the Microsoft Store (MSIX) build through scripts/launch_tv_debug_store.ps1,
 * which activates the app via Windows' IApplicationActivationManager COM API.
 * Store apps can't be spawned directly (WindowsApps is ACL-protected, EACCES /
 * EPERM) and Start-menu launches drop command-line flags; COM activation passes
 * --remote-debugging-port through and keeps the user's normal profile and login.
 * Script exit codes: 0 ready, 1 not installed, 2 port never opened,
 * 3 running without the port (NoKill), 4 activation failed. -1: script missing.
 */
function _runStoreLauncher({ cdpPort, killFirst }) {
  if (!existsSync(STORE_LAUNCHER)) return { code: -1, output: 'store launcher script not found' };
  const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', STORE_LAUNCHER, '-Port', String(cdpPort)];
  if (!killFirst) args.push('-NoKill');
  const res = spawnSync('powershell.exe', args, { timeout: 90000, encoding: 'utf8', windowsHide: true, env: _launchEnv() });
  return { code: res.status ?? -1, output: `${res.stdout || ''}${res.stderr || ''}`.trim() || res.error?.message || '' };
}

async function _probeCdp(cdpPort) {
  const http = await import('http');
  return new Promise((resolve) => {
    const req = http.get(`http://${CDP_HOST}:${cdpPort}/json/version`, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => resolve(data));
    });
    req.on('error', () => resolve(null));
    req.setTimeout(2000, () => { req.destroy(); resolve(null); });
  });
}

function _spawnDetached(spawnFn, exe, args) {
  let child;
  try {
    child = spawnFn(exe, args, { detached: true, stdio: 'ignore', env: _launchEnv() });
  } catch (e) {
    // Some failures (EPERM on WindowsApps) throw synchronously instead of
    // emitting 'error'; surface them the same way.
    return { pid: null, syncError: e.code || e.message || 'spawn error', on() {}, off() {}, unref() {} };
  }
  child.unref();
  return child;
}

// Resolves once with an error string if the process fails/exits within graceMs,
// or with null if it survives that long.
function _spawnFailedEarly(child, graceMs = 1500) {
  if (child.syncError) return Promise.resolve(child.syncError);
  return new Promise((resolve) => {
    const timer = setTimeout(() => { cleanup(); resolve(null); }, graceMs);
    const onError = (e) => { cleanup(); resolve(e.code || e.message || 'spawn error'); };
    const onExit = (code) => { cleanup(); resolve(`exited immediately (code ${code})`); };
    const cleanup = () => { clearTimeout(timer); child.off?.('error', onError); child.off?.('exit', onExit); };
    child.on('error', onError);
    child.on('exit', onExit);
  });
}

async function _waitForCdp({ cdpPort, attempts, delay, probeCdp }) {
  for (let i = 0; i < attempts; i++) {
    await delay(1000);
    try {
      const ready = await probeCdp(cdpPort);
      if (ready) return JSON.parse(ready);
    } catch { /* retry */ }
  }
  return null;
}

/**
 * Some Windows builds block CDP for MSIX-packaged apps: direct spawn from
 * WindowsApps gets EACCES, and even COM activation passes the flag but the
 * debug port never binds (issues #42, #75, #128). Running the same files from
 * a plain directory outside WindowsApps works and keeps the user's session,
 * so copy the package into LOCALAPPDATA once per version and launch that.
 */
function _copyMsixPackageLocal(tvPath, { cpSync, rmSync, readdirSync, existsSync }) {
  const srcDir = dirname(tvPath);
  const pkgName = basename(srcDir);
  const cacheRoot = join(process.env.LOCALAPPDATA || '', 'tradingview-mcp');
  const dstDir = join(cacheRoot, pkgName);
  const dstExe = join(dstDir, 'TradingView.exe');
  if (!existsSync(dstExe)) {
    try {
      for (const entry of readdirSync(cacheRoot)) {
        if (entry !== pkgName && /^TradingView\./i.test(entry)) {
          rmSync(join(cacheRoot, entry), { recursive: true, force: true });
        }
      }
    } catch { /* cache root may not exist yet */ }
    cpSync(srcDir, dstDir, { recursive: true });
  }
  return dstExe;
}

export async function launch({ port, kill_existing, allow_local_copy, _deps } = {}) {
  const deps = _resolveLaunchDeps(_deps);
  const cdpPort = port || CDP_PORT;
  const killFirst = kill_existing !== false;
  const allowLocalCopy = allow_local_copy === true || process.env.TV_MSIX_LOCAL_COPY === '1';
  const platform = process.platform;

  // #542: if TradingView is already serving the debug port, there's nothing to
  // do. Killing it would only throw away the user's session.
  const existing = await deps.probeCdp(cdpPort);
  if (existing) {
    let info = {};
    try { info = JSON.parse(existing); } catch { /* not JSON */ }
    return {
      success: true, already_running: true, platform, cdp_port: cdpPort,
      cdp_url: `http://${CDP_HOST}:${cdpPort}`, browser: info.Browser, user_agent: info['User-Agent'],
    };
  }

  const pathMap = {
    darwin: [
      '/Applications/TradingView.app/Contents/MacOS/TradingView',
      `${process.env.HOME}/Applications/TradingView.app/Contents/MacOS/TradingView`,
    ],
    win32: [
      `${process.env.LOCALAPPDATA}\\TradingView\\TradingView.exe`,
      `${process.env.PROGRAMFILES}\\TradingView\\TradingView.exe`,
      `${process.env['PROGRAMFILES(X86)']}\\TradingView\\TradingView.exe`,
    ],
    linux: [
      '/opt/TradingView/tradingview',
      '/opt/TradingView/TradingView',
      `${process.env.HOME}/.local/share/TradingView/TradingView`,
      '/usr/bin/tradingview',
      '/snap/tradingview/current/tradingview',
    ],
  };

  let tvPath = null;
  const candidates = pathMap[platform] || pathMap.linux;
  for (const p of candidates) {
    if (p && deps.existsSync(p)) { tvPath = p; break; }
  }

  let msixExe = null;
  if (!tvPath && platform === 'win32') {
    // Microsoft Store (MSIX) install, the only Windows distribution of current
    // TradingView Desktop builds. Launch through COM activation first.
    const store = await deps.runStoreLauncher({ cdpPort, killFirst });
    if (store.code === 0) {
      const ready = await deps.probeCdp(cdpPort);
      let info = {};
      try { info = JSON.parse(ready); } catch { /* still a success: the script saw the port */ }
      return {
        success: true, platform, binary: 'Microsoft Store (MSIX) TradingView', launch_method: 'com_activation',
        cdp_port: cdpPort, cdp_url: `http://${CDP_HOST}:${cdpPort}`, browser: info.Browser, user_agent: info['User-Agent'],
      };
    }
    if (store.code === 3) {
      throw new Error('TradingView is running without the debug port. Close it, or call tv_launch with kill_existing: true (the default).');
    }
    if (store.code !== 1) {
      // Installed, but COM activation didn't produce a debug port (reported on
      // some builds, #42/#75/#128), or the launcher script is missing.
      if (!allowLocalCopy) {
        throw new Error(
          `Couldn't open the debug port on the Microsoft Store build (launcher exit ${store.code}: ${String(store.output).split('\n').pop()}). ` +
          'Retry with allow_local_copy: true to run TradingView from a copy of the package in %LOCALAPPDATA% ' +
          '(copies ~330MB once per version; the copy may start signed out, since Store apps keep their profile inside the package container).'
        );
      }
      // WindowsApps is ACL-restricted for enumeration, but Get-AppxPackage
      // reads InstallLocation without elevation.
      try {
        const ps = 'powershell -NoProfile -Command "(Get-AppxPackage -Name \'TradingView.Desktop\' -ErrorAction SilentlyContinue).InstallLocation"';
        const installDir = deps.execSync(ps, { timeout: 5000 }).toString().trim();
        if (installDir && deps.existsSync(`${installDir}\\TradingView.exe`)) msixExe = `${installDir}\\TradingView.exe`;
      } catch { /* ignore */ }
      if (!msixExe) throw new Error('Microsoft Store TradingView install location not found (Get-AppxPackage).');
      tvPath = msixExe;
    }
  }

  if (!tvPath) {
    try {
      const cmd = platform === 'win32' ? 'where TradingView.exe' : 'which tradingview';
      tvPath = deps.execSync(cmd, { timeout: 3000 }).toString().trim().split('\n')[0];
      if (tvPath && !deps.existsSync(tvPath)) tvPath = null;
    } catch { /* ignore */ }
  }

  if (!tvPath && platform === 'darwin') {
    try {
      const found = deps.execSync('mdfind "kMDItemFSName == TradingView.app" | head -1', { timeout: 5000 }).toString().trim();
      if (found) {
        const candidate = `${found}/Contents/MacOS/TradingView`;
        if (deps.existsSync(candidate)) tvPath = candidate;
      }
    } catch { /* ignore */ }
  }

  if (!tvPath) {
    throw new Error(`TradingView not found on ${platform}. Searched: ${candidates.join(', ')}. Launch manually with: /path/to/TradingView --remote-debugging-port=${cdpPort}`);
  }

  const killExisting = async () => {
    try {
      if (platform === 'win32') deps.execSync('taskkill /F /IM TradingView.exe', { timeout: 5000 });
      else deps.execSync('pkill -f TradingView', { timeout: 5000 });
      await deps.delay(1500);
    } catch { /* may not be running */ }
  };

  if (killFirst) await killExisting();

  const cdpArgs = [`--remote-debugging-port=${cdpPort}`];
  let child;
  let info = null;
  let usedLocalCopy = false;
  if (msixExe) {
    // Opt-in fallback: run the same files from a plain directory outside
    // WindowsApps (see _copyMsixPackageLocal).
    tvPath = _copyMsixPackageLocal(msixExe, deps);
    await killExisting();
    usedLocalCopy = true;
    child = _spawnDetached(deps.spawn, tvPath, cdpArgs);
  } else if (platform === 'darwin' && tvPath.includes('.app/')) {
    // Launch through `open` so launchd starts the app at normal foreground
    // QoS. A direct spawn() inherits this process's priority — when the MCP
    // runs under a background scheduler (launchd agent, cron), TradingView
    // comes up App-Napped (ps state SN) and macOS throttles and eventually
    // evicts its renderers. The CDP port keeps answering HTTP in that state
    // while every Runtime.evaluate hangs.
    const appPath = tvPath.replace(/\/Contents\/MacOS\/.*$/, '');
    deps.execFileSync('open', ['-a', appPath, '--args', ...cdpArgs], { timeout: 15000 });
    child = { pid: null };
  } else {
    child = _spawnDetached(deps.spawn, tvPath, cdpArgs);
  }
  // Listen for an early 'error'/'exit' (an unhandled 'error' event would crash
  // the server) and fail fast instead of polling a port that will never open.
  const earlyFailure = typeof child.on === 'function' ? await _spawnFailedEarly(child) : null;
  if (earlyFailure) throw new Error(`Failed to start ${tvPath}: ${earlyFailure}`);

  if (!info) {
    info = await _waitForCdp({ cdpPort, attempts: 15, delay: deps.delay, probeCdp: deps.probeCdp });
  }

  if (info) {
    return {
      success: true, platform, binary: tvPath, pid: child.pid,
      cdp_port: cdpPort, cdp_url: `http://${CDP_HOST}:${cdpPort}`,
      browser: info.Browser, user_agent: info['User-Agent'],
      ...(usedLocalCopy && { msix_local_copy: true }),
    };
  }

  return {
    success: true, platform, binary: tvPath, pid: child.pid, cdp_port: cdpPort, cdp_ready: false,
    ...(usedLocalCopy && { msix_local_copy: true }),
    warning: 'TradingView launched but CDP not responding yet. It may still be loading. Try tv_health_check in a few seconds.',
  };
}
