# Chart protection

**Rule:** a tool never changes one of your protected charts without your yes. A chart is protected
when the layout actually loaded in the tab (not the one the URL shows) is listed in
`state/protected-layouts.json`. Before any tool that may change a chart runs, the guard reads the
layout loaded in the tab it will act on; if that layout is protected, the tool is refused with
`PROTECTED_CHART_NEEDS_PERMISSION` unless `user_approved: true` is passed, which the assistant may
only do after you said yes for that chart. Every other chart, and every read, is free.

## Listing your protected charts

Copy [`protected-layouts.example.json`](../protected-layouts.example.json) to
`state/protected-layouts.json` (the `state` folder at the repository root; Git ignores it):

```json
{
  "layouts": [
    { "id": "EXAMPLE1", "name": "Example: my main trading chart" },
    { "id": "EXAMPLE2", "name": "Example: my drawings chart" }
  ],
  "names": ["do[\\s_.-]*not[\\s_.-]*touch", "^live\\b"]
}
```

- `layouts[].id` is the layout ID from the chart URL (`https://www.tradingview.com/chart/<id>/`);
  `name` is only a label. A listed layout stays protected after you rename it.
- `names` are case-insensitive regular expressions matched against the layout name.
- The file is read on every check, so edits apply without a restart. No file means nothing is
  protected. A file that cannot be read or has the wrong format makes every change refuse with
  `PROTECTED_LAYOUTS_INVALID` until it is fixed.

## Details

- Tools that may change a chart (class `checked` below) accept an optional `layout_id`; if given,
  it must equal the layout loaded in the tab. While such a tool runs, the connection stays pinned to
  the tab that was checked, so it cannot drift to another tab.
- Saving a Pine script (`pine_save`, `pine_compile`, `pine_smart_compile`,
  `pine_development_update`) also updates it on other open layouts that use it. The save is refused
  without approval only when an open protected chart uses the script; the result names any it
  updated, and says so when the script or a tab could not be checked. Layouts not open in
  TradingView cannot be checked.
- `layout_safety_inspect` shows which layout a tab (from `tab_list`) really has loaded and whether
  it is protected.
- Residual risk: raw JavaScript and raw clicks or keys (`ui_evaluate`, `ui_click`, `ui_keyboard`,
  `ui_type_text`, `ui_mouse_click`) are checked against the tab they start in, but could navigate
  to or act on another layout from there.
- The guard protects this MCP server only, not the CLI (`tv ...`) or other programs. Never work
  around a refusal through raw CDP, the CLI or another tool.
- A tool added later that nobody has classified is disabled until it is reviewed
  (`src/layout-safety.js`; the tests check that the table below matches).

## Tool classes

`read` and `account` tools run freely; `checked` tools follow the rule above.

