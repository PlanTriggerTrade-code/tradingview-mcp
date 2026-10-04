/**
 * Core data access logic.
 */
import { evaluate, evaluateAsync, KNOWN_PATHS, safeString } from '../connection.js';

const MAX_OHLCV_BARS = 500;
const MAX_TRADES = 500;

// Round to 8 dp — enough to kill float noise (29899.999999997 → 29900) without
// destroying precision on forex/crypto prices. The old 2-dp rounding flattened
// sub-cent levels to 0.00 (issue #77).
const roundPrice = (v) => (v == null ? null : Math.round(v * 1e8) / 1e8);
const CHART_API = KNOWN_PATHS.chartApi;
const BARS_PATH = KNOWN_PATHS.mainSeriesBars;

function buildGraphicsJS(collectionName, mapKey, filter) {
  return `
    (function() {
      var chart = window.TradingViewApi._activeChartWidgetWV.value()._chartWidget;
      var model = chart.model();
      var sources = model.model().dataSources();
      var results = [];
      var filter = ${safeString(filter || '')};
      for (var si = 0; si < sources.length; si++) {
        var s = sources[si];
        if (!s.metaInfo) continue;
        try {
          var meta = s.metaInfo();
          var name = meta.description || meta.shortDescription || '';
          if (!name) continue;
          if (filter && name.indexOf(filter) === -1) continue;
          var g = s._graphics;
          if (!g || !g._primitivesCollection) continue;
          var pc = g._primitivesCollection;
          var items = [];
          try {
            var outer = pc.${collectionName};
            if (outer) {
              var inner = outer.get('${mapKey}');
              if (inner) {
                var coll = inner.get(false);
                if (coll && coll._primitivesDataById && coll._primitivesDataById.size > 0) {
                  coll._primitivesDataById.forEach(function(v, id) { items.push({id: id, raw: v}); });
                }
              }
            }
          } catch(e) {}
          if (items.length === 0 && '${collectionName}' === 'dwgtablecells') {
            try {
              var tcOuter = pc.dwgtablecells;
              if (tcOuter) {
                var tcColl = tcOuter.get('tableCells');
                if (tcColl && tcColl._primitivesDataById && tcColl._primitivesDataById.size > 0) {
                  tcColl._primitivesDataById.forEach(function(v, id) { items.push({id: id, raw: v}); });
                }
              }
            } catch(e) {}
          }
          if (items.length > 0) results.push({name: name, count: items.length, items: items});
        } catch(e) {}
      }
      return results;
    })()
  `;
}

export async function getOhlcv({ count, summary } = {}) {
  const limit = Math.min(count || 100, MAX_OHLCV_BARS);
  let data;
  try {
    data = await evaluate(`
      (function() {
        var bars = ${BARS_PATH};
        if (!bars || typeof bars.lastIndex !== 'function') return null;
        var result = [];
        var end = bars.lastIndex();
        var start = Math.max(bars.firstIndex(), end - ${limit} + 1);
        for (var i = start; i <= end; i++) {
          var v = bars.valueAt(i);
          if (v) result.push({time: v[0], open: v[1], high: v[2], low: v[3], close: v[4], volume: v[5] || 0});
        }
        return {bars: result, total_bars: bars.size(), source: 'direct_bars'};
      })()
    `);
  } catch { data = null; }

  if (!data || !data.bars || data.bars.length === 0) {
    throw new Error('Could not extract OHLCV data. The chart may still be loading.');
  }

  if (summary) {
    const bars = data.bars;
    const highs = bars.map(b => b.high);
    const lows = bars.map(b => b.low);
    const volumes = bars.map(b => b.volume);
    const first = bars[0];
    const last = bars[bars.length - 1];
    return {
      success: true, bar_count: bars.length,
      period: { from: first.time, to: last.time },
      open: first.open, close: last.close,
      high: Math.max(...highs), low: Math.min(...lows),
      range: roundPrice(Math.max(...highs) - Math.min(...lows)),
      change: roundPrice(last.close - first.open),
      change_pct: Math.round(((last.close - first.open) / first.open) * 10000) / 100 + '%',
      avg_volume: Math.round(volumes.reduce((a, b) => a + b, 0) / volumes.length),
      last_5_bars: bars.slice(-5),
    };
  }

  return { success: true, bar_count: data.bars.length, total_available: data.total_bars, source: data.source, bars: data.bars };
}

