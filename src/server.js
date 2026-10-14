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
import { followActiveTab, withTimeout, CDP_HOST, CDP_PORT } from './connection.js';
import CDP from 'chrome-remote-interface';
import { z } from 'zod';
import { booleanParam } from './tools/_schema.js';
import { protectRegistrations } from './layout-safety.js';
import { registerPineDevelopment } from './pine-development.js';

const server = new McpServer(
  {
    name: 'tradingview',
    version: '2.2.0',
    description: 'AI-assisted TradingView chart analysis and Pine Script development via Chrome DevTools Protocol',
  },
  {
    instructions: `TradingView MCP — tools for reading and (guarded) changing a live TradingView Desktop chart. Untargeted read tools act on the tab that's active in TradingView's tab bar. Tools marked [Disabled] in their description refuse every call (layout guard).

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
- Read any chart. Change one of the user's real charts only after the user said yes for that chart (user_approved: true).
- For tests, make your own chart with scratch_layout_create; scratch charts need no approval (ui_evaluate still does).
- Every target-bound tool takes target_id (the id from tab_list) and layout_id; the layout is verified before each change.
- Read-only on any chart: layout_safety_inspect, study_inputs_get, strategy_trades_get.
- Use pine_development_open/inspect/load/update/verify for guarded Pine development and verified cloud saves.
- Target-bound writes: chart_set_symbol, chart_set_timeframe, indicator_set_inputs, indicator_toggle_visibility, chart_manage_indicator.
- ui_evaluate (raw JavaScript) ALWAYS needs user_approved: true, also on scratch charts. scratch_layout_create needs it when the tab shows a real chart; pine_development_update needs it when an open real chart uses the script.
- capture_screenshot method "api" (publishes to TradingView's servers) is refused.
- UI clicks/keyboard, layout/tab switching and creation, layout saves, legacy Pine editor actions, drawings, alerts, watchlist changes, replay and batch tools remain disabled.
- Never bypass a refusal via raw CDP, CLI or another tool. See docs/LAYOUT_SAFETY.md.

Changing the chart (only the guarded target-bound operations above are available):
- chart_set_symbol, chart_set_timeframe → change ticker/resolution
- chart_manage_indicator → add/remove studies. USE FULL NAMES: "Relative Strength Index" not "RSI"
- indicator_set_inputs, indicator_toggle_visibility → change indicator settings / visibility

Pine Script development:
- pine_development_* (see LAYOUT SAFETY) replace the disabled pine_set_source / pine_smart_compile / pine_save / pine_open / pine_new
- pine_check → compile through TradingView's server without touching a chart; pine_analyze → offline static analysis

Screenshots: capture_screenshot → regions: "full", "chart", "strategy_tester"
Reads: replay_status, draw_list, draw_get_properties, alert_list, pane_list, tab_list, layout_list, watchlist_get

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
registerPineDevelopment(server, { z, connect, listTargets, bool: booleanParam });
// Installed before the tool groups register, so a new or unreviewed tool is disabled by default.
protectRegistrations(server, { z, connect, bool: booleanParam });

// Every tool acts on the tab the user is looking at: before each call, re-attach
// if they've switched TradingView tabs since the last one. Installed on top of the
// guard: read tools follow the active tab inside the guard's queue; guarded writes
// and disabled tools never use the followed connection.
const registerTool = server.tool.bind(server);
server.tool = (...args) => {
  const handler = args[args.length - 1];
  if (typeof handler === 'function') {
    args[args.length - 1] = async (...callArgs) => {
      try { await followActiveTab(); } catch { /* the tool's own connect reports errors */ }
      return handler(...callArgs);
    };
  }
  return registerTool(...args);
};

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