| Tool | Class | What it does |
|---|---|---|
| `chart_get_state` | read | Reads symbol, resolution, studies. |
| `chart_get_visible_range` | read | Reads the visible range. |
| `symbol_info` | read | Reads the chart's symbol info. |
| `symbol_search` | read | TradingView's public search API; no chart access. |
| `quote_get` | read | Quote session snapshot; never touches the chart. |
| `data_get_ohlcv` | read | Reads loaded bars. |
| `data_export_ohlcv` | read | Writes the loaded bars to a local CSV file. |
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
| `capture_screenshot` | read | Screenshot to a local file. `method: "api"` uses TradingView's own snapshot, which publishes the image to TradingView's servers; no chart change either way. |
| `watchlist_get` | read | Reads the watchlist rows. If the right-hand watchlist panel is closed it clicks the panel button to open it (view only; the list is unchanged). |
| `session_get` | read | Reads a saved brief from `~/.tradingview-mcp/sessions`; no TradingView access. |
| `pine_get_source` | read | Opens the Pine editor panel if needed and reads the source; chart and editor contents unchanged. |
| `pine_get_errors` | read | As `pine_get_source`, reads compile errors. |
| `pine_get_console` | read | As `pine_get_source`, reads the Pine console. |
| `pine_editor_state` | read | As `pine_get_source`, reads which script the editor is bound to. |
| `indicator_search` | read | Opens the Indicators dialog, fills its search box, reads the results and closes it; adds nothing. |
| `layout_safety_inspect` | read | Which layout a tab (target_id) really has loaded, and whether it is protected. |
| `study_inputs_get` | read | Every input of a study in a tab (target_id). |
| `strategy_trades_get` | read | A strategy's closed trades in a tab (target_id). |
| `pine_development_verify` | read | Reads a saved script's cloud source back. |
| `alert_create` | account | Creates a price alert. |
| `alert_delete` | account | Deletes alerts. |
| `watchlist_add` | account | Adds a symbol to the watchlist. |
| `watchlist_add_bulk` | account | Adds symbols to the watchlist. |
| `watchlist_remove` | account | Removes symbols from the watchlist. |
| `tv_launch` | account | Starts TradingView (may close one running without the debug port). |
| `tab_new` | account | Opens a tab, optionally with a new or saved layout. |
| `tab_close` | account | Closes the active tab. |
| `tab_switch` | account | Switches the active tab. |
| `layout_new` | account | Creates a new layout in a new tab. |
| `session_save` | account | Writes a local file. |
| `ui_fullscreen` | account | Toggles fullscreen. |
| `pine_set_source` | account | Replaces the Pine editor's text. |
| `pine_open` | account | Opens a saved script in the Pine editor. |
| `ui_hover` | account | Moves the mouse. |
| `ui_open_panel` | account | Opens or closes a panel. |
| `chart_set_symbol` | checked | Changes the symbol. |
| `chart_set_timeframe` | checked | Changes the timeframe. |
| `chart_set_type` | checked | Changes the chart style. |
| `chart_set_visible_range` | checked | Zooms the chart. |
| `chart_scroll_to_date` | checked | Scrolls the chart. |
| `chart_manage_indicator` | checked | Adds or removes a study. |
| `indicator_set_inputs` | checked | Changes study inputs. |
| `indicator_toggle_visibility` | checked | Shows or hides a study. |
| `indicator_add` | checked | Adds a study through the Indicators dialog. |
| `draw_shape` | checked | Draws on the chart. |
| `draw_clear` | checked | Removes all drawings. |
| `draw_remove_one` | checked | Removes a drawing. |
| `morning_brief` | checked | Switches the chart through the watchlist symbols. |
| `batch_run` | checked | Switches the chart through symbols and timeframes. |
| `pane_set_layout` | checked | Changes the pane grid. |
| `pane_focus` | checked | Changes the active pane. |
| `pane_set_symbol` | checked | Changes a pane's symbol. |
| `pine_new` | checked | Creates a new script through the editor menu (its click could land on the chart). |
| `pine_compile` | checked | Adds or updates the script on the chart; can save it. |
| `pine_save` | checked | Saves the script. |
| `pine_smart_compile` | checked | As `pine_compile`. |
| `replay_start` | checked | Starts replay. |
| `replay_step` | checked | Moves replay. |
| `replay_autoplay` | checked | Moves replay. |
| `replay_stop` | checked | Ends replay. |
| `replay_trade` | checked | Places replay trades. |
| `layout_switch` | checked | Loads another layout into the tab (discarding unsaved changes of the one it leaves). |
| `ui_evaluate` | checked | Runs JavaScript in the tab. |
| `ui_click` | checked | Clicks in the tab. |
| `ui_keyboard` | checked | Presses keys in the tab. |
| `ui_type_text` | checked | Types in the tab. |
| `ui_mouse_click` | checked | Clicks at coordinates in the tab. |
| `ui_scroll` | checked | Scrolls (and zooms) the chart. |
| `pine_development_open` | checked | Opens a layout in a new tab for Pine development. |
| `pine_development_inspect` | checked | Opens the Pine panel on an explicit tab and layout. |
| `pine_development_load` | checked | Binds the editor to an exact saved script. |
| `pine_development_update` | checked | Backs up, saves and compiles a script, with a verified cloud save. |