export async function getIndicator({ entity_id }) {
  const data = await evaluate(`
    (function() {
      var api = ${CHART_API};
      var study = api.getStudyById(${safeString(entity_id)});
      if (!study) return { error: 'Study not found: ' + ${safeString(entity_id)} };
      var result = { name: null, inputs: null, visible: null };
      try { result.visible = study.isVisible(); } catch(e) {}
      try { result.inputs = study.getInputValues(); } catch(e) { result.inputs_error = e.message; }
      return result;
    })()
  `);

  if (data?.error) throw new Error(data.error);

  let inputs = data?.inputs;
  if (Array.isArray(inputs)) {
    inputs = inputs.filter(inp => {
      if (inp.id === 'text' && typeof inp.value === 'string' && inp.value.length > 200) return false;
      if (typeof inp.value === 'string' && inp.value.length > 500) return false;
      return true;
    });
  }
  return { success: true, entity_id, visible: data?.visible, inputs };
}

// Shared page-context JS for the strategy tools. Strategies are identified by
// metaInfo().isTVScriptStrategy / is_strategy (#48/#173/#181: they report
// is_price_study===true, so that flag can't be used to find them).
//
// A chart can hold several strategies, including hidden copies of the same
// one, and TradingView only computes a report for visible strategies. So pick
// the first strategy (optionally filtered by name) whose report is computed,
// rather than the first strategy in the list. Hidden strategies are reported,
// never unhidden: toggling visibility is saved into the user's layout.
const STRATEGY_JS = (nameFilter) => `
  function _reportOf(s) {
    try { var rd = s.reportData(); if (rd && typeof rd.value === 'function') rd = rd.value(); return rd; } catch (e) { return null; }
  }
  function listStrategies() {
    var sources = ${CHART_API}._chartWidget.model().model().dataSources();
    var out = [];
    for (var i = 0; i < sources.length; i++) {
      var s = sources[i], mi = null;
      try { mi = s.metaInfo ? s.metaInfo() : null; } catch (e) {}
      if (!mi || !(mi.isTVScriptStrategy || mi.is_strategy) || typeof s.reportData !== 'function') continue;
      var visible = null;
      try { visible = s.properties().visible.value(); } catch (e) {}
      var rd = _reportOf(s);
      out.push({ s: s, name: mi.description || mi.shortDescription || null, visible: visible, rd: (rd && rd.performance) ? rd : null });
    }
    return out;
  }
  function findStrategy() {
    var all = listStrategies();
    var filter = ${nameFilter ? safeString(String(nameFilter).toLowerCase()) : 'null'};
    var pool = filter ? all.filter(function(x) { return (x.name || '').toLowerCase().indexOf(filter) !== -1; }) : all;
    var summary = all.map(function(x) { return { name: x.name, visible: x.visible, has_report: !!x.rd }; });
    if (!pool.length) return { error: all.length
      ? 'No strategy on the chart matches "' + filter + '". Strategies on this chart: ' + summary.map(function(x) { return x.name; }).join(', ')
      : 'No strategy found on the chart. Add a strategy first.', strategies: summary };
    for (var j = 0; j < pool.length; j++) if (pool[j].rd) return { strat: pool[j].s, rd: pool[j].rd, name: pool[j].name, strategies: summary };
    var anyVisible = pool.some(function(x) { return x.visible !== false; });
    return { strat: pool[0].s, rd: null, name: pool[0].name, strategies: summary, all_hidden: !anyVisible };
  }
  function iso(ms) { return (ms === null || ms === undefined || isNaN(ms) || ms <= 0) ? null : new Date(ms).toISOString(); }
  function num(v) { return (typeof v === 'number' && isFinite(v)) ? v : null; }
  function sub(o, k) { return (o && typeof o === 'object' && o[k] !== undefined) ? o[k] : null; }
  function pct(v) { return (typeof v === 'number' && isFinite(v)) ? Math.round(v * 1e6) / 1e4 : null; }
  // Initial capital isn't exposed directly. netProfit / netProfitPercent (a
  // fraction) recovers it exactly; buyHold[0] is the fallback when there is no
  // profit yet. Not every report carries buyHold.
  function initialCapitalOf(rd) {
    var a = rd.performance && rd.performance.all;
    if (a && typeof a.netProfit === 'number' && typeof a.netProfitPercent === 'number' && a.netProfitPercent !== 0) {
      return Math.round((a.netProfit / a.netProfitPercent) * 100) / 100;
    }
    return Array.isArray(rd.buyHold) && rd.buyHold.length ? rd.buyHold[0] : null;
  }
  function openTradeCount(rd) {
    var a = rd.performance && rd.performance.all;
    return a && typeof a.totalOpenTrades === 'number' ? a.totalOpenTrades : 0;
  }
`;

