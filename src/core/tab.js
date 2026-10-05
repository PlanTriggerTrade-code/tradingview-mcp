/**
 * Core tab management logic.
 *
 * TradingView Desktop's tab bar lives in a separate Electron shell window
 * (app/window/index.html), not in the chart pages themselves. CDP-level
 * activation (/json/activate) and synthesized Ctrl+T/Ctrl+W key events do
 * not drive it (Electron accelerators don't fire from CDP input), so tab
 * switching/creation/closing click the shell window's DOM directly:
 * `.tabs-container .tab`, its close button, and `create-new-tab-button`.
 * (Approach from issue #155 and PR #163, verified on Desktop 3.1.0.)
 */
import CDP from 'chrome-remote-interface';
import { getClient, reconnectTo, PAGE_TAB_JS, CDP_HOST, CDP_PORT } from '../connection.js';

const TAB_BAR_JS = `Array.prototype.map.call(document.querySelectorAll('.tabs-container .tab'), function(el) {
  var n = el.querySelector('.layout-name'), s = el.querySelector('.symbol'), t = el.querySelector('.tab-title');
  return { key: el.id, active: el.classList.contains('active'), layout: n ? n.textContent.trim() : null,
           symbol: s ? s.textContent.trim() : null, title: (t || el).textContent.trim() };
})`;

/** Chart and new-tab page targets, each chart labelled with its layout name and symbol. */
async function describeTargets() {
  const resp = await fetch(`http://${CDP_HOST}:${CDP_PORT}/json/list`, { signal: AbortSignal.timeout(3000) });
  const targets = (await resp.json())
    .filter(t => t.type === 'page' && (/tradingview\.com\/chart/i.test(t.url) || t.title === 'New tab'));
  return Promise.all(targets.map(async (t) => {
    const isChart = /tradingview\.com\/chart/i.test(t.url);
    const d = { id: t.id, url: t.url, is_chart: isChart, chart_id: t.url.match(/\/chart\/([^/?]+)/)?.[1] || null, layout: null, symbol: null };
    if (isChart) {
      try { const v = await withTarget(t.id, (ev) => ev(PAGE_TAB_JS)); if (v) { d.layout = v.layout; d.symbol = v.symbol; } } catch { /* unresponsive tab */ }
    }
    return d;
  }));
}

const bare = (s) => String(s || '').split(':').pop().toUpperCase();

/**
 * List open tabs in the order shown in TradingView's tab bar, with the active
 * one flagged. Each tab-bar entry is matched to its page target by layout name
 * (symbol breaks ties), since chart pages don't expose the tab bar's ids.
 * Falls back to page-target order when there's no tab bar.
 */
export async function list() {
  const targets = await describeTargets();
  let bar = null;
  try { bar = await withShell((evalIn) => evalIn(TAB_BAR_JS)); } catch { /* no tab bar */ }

  if (!bar) {
    const tabs = targets.map((t, i) => ({ index: i, id: t.id, title: t.layout || 'New tab', layout: t.layout, symbol: t.symbol, url: t.url, chart_id: t.chart_id, is_chart: t.is_chart }));
    return { success: true, tab_count: tabs.length, tabs, note: 'Tab bar not found; listed in page-target order.' };
  }

  // Match by layout name first. Right after TradingView starts, the tab bar can
  // show an entry with only its symbol (no layout name yet); those are matched
  // afterwards by symbol, and only when exactly one page fits.
  const used = new Set();
  const isNewEntry = (b) => !b.layout && /^New tab$/i.test(b.title);
  const matched = bar.map((b) => {
    if (!isNewEntry(b) && !b.layout) return null;
    const pool = targets.filter(t => !used.has(t.id) && (isNewEntry(b) ? !t.is_chart : t.is_chart && t.layout === b.layout));
    const t = pool.find(x => bare(x.symbol) === bare(b.symbol)) || pool[0] || null;
    if (t) used.add(t.id);
    return t;
  });
  bar.forEach((b, i) => {
    if (matched[i] || isNewEntry(b) || !b.symbol) return;
    const pool = targets.filter(t => !used.has(t.id) && t.is_chart && bare(t.symbol) === bare(b.symbol));
    if (pool.length === 1) { matched[i] = pool[0]; used.add(pool[0].id); }
  });
  const tabs = bar.map((b, i) => {
    const isNew = isNewEntry(b);
    const t = matched[i];
    return {
      index: i,
      active: b.active,
      title: b.layout || b.title,
      layout: b.layout,
      symbol: t?.symbol || b.symbol,
      id: t?.id || null,
      chart_id: t?.chart_id || null,
      is_chart: !isNew,
      // After a restart TradingView only loads a tab's page once it's opened.
      loaded: !!t,
      tab_key: b.key,
    };
  });
  return { success: true, tab_count: tabs.length, active_index: tabs.findIndex(t => t.active), tabs };
}

