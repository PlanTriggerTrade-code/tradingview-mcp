import { z } from 'zod';
import { jsonResult } from './_format.js';
import * as core from '../core/pine.js';

export function registerPineTools(server) {
  server.tool('pine_get_source', 'Get current Pine Script source code from the editor', {}, async () => {
    try { return jsonResult(await core.getSource()); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('pine_editor_state', 'Which script the Pine Editor is bound to (title), whether it has unsaved changes, and buffer size. Call before pine_set_source / pine_new / pine_open.', {}, async () => {
    try { return jsonResult(await core.getEditorState()); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('pine_set_source', 'Replace the Pine Editor buffer with new source. SAFE: refuses if the editor has unsaved changes, and refuses to overwrite a saved script unless `target` names it (or force:true). Use pine_new first for a fresh script.', {
    source: z.string().describe('Pine Script source code to inject'),
    target: z.string().optional().describe('Name of the saved script you intend to overwrite (must equal the editor title). Omit when the editor holds an untitled script.'),
    force: z.boolean().optional().describe('Bypass the unsaved-changes / saved-script guards. Dangerous — only when the user explicitly wants the current buffer discarded.'),
  }, async ({ source, target, force }) => {
    try { return jsonResult(await core.setSource({ source, target, force })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('pine_compile', 'Compile / add the current Pine Script to the chart', {}, async () => {
    try { return jsonResult(await core.compile()); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('pine_get_errors', 'Get Pine Script compilation errors from Monaco markers', {}, async () => {
    try { return jsonResult(await core.getErrors()); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('pine_save', 'Save the current Pine Script via the editor menu (Save script). Handles the name dialog for untitled scripts. Returns success:false if TradingView did not register the save.', {
    name: z.string().optional().describe('Name to give an untitled script when the Save dialog appears (defaults to what TradingView pre-fills).'),
  }, async ({ name }) => {
    try { return jsonResult(await core.save({ name })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('pine_get_console', 'Read Pine Script console/log output (compile messages, log.info(), errors)', {}, async () => {
    try { return jsonResult(await core.getConsole()); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('pine_smart_compile', 'Intelligent compile: detects button, compiles, checks errors, reports study changes', {}, async () => {
    try { return jsonResult(await core.smartCompile()); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('pine_new', 'Create a genuinely new Pine Script through the editor menu (Create new → Indicator/Strategy/Library), binding the editor to a fresh "Untitled script". SAFE: refuses if the current script has unsaved changes (unless force:true).', {
    type: z.enum(['indicator', 'strategy', 'library']).describe('Type of script to create'),
    force: z.boolean().optional().describe('Proceed even if the current buffer has unsaved changes (they may be lost).'),
  }, async ({ type, force }) => {
    try { return jsonResult(await core.newScript({ type, force })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('pine_open', 'Open a saved Pine Script by name through the editor\'s Open dialog, so the editor is actually bound to it. SAFE: refuses if the current script has unsaved changes (unless force:true).', {
    name: z.string().describe('Name of the saved script to open (case-insensitive match)'),
    force: z.boolean().optional().describe('Proceed even if the current buffer has unsaved changes (they may be lost).'),
  }, async ({ name, force }) => {
    try { return jsonResult(await core.openScript({ name, force })); }
    catch (err) { return jsonResult({ success: false, source: 'ui', error: err.message }, true); }
  });

  server.tool('pine_list_scripts', 'List saved Pine Scripts', {}, async () => {
    try { return jsonResult(await core.listScripts()); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('pine_analyze', 'Run static analysis on Pine Script code WITHOUT compiling — catches array out-of-bounds, unguarded array.first()/last(), bad loop bounds, and implicit bool casts. Works offline, no TradingView connection needed.', {
    source: z.string().describe('Pine Script source code to analyze'),
  }, async ({ source }) => {
    try { return jsonResult(core.analyze({ source })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('pine_check', 'Compile Pine Script via TradingView\'s server API without needing the chart open. Returns compilation errors/warnings. Useful for validating code before injecting into the chart.', {
    source: z.string().describe('Pine Script source code to compile/validate'),
  }, async ({ source }) => {
    try { return jsonResult(await core.check({ source })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });
}