// #173: some TradingView builds only compute a strategy report once the
// Strategy Tester panel has been opened. If the chosen strategy has no report
// yet, open the panel and poll briefly. A hidden strategy never computes, so
// that case returns straight away with an explanation.
async function readStrategy(nameFilter, body, maxWaitMs = 6000) {
  const run = () => evaluate(`
    (function() {
      ${STRATEGY_JS(nameFilter)}
      try {
        var found = findStrategy();
        if (found.error) return { error: found.error, strategies: found.strategies };
        if (!found.rd) return { pending: true, all_hidden: found.all_hidden, name: found.name, strategies: found.strategies };
        var rd = found.rd;
        var out = (function() { ${body} })();
        out.strategy = found.name;
        if (found.strategies.length > 1) out.strategies = found.strategies;
        return out;
      } catch (e) { return { error: e.message }; }
    })()
  `);

  let res = await run();
  if (res?.pending && !res.all_hidden) {
    await evaluate(`(function() { try { var bwb = window.TradingView && window.TradingView.bottomWidgetBar; if (bwb && typeof bwb.showWidget === 'function') bwb.showWidget('backtesting'); } catch (e) {} })()`);
    const deadline = Date.now() + maxWaitMs;
    while (res?.pending && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 500));
      res = await run();
    }
  }
  if (res?.pending) {
    return {
      error: res.all_hidden
        ? `Strategy "${res.name}" is hidden on the chart (eye icon off), and TradingView doesn't compute reports for hidden strategies. Show it on the chart and retry.`
        : `The report for "${res.name}" hasn't been computed yet. Retry in a few seconds.`,
      strategy: res.name,
      strategies: res.strategies,
    };
  }
  return res;
}