/**
 * Run fn with a CDP client attached to the Electron shell window that owns
 * the tab bar. There can be several app/window/index.html targets; the shell
 * is the one whose DOM actually contains `.tabs-container .tab`.
 */
async function withShell(fn) {
  const resp = await fetch(`http://${CDP_HOST}:${CDP_PORT}/json/list`, { signal: AbortSignal.timeout(3000) });
  const targets = await resp.json();
  const candidates = targets.filter(t => t.type === 'page' && /\/window\/index\.html/i.test(t.url || ''));

  for (const cand of candidates) {
    let c = null;
    try {
      c = await CDP({ host: CDP_HOST, port: CDP_PORT, target: cand.id });
      const probe = await c.Runtime.evaluate({
        expression: `!!document.querySelector('.tabs-container .tab')`,
        returnByValue: true,
      });
      if (probe.result?.value) {
        const out = await fn(async (expression) => {
          const { result } = await c.Runtime.evaluate({ expression, returnByValue: true });
          return result?.value;
        });
        await c.close();
        return out;
      }
      await c.close();
    } catch {
      try { if (c) await c.close(); } catch { /* already gone */ }
    }
  }
  throw new Error('TradingView shell window (tab bar) not found. Is this TradingView Desktop with tabs?');
}

/** Find an open new-tab landing page target (shows the layout picker). */
async function findLandingTarget() {
  const resp = await fetch(`http://${CDP_HOST}:${CDP_PORT}/json/list`, { signal: AbortSignal.timeout(3000) });
  const targets = await resp.json();
  return targets.find(t => t.type === 'page' && t.title === 'New tab') || null;
}

/** Run fn with an eval helper attached to a specific target. */
async function withTarget(targetId, fn) {
  let c = null;
  try {
    c = await CDP({ host: CDP_HOST, port: CDP_PORT, target: targetId });
    return await fn(async (expression) => {
      const { result } = await c.Runtime.evaluate({ expression, returnByValue: true });
      return result?.value;
    });
  } finally {
    try { if (c) await c.close(); } catch { /* already gone */ }
  }
}

/**
 * Open a new chart tab by clicking the shell window's new-tab button.
 * With `layout`, also picks from the landing page's layout list:
 *   layout: 'new'    -> click "Create new layout" (blank chart, saved as Unnamed)
 *   layout: '<name>' -> open the saved layout whose title contains <name>
 * Reuses an already-open landing tab instead of opening another one.
 */
