import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { registerHealthTools } from './tools/health.js';
import { registerChartTools } from './tools/chart.js';
import { registerPineTools } from './tools/pine.js';
import { registerDataTools } from './tools/data.js';
import { registerCaptureTools } from './tools/capture.js';
import { registerDrawingTools } from './tools/drawing.js';
import { registerAlertTools } from './tools/alerts.js';
import { registerBatchTools } from './tools/batch.js';
import { registerReplayTools } from './tools/replay.js';
import { registerIndicatorTools } from './tools/indicators.js';
import { registerWatchlistTools } from './tools/watchlist.js';
import { registerUiTools } from './tools/ui.js';
import { registerPaneTools } from './tools/pane.js';
import { registerTabTools } from './tools/tab.js';
import { registerMorningTools } from './tools/morning.js';
import { followActiveTab, withTimeout, CDP_HOST, CDP_PORT, evaluate, evaluateAsync, getTargetInfo, pinTarget, unpinTarget } from './connection.js';
import CDP from 'chrome-remote-interface';
import { z } from 'zod';
import { booleanParam } from './tools/_schema.js';
import { protectRegistrations, annotateRegistrations } from './layout-safety.js';
import { registerPineDevelopment } from './pine-development.js';

const server = new McpServer(
  {
    name: 'tradingview',
    version: '2.3.1',
    description: 'AI-assisted TradingView chart analysis and Pine Script development via Chrome DevTools Protocol',
  },
  {
    instructions: `TradingView MCP — tools for reading and controlling a live TradingView Desktop chart. Untargeted tools act on the tab that's active in TradingView's tab bar. One rule (layout guard): never change one of the user's protected charts without their yes.

TOOL SELECTION GUIDE — use this to pick the right tool:

Reading your chart:
- chart_get_state → get symbol, timeframe, all indicator names + entity IDs (call first)
- data_get_study_values → get current numeric values from ALL visible indicators (RSI, MACD, BB, EMA, etc.)
- quote_get → real-time quote (last, bid/ask, OHLC, change). Pass symbol to quote anything without changing the chart
- data_get_ohlcv → get price bars. ALWAYS pass summary=true unless you need individual bars

Reading custom Pine indicator output (line.new/label.new/table.new/box.new drawings):
- data_get_pine_lines → horizontal price levels from custom indicators (deduplicated, sorted)
- data_get_pine_labels → text annotations with prices ("PDH 24550", "Bias Long", etc.)
- data_get_pine_tables → table data as formatted rows (session stats, analytics dashboards)
- data_get_pine_boxes → price zones as {high, low} pairs
- ALWAYS pass study_filter to target a specific indicator by name (e.g., study_filter="Profiler")
- Indicators must be VISIBLE on chart for these to work

LAYOUT SAFETY (docs/LAYOUT_SAFETY.md):
- One rule: never change one of the user's protected charts without their yes. Protected = the layout actually loaded in the tab is listed in state/protected-layouts.json (by ID or name pattern).
- Tools that may change a chart check the layout loaded in the tab they act on; on a protected chart they refuse unless user_approved: true, passed only after the user said yes for that chart. Every other chart is free; no extra parameters are needed.
- layout_safety_inspect (target_id from tab_list) shows which layout a tab really has loaded and whether it is protected.
- Never bypass a refusal via raw CDP, CLI or another tool.

Changing the chart:
- chart_set_symbol, chart_set_timeframe, chart_set_type → change ticker/resolution/style
- chart_manage_indicator → add/remove studies. USE FULL NAMES: "Relative Strength Index" not "RSI"
- chart_scroll_to_date → jump to a date (ISO format); chart_set_visible_range → zoom
- indicator_set_inputs, indicator_toggle_visibility → change indicator settings / visibility

Pine Script development:
- pine_set_source → inject code, pine_smart_compile → compile + check errors (a save that would update an open protected chart needs user_approved)
- pine_get_errors → read errors, pine_get_console → read log output
- WARNING: pine_get_source can return 200KB+ for complex scripts — avoid unless editing
- pine_development_* → guarded development with backups and a verified cloud save

Screenshots: capture_screenshot → regions: "full", "chart", "strategy_tester"
Replay: replay_start → replay_step → replay_trade → replay_status → replay_stop
Batch: batch_run → run action across multiple symbols/timeframes
Drawing: draw_shape → horizontal_line, trend_line, rectangle, text
Alerts: alert_create, alert_list, alert_delete
Launch: tv_launch → auto-detect and start TradingView with CDP on any platform
Panes: pane_list, pane_set_layout (s, 2h, 2v, 4, 6, 8), pane_focus, pane_set_symbol
Tabs: tab_list, tab_new, tab_close, tab_switch

CONTEXT MANAGEMENT:
- ALWAYS use summary=true on data_get_ohlcv
- ALWAYS use study_filter on pine tools when you know which indicator you want
- NEVER use verbose=true unless user specifically asks for raw data
- Prefer capture_screenshot for visual context over pulling large datasets
- Call chart_get_state ONCE at start, reuse entity IDs`,
  }
);

// Layout guard (docs/LAYOUT_SAFETY.md). Target-bound tools attach to the exact tab they are given;
// every CDP call is bounded like the rest of the server's (see connection.js).
const connect = async (target) => {
  const client = await withTimeout(CDP({ host: CDP_HOST, port: CDP_PORT, target }), 5000, 'CDP attach');
  return {
    close: () => client.close(),
    Runtime: { evaluate: (params) => withTimeout(client.Runtime.evaluate(params), 60000, 'Guarded evaluate') },
  };
};
const listTargets = () => CDP.List({ host: CDP_HOST, port: CDP_PORT });
// Annotations (read-only / destructive hints) for every tool, from the guard's classes.
annotateRegistrations(server);
registerPineDevelopment(server, { z, connect, listTargets, bool: booleanParam });
// Untargeted tools act on the tab the user is looking at: before each call the guard re-attaches
// the shared connection if they've switched TradingView tabs (followActiveTab). Chart-bound tools
// then read the layout loaded in that tab over the same connection before they run.
const active = {
  follow: () => followActiveTab(),
  evaluate: (expression) => evaluate(expression),
  evaluateAsync: (expression) => evaluateAsync(expression),
  targetId: async () => (await getTargetInfo())?.id ?? null,
  pin: (id) => pinTarget(id),
  unpin: () => unpinTarget(),
};
// Installed before the tool groups register, so a new or unreviewed tool is disabled by default.
protectRegistrations(server, { z, connect, listTargets, active, bool: booleanParam });

// Register all tool groups
registerHealthTools(server);
registerChartTools(server);
registerPineTools(server);
registerDataTools(server);
registerCaptureTools(server);
registerDrawingTools(server);
registerAlertTools(server);
registerBatchTools(server);
registerReplayTools(server);
registerIndicatorTools(server);
registerWatchlistTools(server);
registerUiTools(server);
registerPaneTools(server);
registerTabTools(server);
registerMorningTools(server);

// Startup notice (stderr so it doesn't interfere with MCP stdio protocol)
process.stderr.write('⚠  tradingview-mcp  |  Unofficial tool. Not affiliated with TradingView Inc. or Anthropic.\n');
process.stderr.write('   Ensure your usage complies with TradingView\'s Terms of Use.\n\n');

// Start stdio transport
const transport = new StdioServerTransport();
await server.connect(transport);