export async function getStrategyResults({ strategy } = {}) {
  const r = await readStrategy(strategy, `
    var perf = rd.performance || {};
    var all = perf.all || {};
    var dr = rd.settings && rd.settings.dateRange ? rd.settings.dateRange : {};
    var trades = Array.isArray(rd.trades) ? rd.trades.length : 0;
    var open = openTradeCount(rd);
    // Headline numbers. TradingView's *Percent fields are fractions (0.25 = 25%);
    // the *_pct fields here are real percentages.
    var metrics = {
      net_profit: num(all.netProfit),
      net_profit_pct: pct(all.netProfitPercent),
      gross_profit: num(all.grossProfit),
      gross_loss: num(all.grossLoss),
      profit_factor: num(all.profitFactor),
      max_drawdown: num(perf.maxStrategyDrawDown),
      max_drawdown_pct: pct(perf.maxStrategyDrawDownPercent),
      closed_trades: num(all.totalTrades),
      winning_trades: num(all.numberOfWiningTrades),
      losing_trades: num(all.numberOfLosingTrades),
      win_rate_pct: pct(all.percentProfitable),
      avg_trade: num(all.avgTrade),
      avg_trade_pct: pct(all.avgTradePercent),
      largest_win: num(all.largestWinTrade),
      largest_loss: num(all.largestLosTrade),
      commission_paid: num(all.commissionPaid),
      sharpe_ratio: num(perf.sharpeRatio),
      sortino_ratio: num(perf.sortinoRatio),
      buy_hold_return_pct: pct(perf.buyHoldReturnPercent),
      open_pl: num(perf.openPL),
    };
    for (var k in metrics) if (metrics[k] === null) delete metrics[k];
    return {
      currency: rd.currency != null ? rd.currency : null,
      initial_capital: initialCapitalOf(rd),
      date_range: {
        backtest: { from: iso(dr.backtest && dr.backtest.from), to: iso(dr.backtest && dr.backtest.to) },
        trade: { from: iso(dr.trade && dr.trade.from), to: iso(dr.trade && dr.trade.to) },
      },
      trade_count: trades,
      open_trades: open,
      metrics: metrics,
      performance: perf,
    };
  `);
  const error = r?.error;
  return {
    success: !error,
    source: 'internal_api',
    strategy: r?.strategy ?? null,
    ...(r?.strategies && { strategies: r.strategies }),
    currency: r?.currency ?? null,
    initial_capital: r?.initial_capital ?? null,
    date_range: r?.date_range ?? { backtest: { from: null, to: null }, trade: { from: null, to: null } },
    trade_count: r?.trade_count ?? 0,
    open_trades: r?.open_trades ?? 0,
    metric_count: r?.performance ? Object.keys(r.performance).length : 0,
    metrics: r?.metrics ?? {},
    performance: r?.performance ?? {},
    ...(error && { error }),
  };
}

export async function getTrades({ max_trades, strategy } = {}) {
  const limit = Math.max(1, Math.min(Number(max_trades) || 20, MAX_TRADES));
  const r = await readStrategy(strategy, `
    var all = Array.isArray(rd.trades) ? rd.trades : [];
    var open = openTradeCount(rd);
    // Most recent trades, oldest first. The last totalOpenTrades entries are
    // still open: their exit fields are a mark-to-market placeholder.
    var start = Math.max(0, all.length - ${limit});
    var result = [];
    for (var t = start; t < all.length; t++) {
      var tr = all[t];
      if (!tr || typeof tr !== 'object') continue;
      var e = tr.e || {}, x = tr.x || null;
      var isOpen = t >= all.length - open;
      // e.tp is the entry kind: 'le' = long entry, 'se' = short entry.
      var side = e.tp === 'se' ? 'Short' : e.tp === 'le' ? 'Long'
        : (String(e.c || '').toLowerCase().indexOf('short') !== -1 ? 'Short' : 'Long');
      result.push({
        n: t + 1,
        side: side,
        open: isOpen,
        entry_time: iso(e.tm),
        entry_price: num(e.p),
        entry_signal: e.c != null ? String(e.c) : null,
        entry_bar: num(e.b),
        exit_time: x && !isOpen ? iso(x.tm) : null,
        exit_price: x && !isOpen ? num(x.p) : null,
        exit_signal: x && !isOpen && x.c != null ? String(x.c) : null,
        exit_bar: x && !isOpen ? num(x.b) : null,
        mark_price: x && isOpen ? num(x.p) : undefined,
        qty: num(tr.q),
        pnl: sub(tr.tp, 'v'),
        pnl_pct: pct(sub(tr.tp, 'p')),
        runup: sub(tr.rn, 'v'),
        drawdown: sub(tr.dd, 'v'),
        cum_pnl: sub(tr.cp, 'v'),
        commission: num(tr.cm),
        notional: num(tr.v),
      });
    }
    return { trades: result, trade_count: all.length, open_trades: open };
  `);
  const error = r?.error;
  return {
    success: !error,
    source: 'internal_api',
    strategy: r?.strategy ?? null,
    ...(r?.strategies && { strategies: r.strategies }),
    trade_count: r?.trade_count ?? 0,
    open_trades: r?.open_trades ?? 0,
    showing: r?.trades?.length || 0,
    trades: r?.trades || [],
    ...(error && { error }),
  };
}

