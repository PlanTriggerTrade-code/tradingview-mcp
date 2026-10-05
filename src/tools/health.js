import { z } from 'zod';
import { jsonResult } from './_format.js';
import { booleanParam } from './_schema.js';
import * as core from '../core/health.js';

export function registerHealthTools(server) {
  server.tool('tv_health_check', 'Check CDP connection to TradingView and return current chart state', {}, async () => {
    try { return jsonResult(await core.healthCheck()); }
    catch (err) { return jsonResult({ success: false, error: err.message, hint: 'TradingView is not running with CDP enabled. Use the tv_launch tool to start it automatically.' }, true); }
  });

  server.tool('tv_discover', 'Report which known TradingView API paths are available and their methods', {}, async () => {
    try { return jsonResult(await core.discover()); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('tv_ui_state', 'Get current UI state: which panels are open, what buttons are visible/enabled/disabled', {}, async () => {
    try { return jsonResult(await core.uiState()); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('tv_launch', 'Start TradingView Desktop with the debug port (CDP) open. Does nothing if the port is already open. Finds the app on Mac, Windows and Linux; on Windows the Microsoft Store build is started through COM app activation, which keeps the normal profile and login.', {
    port: z.coerce.number().optional().describe('CDP port (default 9222)'),
    kill_existing: booleanParam().optional().describe('Close a TradingView that is running without the debug port first (default true)'),
    allow_local_copy: booleanParam().optional().describe('Windows Store build only, last resort: if the debug port still will not open, run TradingView from a copy of the package in %LOCALAPPDATA% (~330MB once per version; may start signed out). Default false.'),
  }, async ({ port, kill_existing, allow_local_copy }) => {
    try { return jsonResult(await core.launch({ port, kill_existing, allow_local_copy })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

}
