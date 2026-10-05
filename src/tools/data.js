import { z } from 'zod';
import { jsonResult } from './_format.js';
import { booleanParam } from './_schema.js';
import * as core from '../core/data.js';

export function registerDataTools(server) {
  server.tool('data_get_ohlcv', 'Get OHLCV bar data from the chart. Use summary=true for compact stats instead of all bars (saves context).', {
    count: z.coerce.number().optional().describe('Number of bars to retrieve (max 500, default 100)'),
    summary: booleanParam().optional().describe('Return summary stats (high, low, open, close, avg volume, range) instead of all bars — much smaller output'),
  }, async ({ count, summary }) => {
    try { return jsonResult(await core.getOhlcv({ count, summary })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('data_get_indicator', 'Get indicator/study info and input values', {
    entity_id: z.string().describe('Study entity ID (from chart_get_state)'),
  }, async ({ entity_id }) => {
    try { return jsonResult(await core.getIndicator({ entity_id })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  const strategyParam = z.string().optional().describe('Strategy name (substring, case-insensitive) when the chart has more than one. Default: the first strategy with a computed report.');

  server.tool('data_get_strategy_results', 'Get Strategy Tester results: `metrics` (headline numbers; *_pct fields are percentages), the full raw `performance` object, currency, initial_capital, date_range, trade_count and open_trades. Picks the strategy whose report is computed; never unhides anything. Hidden strategies have no report.', {
    strategy: strategyParam,
  }, async ({ strategy }) => {
    try { return jsonResult(await core.getStrategyResults({ strategy })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('data_get_trades', 'Get the Strategy Tester trade list: the most recent trades (oldest first) with side, entry/exit, P&L, run-up, drawdown and cumulative P&L. Open trades are flagged open:true with a mark_price instead of exit fields.', {
    max_trades: z.coerce.number().optional().describe('Maximum trades to return (default 20, max 500)'),
    strategy: strategyParam,
  }, async ({ max_trades, strategy }) => {
    try { return jsonResult(await core.getTrades({ max_trades, strategy })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('data_get_equity', 'Get the strategy equity curve: account equity after each closed trade (initial capital + cumulative P&L), plus open P&L.', {
    strategy: strategyParam,
  }, async ({ strategy }) => {
    try { return jsonResult(await core.getEquity({ strategy })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('quote_get', 'Get a real-time quote (last, bid/ask, OHLC, previous close, change, volume, session) for any symbol, from the TradingView quote feed. Does not touch the chart. Blank symbol = the chart symbol, plus its latest bar (replay-aware).', {
    symbol: z.string().optional().describe('Symbol to quote, ideally EXCHANGE:SYMBOL (e.g. "NASDAQ:AAPL", "CME_MINI:ES1!"). Blank = current chart symbol.'),
  }, async ({ symbol }) => {
    try { return jsonResult(await core.getQuote({ symbol })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('depth_get', 'Get order book / DOM (Depth of Market) data from the chart', {}, async () => {
    try { return jsonResult(await core.getDepth()); }
    catch (err) { return jsonResult({ success: false, error: err.message, hint: 'Open the DOM panel in TradingView before using this tool.' }, true); }
  });

  server.tool('data_get_pine_lines', 'Read horizontal price levels drawn by Pine Script indicators (line.new). Returns deduplicated price levels per study. Use study_filter to target a specific indicator.', {
    study_filter: z.string().optional().describe('Substring to match study name (e.g., "Profiler", "NY Levels"). Omit for all.'),
    verbose: booleanParam().optional().describe('Return raw line data with IDs, coordinates, colors (default false — returns only unique price levels)'),
  }, async ({ study_filter, verbose }) => {
    try { return jsonResult(await core.getPineLines({ study_filter, verbose })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('data_get_pine_labels', 'Read text labels drawn by Pine Script indicators (label.new). Returns text and price pairs. Use study_filter to target a specific indicator.', {
    study_filter: z.string().optional().describe('Substring to match study name. Omit for all.'),
    max_labels: z.coerce.number().optional().describe('Max labels per study (default 50). Set higher if you need all.'),
    verbose: booleanParam().optional().describe('Return raw label data with IDs, colors, positions (default false — returns only text + price)'),
  }, async ({ study_filter, max_labels, verbose }) => {
    try { return jsonResult(await core.getPineLabels({ study_filter, max_labels, verbose })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('data_get_pine_tables', 'Read table data drawn by Pine Script indicators (table.new). Returns formatted text rows per table. Use study_filter to target a specific indicator.', {
    study_filter: z.string().optional().describe('Substring to match study name. Omit for all.'),
  }, async ({ study_filter }) => {
    try { return jsonResult(await core.getPineTables({ study_filter })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('data_get_pine_boxes', 'Read box/zone boundaries drawn by Pine Script indicators (box.new). Returns deduplicated {high, low} price zones. Use study_filter to target a specific indicator.', {
    study_filter: z.string().optional().describe('Substring to match study name. Omit for all.'),
    verbose: booleanParam().optional().describe('Return all boxes with IDs and coordinates (default false — returns unique price zones)'),
  }, async ({ study_filter, verbose }) => {
    try { return jsonResult(await core.getPineBoxes({ study_filter, verbose })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('data_get_study_values', 'Get indicator values for all visible studies (RSI, MACD, Bollinger Bands, EMAs, custom indicators with plot()). `last_bar_values` (numbers) are the LATEST bar, read from each study\'s series, with `last_bar_time` (unix s); `values` (strings) come from the data window, which follows the crosshair -- if the mouse rests on the chart they belong to the hovered bar, not the latest.', {}, async () => {
    try { return jsonResult(await core.getStudyValues()); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });
}