export async function getEquity({ strategy } = {}) {
  const r = await readStrategy(strategy, `
    var all = Array.isArray(rd.trades) ? rd.trades : [];
    var cap = initialCapitalOf(rd);
    var open = openTradeCount(rd);
    var data = [];
    // One point per closed trade: account equity after that trade.
    for (var t = 0; t < all.length - open; t++) {
      var tr = all[t];
      if (!tr || typeof tr !== 'object') continue;
      var cum = sub(tr.cp, 'v');
      var when = tr.x && tr.x.tm != null ? tr.x.tm : (tr.e ? tr.e.tm : null);
      data.push({
        time: iso(when),
        equity: (cap === null || cum === null) ? null : Math.round((cap + cum) * 1e8) / 1e8,
        cum_pnl: cum,
        drawdown: sub(tr.dd, 'v'),
      });
    }
    return { data: data, initial_capital: cap, open_pl: num(rd.performance && rd.performance.openPL) };
  `);
  const error = r?.error;
  return {
    success: !error,
    source: 'internal_api',
    strategy: r?.strategy ?? null,
    ...(r?.strategies && { strategies: r.strategies }),
    initial_capital: r?.initial_capital ?? null,
    open_pl: r?.open_pl ?? null,
    data_points: r?.data?.length || 0,
    data: r?.data || [],
    ...(error && { error }),
  };
}

// Quote for any symbol through TradingView's own quote session (the feed behind
// the watchlist), so the chart is never touched. With no symbol, the chart's
// symbol is used and the latest bar is included (replay-aware).
const QUOTE_FIELDS = ['last_price', 'lp_time', 'bid', 'ask', 'bid_size', 'ask_size', 'open_price', 'high_price',
  'low_price', 'prev_close_price', 'change', 'change_percent', 'volume', 'currency_code', 'description',
  'exchange', 'type', 'pro_name', 'current_session', 'update_mode', 'rtc', 'rch', 'rchp', 'rtc_time'];

export async function getQuote({ symbol } = {}) {
  const requested = (symbol || '').toString().trim();
  const data = await evaluateAsync(`
    (function() {
      var api = ${CHART_API};
      var chartSym = '';
      try { chartSym = api.symbol(); } catch (e) {}
      var sym = ${requested ? safeString(requested) : 'chartSym'};
      var out = { symbol: sym };
      if (!${requested ? 'true' : 'false'}) {
        try {
          var bars = ${BARS_PATH};
          var last = bars && bars.valueAt(bars.lastIndex());
          if (last) out.bar = { time: last[0], open: last[1], high: last[2], low: last[3], close: last[4], volume: last[5] || 0 };
        } catch (e) {}
        try { out.replay = !!${KNOWN_PATHS.replayApi}.isReplayStarted().value(); } catch (e) {}
      }
      var qs = window.getQuoteSessionInstance && window.getQuoteSessionInstance('full');
      if (!qs || typeof qs.snapshot !== 'function') { out.quote_error = 'Quote session not available in this TradingView build.'; return out; }
      var timeout = new Promise(function(_, reject) { setTimeout(function() { reject(new Error('timeout')); }, 8000); });
      return Promise.race([qs.snapshot(sym), timeout]).then(function(d) {
        var keys = ${JSON.stringify(QUOTE_FIELDS)};
        out.quote = {};
        for (var i = 0; i < keys.length; i++) if (d && d[keys[i]] !== undefined && d[keys[i]] !== null) out.quote[keys[i]] = d[keys[i]];
        return out;
      }, function(e) { out.quote_error = (e && e.message) || 'unknown symbol'; return out; });
    })()
  `);

  const q = data?.quote || {};
  if (requested && !data?.quote) {
    throw new Error(`No quote for "${requested}" (${data?.quote_error}). Use symbol_search to find the exact EXCHANGE:SYMBOL.`);
  }
  // In replay the live quote is from "now", not the replay bar, so lead with the bar.
  const useBar = !requested && data?.bar && (data.replay || q.last_price == null);
  const result = {
    success: true,
    symbol: q.pro_name || data?.symbol,
    last: useBar ? data.bar.close : (q.last_price ?? data?.bar?.close ?? null),
    time: useBar ? data.bar.time : (q.lp_time ?? data?.bar?.time ?? null),
    bid: q.bid, ask: q.ask, bid_size: q.bid_size, ask_size: q.ask_size,
    open: q.open_price, high: q.high_price, low: q.low_price, prev_close: q.prev_close_price,
    change: q.change, change_percent: q.change_percent, volume: q.volume,
    extended_hours: q.rtc != null ? { last: q.rtc, change: q.rch, change_percent: q.rchp, time: q.rtc_time } : undefined,
    session: q.current_session, update_mode: q.update_mode,
    currency: q.currency_code, description: q.description, exchange: q.exchange, type: q.type,
    ...(data?.bar && { chart_bar: data.bar }),
    ...(data?.replay && { replay: true, note: 'Chart is in replay mode: last/time come from the replay bar; the quote fields are live.' }),
    ...(data?.quote_error && { quote_error: data.quote_error }),
  };
  for (const k of Object.keys(result)) if (result[k] === undefined) delete result[k];
  if (result.last == null) throw new Error('Could not retrieve a quote. The chart may still be loading.');
  return result;
}

