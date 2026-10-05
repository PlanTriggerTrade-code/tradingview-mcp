# Changelog

This fork tracks [tradesdontlie/tradingview-mcp](https://github.com/tradesdontlie/tradingview-mcp). Entries list what differs from upstream `main`.

## 2.1.0 — 2026-10-05

Based on upstream `main` at `c05b8f5` (2026-07-28). Tested against TradingView Desktop 3.4.1.8194 (Windows, Microsoft Store build).

### Merged upstream pull requests (open upstream at the time)

- #417 by @MahithTradez: `waitForChartReady` no longer times out on every symbol change (TradingView 3.3+); it waits for the series to load, so reads don't return the previous symbol's bars.
- #411 by @elevationchimneyservices-arch: every CDP call has a timeout, so a frozen TradingView can't hang the MCP session.
- #469 by @tamler: the Pine Editor opens on current builds (`scripteditor` widget).
- #522 by @alexisiandriotis-cmd: detects the icon-only "Add/Update on chart" button on 3.4.x, so Pine compile no longer clicks Save and reports success.
- #518 by @vp5zk6rs27-sudo: Pine tools refuse to overwrite unsaved work or a saved script by accident; `pine_new` / `pine_open` / `pine_save` go through the editor's own menu. New `pine_editor_state` tool.
- #433 by @bramanu (part): pick the on-screen Monaco editor.
- #528 by @L3G1T50: boolean parameters no longer read the string `"false"` as true (`alert_delete delete_all:"false"` used to delete every alert).
- #548 by @yd67962b89-stack: `requireFinite` rejects `''`, `[]` and `true` instead of converting them to numbers.
- #544 by @yd67962b89-stack: `indicator_set_inputs` verifies the write took effect.
- #532 by @luqmanhakimfeverythings-hub: `replay_stop` returns the chart to realtime; launch scripts don't hang callers that capture their output.
- #549 by @patches5020: `data_get_study_values` adds `last_bar_values` (latest bar, independent of the crosshair).
- #363 by @frkdkl: strips the obfuscated Pine source blob from study inputs.
- #537 by @dajiaohuang: `chart_scroll_to_date` loads older history first.
- #491 by @kingwish: watchlist button found by `data-name`, so non-English UIs work.

### Fixed and added in this fork

- **Microsoft Store launch.** `tv_launch`, `scripts/launch_tv_debug.bat` and the new `scripts/launch_tv_debug_store.ps1` start the Store build through Windows' `IApplicationActivationManager` COM API, which passes `--remote-debugging-port` and keeps the normal profile and login. Upstream's local package copy (~330MB, likely signed out) is now opt-in (`allow_local_copy`).
- **`tv_launch` never kills a working session**: if the debug port is already open it returns `already_running` (upstream issue #542).
- `ELECTRON_RUN_AS_NODE` is stripped before starting TradingView, and spawn errors that throw synchronously (EPERM) are reported instead of crashing the server.
- **`scripts/create_shortcut.ps1`** makes a "TradingView (CDP)" Desktop and Start Menu shortcut for either build, with an icon that survives app updates.
- **Active-tab following.** Tools act on the tab that's active in TradingView's tab bar, re-checked at the start of each tool call. `document.visibilityState` can't be used for this: tabs keep reporting `visible` after you leave them.
- **`tab_list` / `tab_switch`** use tab-bar order and mark the active tab; `tab_switch` confirms the switch happened (it used to report success without switching).
- **`quote_get`** reads any symbol from TradingView's quote session without touching the chart (~150ms), adding bid/ask, previous close, change and session status.
- **Strategy tools** (`data_get_strategy_results`, `data_get_trades`, `data_get_equity`):
  - pick the strategy whose report is computed (hidden copies have none), with an optional `strategy` name filter;
  - never unhide strategies (visibility is saved into your layout);
  - trade list (the most recent N, max 500) with exact long/short side and open trades flagged with a mark price;
  - `initial_capital` derived exactly; `*_pct` metrics are real percentages (TradingView's `*Percent` fields are fractions);
  - `success` is false when an error is returned.
- **Pine Editor** detection searches every editor container, so a detached copy left after reopening the panel no longer breaks all Pine tools.
- `batch_run get_strategy_results` uses the strategy report instead of scraping the tester panel.
- **`morning_brief`, `session_save`, `session_get`** from [LewisWJackson/tradingview-mcp-jackson](https://github.com/LewisWJackson/tradingview-mcp-jackson), with the `rules_path` guard fixed for Windows paths.
- CLI: no more Node 24 crash on Windows (`UV_HANDLE_CLOSING`) after commands that use `fetch()`.
- `.gitattributes` keeps `.bat` / `.ps1` files CRLF, so GitHub ZIP downloads run correctly.

### Removed

- `tv_update` (let the model run `git pull` + `npm ci` on request) and the GitHub update check in `tv_health_check` (called api.github.com on every health check and read git state from the wrong directory).

### Dependencies

- `@modelcontextprotocol/sdk` 1.32, `chrome-remote-interface` 0.34, `zod` declared directly. `npm audit`: 0 vulnerabilities.
