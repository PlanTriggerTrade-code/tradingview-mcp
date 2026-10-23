# Changelog

This fork tracks [tradesdontlie/tradingview-mcp](https://github.com/tradesdontlie/tradingview-mcp). Entries list what differs from upstream `main`.

## Unreleased

### Tool annotations

- Every tool declares MCP annotations from its layout-guard class: read tools `readOnlyHint: true`,
  all others `false`, and the five deleting tools `destructiveHint: true`. Clients can tell reads
  from writes without parsing descriptions; the guard is unchanged.

### Fixes

- `indicator_set_inputs` writes only the inputs being changed. It used to write every input back,
  and colour inputs read back as numbers but must be written as colour strings, so TradingView
  rejected the whole write, cleared the study's inputs and the restore failed the same way.
- `pine_development_update` compares the editor's text with the source without line endings and
  the final newline (the editor normalizes them), so a CRLF file no longer stops with
  `PINE_EDITOR_CHANGED`.

## 2.3.1 — 2026-10-15

### Desktop chart setup reliability

- New tabs click the actual button rather than its surrounding container, wait for
  the landing page, and verify the loaded layout ID and name before reporting success.
- Pine opening filters virtualized picker rows, rejects ambiguous names, and verifies
  editor contents against the selected saved version. A visible editor is not toggled closed.
- Indicator search waits for delayed results on cold layouts.
- `ui_evaluate` now awaits returned promises. Callback-wrapped saves return their completion
  result; promise rejections and timeouts report failure rather than an empty success.
  A timeout does not cancel page-side work: inspect the result before retrying a mutation.
- Verified on Windows TradingView Desktop 3.4.1 through the MCP protocol: new layout,
  switching between two saved scripts, indicator search, and a real save callback.
  Offline regression and protection tests also pass; other platforms were not live-tested.

**Updating:** run `git pull --ff-only` and `npm ci` in this fork's checkout, then restart
or reconnect the TradingView MCP in your client. Existing processes keep the previous
code until restarted. TradingView itself does not need restarting. Local protected-layout
settings remain in the ignored `state/` directory; no personal configurations are shipped.

## 2.3.0 — 2026-10-14

### Chart protection: one rule, all tools enabled

The 2.2.0 guard disabled 48 tools and treated every layout as off limits. 2.3.0 replaces it with a single rule: **a tool never changes one of your protected charts without your yes.** Everything else works.

- **Protected charts** are the ones listed in `state/protected-layouts.json` (by layout ID or name pattern; see `protected-layouts.example.json`). What counts is the layout actually loaded in the tab, not the one the URL shows.
- **Tools that may change a chart** (symbol, timeframe, studies, drawings, replay, panes, Pine compile/save, `layout_switch`, `ui_evaluate`, raw clicks and keys, ...) check the layout loaded in the tab they act on before running. On a protected chart they refuse with `PROTECTED_CHART_NEEDS_PERMISSION` unless `user_approved: true`. They need no extra parameters; an optional `layout_id` must match the loaded layout. While they run, the connection stays pinned to the checked tab.
- **Pine saves** (`pine_save`, `pine_compile`, `pine_smart_compile`, `pine_development_update`) ask only when an open protected chart uses the script; the result names any protected charts updated and says when something could not be checked.
- **All 48 tools disabled in 2.2.0 are enabled again**; read and account tools (alerts, watchlist, tabs, new layouts, `tv_launch`, fullscreen, the Pine editor's text) run freely. `capture_screenshot` accepts `method: "api"` again.
- **Removed:** the scratch-chart registry and `scratch_layout_create`, the required `target_id`/`layout_id` on chart changes, and the always-ask rule for raw JavaScript, clicks and keys.
- `layout_safety_inspect`, `study_inputs_get`, `strategy_trades_get`: `layout_id` is optional.

## 2.2.0 — 2026-10-14

### Chart protection (layout guard)

Every tool now goes through a guard ([docs/LAYOUT_SAFETY.md](docs/LAYOUT_SAFETY.md)). Reading any chart is allowed; changing one of your charts needs your yes (`user_approved: true`). Every layout counts as one of your real charts unless the assistant created it as a scratch chart. Writes are bound to an exact tab and layout (`target_id`, `layout_id`) and refuse if the URL, the loaded layout and the requested layout disagree. Tools that cannot prove which layout they act on are disabled.

- **Guarded writes:** `chart_set_symbol`, `chart_set_timeframe`, `indicator_set_inputs`, `indicator_toggle_visibility` and `chart_manage_indicator` take `target_id`, `layout_id` and `user_approved`. `ui_evaluate` always needs `user_approved: true`, scratch charts included.
- **New tools:**
  - `layout_safety_inspect`: which layout a tab really shows, its sections and state hash, and whether it is a real, protected or scratch chart.
  - `study_inputs_get`: every input (id, title, value) of a study, on an explicit tab and layout.
  - `strategy_trades_get`: a strategy's closed trades, on an explicit tab and layout.
  - `scratch_layout_create`: a new empty layout in a tab, recorded as a scratch chart (needs approval when the tab shows a real chart).
  - `pine_development_open`, `pine_development_inspect`, `pine_development_load`, `pine_development_update`, `pine_development_verify`: guarded Pine development with backups, locks, identity checks and a verified cloud save. Saving asks for approval when an open real chart uses the script.
- **Now disabled** (still listed, every call refuses): `alert_create`, `alert_delete`, `batch_run`, `chart_set_type`, `chart_set_visible_range`, `chart_scroll_to_date`, `draw_shape`, `draw_clear`, `draw_remove_one`, `tv_launch`, `indicator_search`, `indicator_add`, `morning_brief`, `session_save`, `pane_set_layout`, `pane_focus`, `pane_set_symbol`, `pine_get_source`, `pine_editor_state`, `pine_set_source`, `pine_compile`, `pine_get_errors`, `pine_save`, `pine_get_console`, `pine_smart_compile`, `pine_new`, `pine_open`, `replay_start`, `replay_step`, `replay_autoplay`, `replay_stop`, `replay_trade`, `tab_new`, `layout_new`, `tab_close`, `tab_switch`, `ui_click`, `ui_open_panel`, `ui_fullscreen`, `layout_switch`, `ui_keyboard`, `ui_type_text`, `ui_hover`, `ui_scroll`, `ui_mouse_click`, `watchlist_add`, `watchlist_add_bulk`, `watchlist_remove`.
- `capture_screenshot` refuses `method: "api"` (TradingView's own snapshot publishes the image to its servers); the default local capture is unchanged.
- **`state/` folder** at the repository root (ignored by Git) holds the guard's working files: `scratch-layouts.json` (scratch charts, recorded automatically), `protected-layouts.json` (your own list of layouts, by ID or name pattern, that must never count as scratch; see `protected-layouts.example.json`), `backups/` and `locks/` of the Pine tools.
- Tests: `npm run test:safety` (also part of `npm test`) checks that every registered tool is classified, that read tools send no writes (against a fake DevTools endpoint) and the permission rules, all without TradingView.

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