export async function getDepth() {
  const data = await evaluate(`
    (function() {
      var domPanel = document.querySelector('[class*="depth"]')
        || document.querySelector('[class*="orderBook"]')
        || document.querySelector('[class*="dom-"]')
        || document.querySelector('[class*="DOM"]')
        || document.querySelector('[data-name="dom"]');
      if (!domPanel) return { found: false, error: 'DOM / Depth of Market panel not found.' };
      var bids = [], asks = [];
      var rows = domPanel.querySelectorAll('[class*="row"], tr');
      for (var i = 0; i < rows.length; i++) {
        var row = rows[i];
        var priceEl = row.querySelector('[class*="price"]');
        var sizeEl = row.querySelector('[class*="size"], [class*="volume"], [class*="qty"]');
        if (!priceEl) continue;
        var price = parseFloat(priceEl.textContent.replace(/[^0-9.\\-]/g, ''));
        var size = sizeEl ? parseFloat(sizeEl.textContent.replace(/[^0-9.\\-]/g, '')) : 0;
        if (isNaN(price)) continue;
        var rowClass = row.className || '';
        var rowHTML = row.innerHTML || '';
        if (/bid|buy/i.test(rowClass) || /bid|buy/i.test(rowHTML)) bids.push({ price, size });
        else if (/ask|sell/i.test(rowClass) || /ask|sell/i.test(rowHTML)) asks.push({ price, size });
        else if (i < rows.length / 2) asks.push({ price, size });
        else bids.push({ price, size });
      }
      if (bids.length === 0 && asks.length === 0) {
        var cells = domPanel.querySelectorAll('[class*="cell"], td');
        var prices = [];
        cells.forEach(function(c) { var val = parseFloat(c.textContent.replace(/[^0-9.\\-]/g, '')); if (!isNaN(val) && val > 0) prices.push(val); });
        if (prices.length > 0) return { found: true, raw_values: prices.slice(0, 50), bids: [], asks: [], note: 'Could not classify bid/ask levels.' };
      }
      bids.sort(function(a, b) { return b.price - a.price; });
      asks.sort(function(a, b) { return a.price - b.price; });
      var spread = null;
      if (asks.length > 0 && bids.length > 0) spread = +(asks[0].price - bids[0].price).toFixed(6);
      return { found: true, bids: bids, asks: asks, spread: spread };
    })()
  `);

  if (!data || !data.found) throw new Error(data?.error || 'DOM panel not found.');
  return { success: true, bid_levels: data.bids?.length || 0, ask_levels: data.asks?.length || 0, spread: data.spread, bids: data.bids || [], asks: data.asks || [], raw_values: data.raw_values, note: data.note };
}

