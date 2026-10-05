import { z } from 'zod';
import { jsonResult } from './_format.js';
import * as core from '../core/tab.js';

export function registerTabTools(server) {
  server.tool('tab_list', 'List open TradingView tabs in tab-bar order, with the active one flagged (active_index), each with its layout name and symbol', {}, async () => {
    try { return jsonResult(await core.list()); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('tab_new', 'Open a new chart tab. Optionally pick what to load in it: layout "new" creates a named blank layout, or pass a saved layout name to open it.', {
    layout: z.string().optional().describe('"new" for a blank new layout, or a saved layout name (substring match). Omit to leave the tab on the layout picker.'),
    name: z.string().optional().describe('Name for the new layout (used with layout: "new"; default "New layout")'),
  }, async ({ layout, name }) => {
    try { return jsonResult(await core.newTab({ layout, name })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('layout_new', 'Create a new named blank chart layout (opens in a new tab)', {
    name: z.string().optional().describe('Layout name (default "New layout")'),
  }, async ({ name }) => {
    try { return jsonResult(await core.newTab({ layout: 'new', name })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('tab_close', 'Close the current chart tab', {}, async () => {
    try { return jsonResult(await core.closeTab()); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('tab_switch', 'Switch TradingView to a tab by index (tab-bar order from tab_list); later tool calls act on that tab', {
    index: z.coerce.number().describe('Tab index (0-based, from tab_list)'),
  }, async ({ index }) => {
    try { return jsonResult(await core.switchTab({ index })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });
}
