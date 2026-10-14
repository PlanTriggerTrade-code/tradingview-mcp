# Chart protection (layout guard)

This MCP server can change TradingView charts. Your chart layouts hold work you do not want an AI
assistant to change by accident, so every tool goes through a guard (`src/layout-safety.js`).
Many tools are disabled by design. This page explains the rule, how to protect your own layouts,
and which tools do what.

## The rule

- **Reading any chart is allowed.**
- **Changing one of your real charts needs your yes.** The assistant must ask you first and then
  pass `user_approved: true` for that chart.
- **Every layout is a real chart by default.** The only exception is a *scratch chart*: a new empty
  layout the assistant made itself with `scratch_layout_create`. Scratch charts are recorded
  automatically in `state/scratch-layouts.json` and can be changed without asking.
- **Your protected layouts always stay real**, even if the scratch list ever names them (see
  [Protecting your own layouts](#protecting-your-own-layouts)).
- **Every write proves which layout it is on.** The tab's URL layout ID, the layout actually loaded
  in the page and the requested `layout_id` must agree, checked again inside the same browser
  evaluation as the change. On a mismatch the call fails with `LAYOUT_IDENTITY_MISMATCH`, even with
  approval. A URL alone is never accepted as proof of which layout is loaded.
- **Refusals happen before anything is sent** to the page.
- **Never work around a refusal** through raw CDP, the CLI (`tv ...`) or another tool.

## Protecting your own layouts

List the layouts that must never be treated as scratch charts in `state/protected-layouts.json`
(the `state` folder at the repository root; Git ignores it, so it stays on your machine). Start from
[`protected-layouts.example.json`](../protected-layouts.example.json):

```json
{
  "layouts": [
    { "id": "EXAMPLE1", "name": "Example: my main trading chart" },
    { "id": "EXAMPLE2", "name": "Example: my drawings chart" }
  ],
  "names": ["do[\\s_.-]*not[\\s_.-]*touch", "^live\\b"]
}
```

- `layouts[].id` is the layout ID from the chart URL (`https://www.tradingview.com/chart/<id>/`).
  `name` is only a label for you. A listed layout stays protected after you rename it.
- `names` are case-insensitive regular expressions matched against the layout name, for example
  to protect every layout called "Do not touch", "DO_NOT_TOUCH" or "do-not-touch".
- Protected layouts are always real charts: changes need your yes, and the Pine development
  tools refuse them entirely.
- The file is read again on every operation, so edits apply without restarting the server.
- No file means no extra protection, which is still safe because every layout is real by default.
- A file that cannot be read or does not match the format above (bad JSON, unknown keys, a bad
  ID or pattern) makes every write refuse with `PROTECTED_LAYOUTS_INVALID` until it is fixed.
  `layout_safety_inspect` still works and reports the error.

## Target-bound tools

Pass `target_id` (the `id` of a tab from `tab_list`) and `layout_id` (from the chart URL, or
`layout_safety_inspect`).

- Reads, any chart: `layout_safety_inspect` (identity, sections, state hash, whether the layout
  is real or protected), `study_inputs_get` (every input of a study with id, title, value),
  `strategy_trades_get` (a strategy's closed trades), `pine_development_verify` (cloud source of a
  saved script).
- Writes: `chart_set_symbol`, `chart_set_timeframe`, `indicator_set_inputs`,
  `indicator_toggle_visibility`, `chart_manage_indicator` (add/remove). Free on a scratch chart,
  `user_approved: true` on a real one.
- `ui_evaluate` (arbitrary JavaScript) **always** needs `user_approved: true`, scratch charts
  included, and is refused before any connection without it. Raw JavaScript can load and save
  other layouts, delete alerts or overwrite saved scripts from any page, so the layout check
  cannot contain it.
- `scratch_layout_create` makes a new empty layout in the given tab. The layout that was showing
  is not changed, but it leaves the tab, so on a tab showing a real chart it needs
  `user_approved: true`. The new layout is recorded as scratch only if it is a different layout
  from the one before, not protected, and empty (exactly one chart section whose panes hold only
  the main series); otherwise `SCRATCH_NOT_CONFIRMED` and nothing is recorded. If TradingView adds
  a default study (for example Volume) to new layouts, this check refuses; remove that default
  first.
- Pine development (`pine_development_*`, below) compiles by adding the script to the chart: free
  on a scratch chart, with `user_approved: true` on a real chart, never on a protected layout.

Tools that cannot prove which layout they act on stay disabled: they are still listed (their
description ends with `[Disabled: no target-bound implementation]`) but every call returns
`UNSAFE_OPERATION_DISABLED` without touching TradingView.

## Pine development

1. `pine_development_open`: open a saved, unprotected layout in a new tab, given an explicitly
   verified source tab and layout. It never reuses the current tab and requires a layout with one
   chart section.
2. `pine_development_inspect`: on the exact tab and layout, open the Pine panel and return the
   chart ID, layout state hash, editor source hash and the saved-script list.
3. `pine_development_load`: open an exact saved script (by script ID) through TradingView's own
   picker, so the editor is bound to it. The legacy `pine_open` is disabled.
4. `pine_development_update`: back up, lock, update, save and compile an existing script on the
   verified development layout, then read the cloud source back. Pass the IDs and hashes from
   inspect, the script ID, the expected cloud version, the new source, expected input titles and
   `development: true`.
   Saving a script makes TradingView update it on **other open layouts** too. Before saving, the
   tool reads every open chart tab (read-only); if one of your real charts holds a study of that
   script, it refuses with `PINE_SCRIPT_ON_REAL_CHARTS`, naming those layouts, unless
   `user_approved: true`. A tab that cannot be read counts as such a chart. **Layouts that are not
   open in TradingView cannot be checked**; they pick up the new version when next loaded.
5. `pine_development_verify`: read the saved cloud source back and compare hashes (CRLF/LF
   normalized). Use it first after an interrupted save or a timeout; TradingView may finish a save
   later, so never repeat an update only because verification timed out.

These tools act only on the Pine editor that is visible on screen; if no editor is visible they
report it as not ready rather than use a hidden copy. `pine_check` (server-side compile) and
`pine_analyze` (offline) need no chart.

## Limits

- The guard protects this MCP server only, not the CLI (`tv ...`), other CDP clients, other running
  MCP instances or edits you make yourself.
- Approval is per call, not tied to a specific layout ID; the assistant is expected to ask for the
  chart it is about to change.
- TradingView may autosave changes even when nothing calls save. Post-checks detect unexpected
  changes; they do not roll anything back.
- Backups made by the Pine tools (in `state/backups/`) cover the chart collection and its sources,
  not separately stored drawings; they are not a complete restore.
- Locks (`state/locks/`) coordinate guarded operations only. Never remove a lock while its owner
  may still be running.
- Some read tools change what is shown without changing chart content: `watchlist_get` opens the
  watchlist panel if it is closed, and the strategy tools open the Strategy Tester panel when
  TradingView has not computed the report yet.
- `capture_screenshot` with `method: "api"` is refused: TradingView's own snapshot publishes the
  image to its servers. The default capture saves a local file.

## How the guard is installed

`src/server.js` registers the Pine development tools, then installs `protectRegistrations` on
`server.tool` before any tool group registers, so a tool added later is disabled until someone
classifies it. The server's active-tab follower is installed on top of the guard: read tools
re-attach to the tab you are looking at inside the guard's queue; guarded writes attach to the
exact `target_id`. `server.registerTool` and any registration other than
`(name, description, shape, handler)` throw at startup.

## Tests

`npm run test:safety` runs the guard tests without TradingView: fake CDP clients, and for the read
tools a fake DevTools endpoint on a random local port (`tests/helpers/fake-cdp.js`).

- `tests/layout-safety-classification.test.js` registers every real tool group through the guard
  and fails when a tool is not in the table below, when the table and the code disagree, or when
  the server starts without the guard.
- `tests/layout-safety-read-tools.test.js` runs every read tool through the guard and fails if any
  command or evaluated expression is a write (`setSymbol`, `setResolution`, `createStudy`,
  `removeEntity`, `setInputValues`, `executeActionById`, `saveChartToServer`,
  `loadChartFromServer`, `createNewLayout`, `removeAllStudies`, `setVisible`,
  `applyStudyTemplate`, keyboard events, CDP `Input.*`, navigation, tab activation...). The fake
  page answers with no data, so each tool is checked up to the point where it needs real chart
  data.
- The permission and Pine tests use made-up layout IDs and inject the protection list through a
  temporary state folder.

## Tool classification

Read = changes nothing in TradingView: not the chart, layout, drawings, alerts, watchlist, panes,
tabs, Pine editor or saved scripts. Guarded write = has a target-bound implementation in the guard.
Everything else is disabled. When unsure, disabled.

| Tool | Class | Why |
|---|---|---|
| `chart_get_state` | read | Reads symbol, resolution, studies. |
| `chart_get_visible_range` | read | Reads the visible range. |
| `symbol_info` | read | Reads the chart's symbol info. |
| `symbol_search` | read | TradingView's public search API; no chart access. |
| `quote_get` | read | Quote session snapshot; never touches the chart. |
| `data_get_ohlcv` | read | Reads loaded bars. |
| `data_get_indicator` | read | Reads a study's inputs. |
| `data_get_study_values` | read | Reads study values. |
| `data_get_pine_lines` | read | Reads Pine drawings. |
| `data_get_pine_labels` | read | Reads Pine drawings. |
| `data_get_pine_boxes` | read | Reads Pine drawings. |
| `data_get_pine_tables` | read | Reads Pine drawings. |
| `data_get_strategy_results` | read | Reads the strategy report. If TradingView has not computed it yet, it shows the Strategy Tester panel (view only; chart and layout unchanged). |
| `data_get_trades` | read | As `data_get_strategy_results`. |
| `data_get_equity` | read | As `data_get_strategy_results`. |
| `depth_get` | read | Reads the DOM panel if it is open. |
| `draw_list` | read | Lists drawings. |
| `draw_get_properties` | read | Reads one drawing. |
| `alert_list` | read | Alerts REST list. |
| `pine_check` | read | Server-side compile; no chart or editor. |
| `pine_list_scripts` | read | Saved-script list (REST). |
| `pine_analyze` | read | Offline static analysis. |
| `replay_status` | read | Reads replay state. |
| `layout_list` | read | Saved-layout list. |
| `pane_list` | read | Reads panes. |
| `tab_list` | read | Reads the tab bar and each page; switches nothing. Its `id` is the `target_id` for target-bound tools. |
| `tv_health_check` | read | Connection check. |
| `tv_discover` | read | Reports available APIs. |
| `tv_ui_state` | read | Reads UI state. |
| `ui_find_element` | read | Queries the DOM. |
| `capture_screenshot` | read | CDP screenshot to a local file. `method: "api"` is refused by the guard: TradingView's `takeScreenshot()` publishes a snapshot to its servers. |
| `watchlist_get` | read | Reads the watchlist rows. If the right-hand watchlist panel is closed it clicks the panel button to open it (view only; the list is unchanged). |
| `session_get` | read | Reads a saved brief from `~/.tradingview-mcp/sessions`; no TradingView access. |
| `chart_set_symbol` | guarded write | Target-bound `setSymbol`. |
| `chart_set_timeframe` | guarded write | Target-bound `setResolution`. |
| `indicator_set_inputs` | guarded write | Target-bound input change; refuses unknown input IDs. |
| `indicator_toggle_visibility` | guarded write | Target-bound `setVisible`. |
| `chart_manage_indicator` | guarded write | Target-bound `createStudy` / `removeEntity`. |
| `ui_evaluate` | guarded write | Always needs `user_approved: true`, scratch charts included; then runs the expression after the layout is proven and returns its value. |
| `layout_safety_inspect` | read | Guard tool: identity, sections, state hash, real or scratch. |
| `study_inputs_get` | read | Guard tool: target-bound input read. |
| `strategy_trades_get` | read | Guard tool: target-bound closed-trade read. |
| `pine_development_verify` | read | Guard tool: cloud source read-back. |
| `scratch_layout_create` | guarded write | Guard tool: new layout in the given tab, recorded as scratch only if new and empty; needs approval when the tab shows a real chart. |
| `pine_development_open` | guarded write | Guard tool: opens an unprotected layout in a new tab. |
| `pine_development_inspect` | guarded write | Guard tool: opens the Pine panel on a verified layout. |
| `pine_development_load` | guarded write | Guard tool: binds the editor to an exact saved script. |
| `pine_development_update` | guarded write | Guard tool: verified save and compile; approval needed when an open real chart uses the script. |
| `alert_create` | disabled | Creates alerts. |
| `alert_delete` | disabled | Deletes alerts. |
| `batch_run` | disabled | Switches symbols/timeframes on the active chart. |
| `chart_set_type` | disabled | Chart change without a target-bound implementation. |
| `chart_set_visible_range` | disabled | Zooms and pages history; no target-bound implementation. |
| `chart_scroll_to_date` | disabled | As `chart_set_visible_range`. |
| `draw_shape` | disabled | Creates drawings. |
| `draw_clear` | disabled | Removes all drawings. |
| `draw_remove_one` | disabled | Removes a drawing. |
| `tv_launch` | disabled | Starts or restarts TradingView. |
| `indicator_search` | disabled | Opens the Indicators dialog and types into it. |
| `indicator_add` | disabled | Adds a study through the dialog on the active chart; use `chart_manage_indicator` (guarded). |
| `morning_brief` | disabled | Switches the chart through every watchlist symbol and back. |
| `session_save` | disabled | Writes a local file only, but it exists only to store `morning_brief` output, which is disabled. |
| `pane_set_layout` | disabled | Changes the pane grid. |
| `pane_focus` | disabled | Changes the active pane. |
| `pane_set_symbol` | disabled | Changes a pane's symbol. |
| `pine_get_source` | disabled | Opens the Pine editor on the untargeted active tab (can hide and reopen the bottom panel); use `pine_development_inspect`. |
| `pine_editor_state` | disabled | Opens the Pine editor like `pine_get_source`. |
| `pine_set_source` | disabled | Replaces the editor buffer. |
| `pine_compile` | disabled | Adds the script to the chart. |
| `pine_get_errors` | disabled | Opens the Pine editor like `pine_get_source`. |
| `pine_save` | disabled | Saves a script to the cloud. |
| `pine_get_console` | disabled | Opens the Pine editor like `pine_get_source`. |
| `pine_smart_compile` | disabled | Compiles onto the chart. |
| `pine_new` | disabled | Rebinds the editor. |
| `pine_open` | disabled | Rebinds the editor; use `pine_development_load`. |
| `replay_start` | disabled | Starts replay. |
| `replay_step` | disabled | Moves replay. |
| `replay_autoplay` | disabled | Moves replay. |
| `replay_stop` | disabled | Ends replay and scrolls the chart. |
| `replay_trade` | disabled | Places replay trades. |
| `tab_new` | disabled | Opens a tab (and can create or open layouts). |
| `layout_new` | disabled | Creates a layout in a new tab; use `scratch_layout_create`. |
| `tab_close` | disabled | Closes a tab. |
| `tab_switch` | disabled | Changes the tab the user sees and the tab later tools act on. |
| `ui_click` | disabled | Generic UI input. |
| `ui_open_panel` | disabled | Generic UI input. |
| `ui_fullscreen` | disabled | Generic UI input. |
| `layout_switch` | disabled | Loads another layout into the tab. |
| `ui_keyboard` | disabled | Generic UI input. |
| `ui_type_text` | disabled | Generic UI input. |
| `ui_hover` | disabled | Generic UI input. |
| `ui_scroll` | disabled | Generic UI input. |
| `ui_mouse_click` | disabled | Generic UI input. |
| `watchlist_add` | disabled | Changes the watchlist. |
| `watchlist_add_bulk` | disabled | Changes the watchlist. |
| `watchlist_remove` | disabled | Changes the watchlist. |

## Adding a write capability

- Bind it to an explicit target and a limited operation, check the layout identity in the same
  evaluation as the change, and require `user_approved` on real charts.
- Preserve every chart section, study, input and drawing that the operation should not touch, and
  compare them afterwards.
- Classify the tool in `READ_TOOLS`/`WRITE_TOOLS` and in the table above; the classification test
  enforces both.
- Test identity mismatches, protected layouts, stale state and competing writers with fake
  clients, never against your own charts.