export async function getStudyValues({ _deps } = {}) {
  const run = _deps?.evaluate || evaluate;
  const data = await run(`
    (function() {
      var chart = window.TradingViewApi._activeChartWidgetWV.value()._chartWidget;
      var model = chart.model();
      var sources = model.model().dataSources();
      var results = [];
      for (var si = 0; si < sources.length; si++) {
        var s = sources[si];
        if (!s.metaInfo) continue;
        try {
          var meta = s.metaInfo();
          var name = meta.description || meta.shortDescription || '';
          if (!name) continue;
          var values = {};
          try {
            var dwv = s.dataWindowView();
            if (dwv) {
              var items = dwv.items();
              if (items) {
                for (var i = 0; i < items.length; i++) {
                  var item = items[i];
                  if (item._value && item._value !== '∅' && item._title) values[item._title] = item._value;
                }
              }
            }
          } catch(e) {}
          // The data window above follows the crosshair: with the mouse resting on
          // the chart it shows THAT bar, not the latest one. Read the latest bar
          // straight from the study's own series too (value[0] = bar time,
          // value[i + 1] = metaInfo().plots[i]); titled plots only.
          var lastBarValues = {};
          var lastBarTime = null;
          try {
            var last = s.data && s.data() && s.data().last ? s.data().last() : null;
            if (last && last.value) {
              lastBarTime = last.value[0];
              var plots = meta.plots || [];
              for (var p = 0; p < plots.length; p++) {
                var style = meta.styles && meta.styles[plots[p].id];
                var v = last.value[p + 1];
                if (style && style.title && typeof v === 'number' && isFinite(v)) lastBarValues[style.title] = v;
              }
            }
          } catch(e) {}
          // Include id + inputs so multiple instances of the same indicator
          // (e.g. two EMAs with different lengths) are distinguishable (#143).
          var id = null;
          try { id = s.id ? s.id() : null; } catch(e) {}
          // A Pine study's inputs() carries its identity alongside its configuration:
          // the obfuscated source (text, multi-KB), the script id and version, the
          // feature list and the internal calc flags. None of it says how the study
          // is configured, and pineId is identical across every instance of a script
          // — so it cannot help tell instances apart either (#143). Drop that set,
          // keep the in_* values that do, and unwrap the {v,f,t} envelope.
          var META = ['text', 'pineId', 'pineVersion', 'pineFeatures', '__fast_calc', '__profile'];
          var inputs = null;
          try {
            var ip = s.inputs ? s.inputs() : null;
            if (ip) {
              var lean = {};
              for (var k in ip) {
                if (META.indexOf(k) !== -1) continue;
                var iv = ip[k];
                var val = (iv && typeof iv === 'object' && 'v' in iv) ? iv.v : iv;
                // Safety net for unknown blobs: getIndicator() drops strings over
                // 500 chars (src/core/data.js:203) — same threshold here.
                if (typeof val === 'string' && val.length > 500) continue;
                lean[k] = val;
              }
              if (Object.keys(lean).length) inputs = lean;
            }
          } catch(e) {}
          if (Object.keys(values).length > 0 || Object.keys(lastBarValues).length > 0) {
            results.push({ id: id, name: name, inputs: inputs, values: values,
                           last_bar_time: lastBarTime, last_bar_values: lastBarValues });
          }
        } catch(e) {}
      }
      return results;
    })()
  `);
  return { success: true, study_count: data?.length || 0, studies: data || [] };
}