export async function newTab({ layout, name } = {}) {
  let landing = await findLandingTarget();
  let shellCounts = null;

  if (!landing) {
    shellCounts = await withShell(async (evalIn) => {
      const before = await evalIn(`document.querySelectorAll('.tabs-container .tab').length`);
      const clicked = await evalIn(`
        (function() {
          var btn = document.querySelector('[class*="create-new-tab"]');
          if (!btn) return false;
          btn.click();
          return true;
        })()
      `);
      if (!clicked) throw new Error('New-tab button not found in shell window.');
      await new Promise(r => setTimeout(r, 1500));
      const after = await evalIn(`document.querySelectorAll('.tabs-container .tab').length`);
      return { before, after };
    });
    landing = await findLandingTarget();
  }

  if (!layout) {
    const state = await list();
    return {
      success: shellCounts ? shellCounts.after > shellCounts.before : !!landing,
      action: 'new_tab_opened',
      note: 'Tab is on the layout picker. Call tab_new with layout: "new" or a saved layout name to open a chart in it.',
      ...state,
    };
  }

  if (!landing) throw new Error('New tab opened but its landing page target was not found.');

  // Snapshot existing chart targets so we can spot the one the pick creates.
  const beforeResp = await fetch(`http://${CDP_HOST}:${CDP_PORT}/json/list`, { signal: AbortSignal.timeout(3000) });
  const chartIdsBefore = new Set(
    (await beforeResp.json())
      .filter(t => t.type === 'page' && /tradingview\.com\/chart/i.test(t.url))
      .map(t => t.id)
  );

  const wantNew = String(layout).trim().toLowerCase() === 'new';
  const layoutName = name || 'New layout';
  const picked = await withTarget(landing.id, async (evalIn) => {
    if (wantNew) {
      // "Create new layout" opens a naming dialog; the Create button stays
      // disabled until the name input is filled (React controlled input, so
      // the native value setter + input event are required).
      await evalIn(`(function(){ var b = document.querySelector('.create-new-layout-button'); if (b) b.click(); })()`);
      await new Promise(r => setTimeout(r, 700));
      const filled = await evalIn(`
        (function() {
          // The dialog's name field (not the landing page's Search box).
          var inp = document.querySelector('input[placeholder="My layout"]');
          if (!inp) {
            var dlg = document.querySelector('[class*="dialog"], [role="dialog"]');
            if (dlg) inp = dlg.querySelector('input');
          }
          if (!inp) return 'no-dialog-input';
          var setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
          setter.call(inp, ${JSON.stringify(name || 'New layout')});
          inp.dispatchEvent(new Event('input', { bubbles: true }));
          return 'filled';
        })()
      `);
      if (filled !== 'filled') throw new Error(`Create-layout dialog did not open as expected (${filled}).`);
      await new Promise(r => setTimeout(r, 400));
      const created = await evalIn(`
        (function() {
          var scope = document.querySelector('[class*="dialog"], [role="dialog"]') || document;
          var btns = scope.querySelectorAll('button');
          for (var i = 0; i < btns.length; i++) {
            var t = (btns[i].textContent || '').trim().toLowerCase();
            if (t === 'create' && !btns[i].disabled) { btns[i].click(); return true; }
          }
          return false;
        })()
      `);
      if (!created) throw new Error('Create button not found or still disabled in the layout dialog.');
      return layoutName;
    }
    const clickByTitle = `
      (function() {
        var q = ${JSON.stringify(String(layout).toLowerCase())};
        var items = document.querySelectorAll('.layout-list-item');
        for (var i = 0; i < items.length; i++) {
          var t = items[i].querySelector('.layout-list-item-title');
          if (t && t.textContent.trim().toLowerCase().indexOf(q) !== -1) {
            items[i].click();
            return t.textContent.trim();
          }
        }
        return null;
      })()
    `;
    let foundTitle = await evalIn(clickByTitle);
    if (!foundTitle) {
      // Not in the recents — expand the full layout list and retry.
      await evalIn(`(function(){ var b = document.querySelector('.layout-list-expand-button'); if (b) b.click(); })()`);
      await new Promise(r => setTimeout(r, 800));
      foundTitle = await evalIn(clickByTitle);
    }
    return foundTitle;
  });

  if (!picked) throw new Error(`Layout matching "${layout}" not found in the layout list.`);

  // The chart loads under a NEW CDP target: the file:// landing -> https://
  // chart navigation swaps renderer processes, so the target id changes.
  // Wait for a chart target that wasn't there before the pick.
  let chartTarget = null;
  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 500));
    const resp = await fetch(`http://${CDP_HOST}:${CDP_PORT}/json/list`, { signal: AbortSignal.timeout(3000) });
    const targets = await resp.json();
    chartTarget = targets.find(x =>
      x.type === 'page' && /tradingview\.com\/chart/i.test(x.url) && !chartIdsBefore.has(x.id)
    ) || targets.find(x => x.id === landing.id && /tradingview\.com\/chart/i.test(x.url)) || null;
    if (chartTarget) break;
  }
  if (!chartTarget) throw new Error(`Picked "${picked}" but no new chart target appeared.`);

  // Give the chart a moment to boot, then follow it.
  await new Promise(r => setTimeout(r, 2000));
  await reconnectTo(chartTarget.id);
  return {
    success: true,
    action: wantNew ? 'new_layout_created' : 'layout_opened_in_new_tab',
    layout: picked,
    chart_id: chartTarget.url.match(/\/chart\/([^/?]+)/)?.[1] || null,
  };
}