export async function getPineLines({ study_filter, verbose } = {}) {
  const filter = study_filter || '';
  const raw = await evaluate(buildGraphicsJS('dwglines', 'lines', filter));
  if (!raw || raw.length === 0) return { success: true, study_count: 0, studies: [] };

  const studies = raw.map(s => {
    const hLevels = [];
    const seen = {};
    const allLines = [];
    for (const item of s.items) {
      const v = item.raw;
      const y1 = roundPrice(v.y1);
      const y2 = roundPrice(v.y2);
      if (verbose) allLines.push({ id: item.id, y1, y2, x1: v.x1, x2: v.x2, horizontal: v.y1 === v.y2, style: v.st, width: v.w, color: v.ci });
      if (y1 != null && v.y1 === v.y2 && !seen[y1]) { hLevels.push(y1); seen[y1] = true; }
    }
    hLevels.sort((a, b) => b - a);
    const result = { name: s.name, total_lines: s.count, horizontal_levels: hLevels };
    if (verbose) result.all_lines = allLines;
    return result;
  });
  return { success: true, study_count: studies.length, studies };
}

export async function getPineLabels({ study_filter, max_labels, verbose } = {}) {
  const filter = study_filter || '';
  const raw = await evaluate(buildGraphicsJS('dwglabels', 'labels', filter));
  if (!raw || raw.length === 0) return { success: true, study_count: 0, studies: [] };

  const limit = max_labels || 50;
  const studies = raw.map(s => {
    let labels = s.items.map(item => {
      const v = item.raw;
      const text = v.t || '';
      const price = roundPrice(v.y);
      if (verbose) return { id: item.id, text, price, x: v.x, yloc: v.yl, size: v.sz, textColor: v.tci, color: v.ci };
      return { text, price };
    }).filter(l => l.text || l.price != null);
    if (labels.length > limit) labels = labels.slice(-limit);
    return { name: s.name, total_labels: s.count, showing: labels.length, labels };
  });
  return { success: true, study_count: studies.length, studies };
}

export async function getPineTables({ study_filter } = {}) {
  const filter = study_filter || '';
  const raw = await evaluate(buildGraphicsJS('dwgtablecells', 'tableCells', filter));
  if (!raw || raw.length === 0) return { success: true, study_count: 0, studies: [] };

  const studies = raw.map(s => {
    const tables = {};
    for (const item of s.items) {
      const v = item.raw;
      const tid = v.tid || 0;
      if (!tables[tid]) tables[tid] = {};
      if (!tables[tid][v.row]) tables[tid][v.row] = {};
      tables[tid][v.row][v.col] = v.t || '';
    }
    const tableList = Object.entries(tables).map(([tid, rows]) => {
      const rowNums = Object.keys(rows).map(Number).sort((a, b) => a - b);
      const formatted = rowNums.map(rn => {
        const cols = rows[rn];
        const colNums = Object.keys(cols).map(Number).sort((a, b) => a - b);
        return colNums.map(cn => cols[cn]).filter(Boolean).join(' | ');
      }).filter(Boolean);
      return { rows: formatted };
    });
    return { name: s.name, tables: tableList };
  });
  return { success: true, study_count: studies.length, studies };
}

export async function getPineBoxes({ study_filter, verbose } = {}) {
  const filter = study_filter || '';
  const raw = await evaluate(buildGraphicsJS('dwgboxes', 'boxes', filter));
  if (!raw || raw.length === 0) return { success: true, study_count: 0, studies: [] };

  const studies = raw.map(s => {
    const zones = [];
    const seen = {};
    const allBoxes = [];
    for (const item of s.items) {
      const v = item.raw;
      const high = v.y1 != null && v.y2 != null ? roundPrice(Math.max(v.y1, v.y2)) : null;
      const low = v.y1 != null && v.y2 != null ? roundPrice(Math.min(v.y1, v.y2)) : null;
      if (verbose) allBoxes.push({ id: item.id, high, low, x1: v.x1, x2: v.x2, borderColor: v.c, bgColor: v.bc });
      if (high != null && low != null) { const key = high + ':' + low; if (!seen[key]) { zones.push({ high, low }); seen[key] = true; } }
    }
    zones.sort((a, b) => b.high - a.high);
    const result = { name: s.name, total_boxes: s.count, zones };
    if (verbose) result.all_boxes = allBoxes;
    return result;
  });
  return { success: true, study_count: studies.length, studies };
}