/**
 * Close the currently active tab by clicking its close button in the shell.
 */
export async function closeTab() {
  const before = await withShell((evalIn) => evalIn(`document.querySelectorAll('.tabs-container .tab').length`));
  if (before <= 1) {
    throw new Error('Cannot close the last tab. Use tv_launch to restart TradingView instead.');
  }

  const result = await withShell(async (evalIn) => {
    const clicked = await evalIn(`
      (function() {
        var active = document.querySelector('.tabs-container .tab.active') || document.querySelectorAll('.tabs-container .tab')[0];
        if (!active) return false;
        // The close container div has no handler — the real clickable is the button inside it.
        var close = active.querySelector('[class*="close"] button') || active.querySelector('button[class*="close"]') || active.querySelector('[class*="close"]');
        if (!close) return false;
        close.click();
        return true;
      })()
    `);
    if (!clicked) throw new Error('Close button not found on the active tab.');
    await new Promise(r => setTimeout(r, 1000));
    return evalIn(`document.querySelectorAll('.tabs-container .tab').length`);
  });

  // Our cached CDP client may have been attached to the closed tab — re-resolve.
  try { await getClient(); } catch { /* next tool call will reconnect */ }

  return { success: result < before, action: 'tab_closed', tabs_before: before, tabs_after: result };
}

/**
 * Switch to a tab by index (from tab_list, i.e. tab-bar order). Clicks the tab
 * in the shell window, confirms the tab bar now shows it as active, then
 * re-attaches the CDP client so subsequent reads follow it.
 */
export async function switchTab({ index }) {
  const tabs = await list();
  const idx = Number(index);
  if (!Number.isInteger(idx) || idx < 0 || idx >= tabs.tab_count) {
    throw new Error(`Tab index ${index} out of range (have ${tabs.tab_count} tabs, 0-${tabs.tab_count - 1})`);
  }
  const tab = tabs.tabs[idx];

  if (tab.tab_key && !tab.active) {
    const ok = await withShell(async (evalIn) => {
      const key = JSON.stringify(tab.tab_key);
      const clicked = await evalIn(`(function() { var el = document.getElementById(${key}); if (!el) return false; el.click(); return true; })()`);
      if (!clicked) return false;
      for (let i = 0; i < 20; i++) {
        await new Promise(r => setTimeout(r, 150));
        if (await evalIn(`(function() { var el = document.getElementById(${key}); return !!(el && el.classList.contains('active')); })()`)) return true;
      }
      return false;
    });
    if (!ok) throw new Error(`Clicked tab "${tab.title}" but the tab bar did not switch to it.`);
  }

  // A tab that hasn't been opened since TradingView started has no page yet;
  // clicking it starts loading one. Wait for it to appear before attaching.
  if (!tab.id && tab.is_chart) {
    for (let i = 0; i < 40 && !tab.id; i++) {
      await new Promise(r => setTimeout(r, 500));
      const match = (await describeTargets()).find(t => t.is_chart && (tab.layout ? t.layout === tab.layout : bare(t.symbol) === bare(tab.symbol)));
      if (match) { tab.id = match.id; tab.chart_id = match.chart_id; tab.symbol = match.symbol; }
    }
    if (!tab.id) throw new Error(`Switched to "${tab.title}" but its chart didn't finish loading within 20s. Retry tab_list in a moment.`);
  }

  if (tab.id) {
    try { await reconnectTo(tab.id); }
    catch (e) { throw new Error(`Switched to "${tab.title}" but failed to attach to it: ${e.message}`); }
  }

  return { success: true, action: tab.active ? 'already_active' : 'switched', index: idx, title: tab.title, symbol: tab.symbol, tab_id: tab.id, chart_id: tab.chart_id };
}
