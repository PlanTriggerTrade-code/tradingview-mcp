/**
 * Core Pine Script logic — shared between MCP tools and CLI.
 * All functions accept plain options objects and return plain JS objects.
 * They throw on error (callers catch and format).
 */
import { evaluate, evaluateAsync, getClient } from '../connection.js';

// ── Monaco finder (injected into TV page) ──
const FIND_MONACO = `
  (function findMonacoEditor() {
    var container = document.querySelector('.monaco-editor.pine-editor-monaco');
    if (!container) return null;
    var el = container;
    var fiberKey;
    for (var i = 0; i < 20; i++) {
      if (!el) break;
      fiberKey = Object.keys(el).find(function(k) { return k.startsWith('__reactFiber$'); });
      if (fiberKey) break;
      el = el.parentElement;
    }
    if (!fiberKey) return null;
    var current = el[fiberKey];
    for (var d = 0; d < 15; d++) {
      if (!current) break;
      if (current.memoizedProps && current.memoizedProps.value && current.memoizedProps.value.monacoEnv) {
        var env = current.memoizedProps.value.monacoEnv;
        if (env.editor && typeof env.editor.getEditors === 'function') {
          var editors = env.editor.getEditors();
          if (editors.length > 0) return { editor: editors[0], env: env };
        }
      }
      current = current.return;
    }
    return null;
  })()
`;

// The Pine Editor's add/update-to-chart control is an ICON-ONLY button on
// TradingView Desktop 3.4.x: no text, and no title until a script has been
// added once (then it gains title="Update on chart"). Matching on text alone
// silently falls through to the Save button, which reports success while
// never putting the study on the chart. Identify it by title, then by its
// SVG path, before falling back to text. Never falls back to the editor's Save
// button: that saved whatever script happened to be open (#518).
const RUN_BUTTON_SVG_PREFIX = 'm10.82 6.82';

const FIND_RUN_BUTTON = `
  (function findRunButton() {
    var btns = document.querySelectorAll('button');
    var byTitle = null, byText = null, byPath = null;
    for (var i = 0; i < btns.length; i++) {
      var b = btns[i];
      var r = b.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) continue;
      var text = (b.textContent || '').trim();
      if (/save and add to chart/i.test(text)) return { el: b, how: 'Save and add to chart' };
      var attr = (b.getAttribute('title') || '') + ' ' + (b.getAttribute('aria-label') || '');
      if (!byTitle && /(add to chart|update on chart)/i.test(attr)) byTitle = b;
      if (!byText && /^(Add to chart|Update on chart)/i.test(text)) byText = b;
      if (!byPath) {
        var pathEl = b.querySelector('svg path');
        var d = pathEl ? (pathEl.getAttribute('d') || '') : '';
        if (d.indexOf('${RUN_BUTTON_SVG_PREFIX}') === 0) byPath = b;
      }
    }
    if (byTitle) return { el: byTitle, how: (byTitle.getAttribute('title') || 'Add to chart').trim() };
    if (byText)  return { el: byText,  how: byText.textContent.trim() };
    if (byPath)  return { el: byPath,  how: 'Add to chart (icon)' };
    return null;
  })()
`;


/**
 * Opens the Pine Editor panel and waits for Monaco to become available.
 * Returns true if editor is accessible, false on timeout.
 */
export async function ensurePineEditorOpen() {
  const already = await evaluate(`
    (function() {
      var m = ${FIND_MONACO};
      return m !== null;
    })()
  `);
  if (already) return true;

  // 'scripteditor' is the widget's registered name; activateScriptEditorTab()
  // silently no-ops while the widget is missing from the bar's enabled list
  // (the state after the user closes the panel), so enable + show come first.
  const OPEN_EDITOR = `
    (function() {
      var bwb = window.TradingView && window.TradingView.bottomWidgetBar;
      if (!bwb) return false;
      if (typeof bwb.setWidgetAvailability === 'function') bwb.setWidgetAvailability('scripteditor', true);
      if (typeof bwb.showWidget === 'function') bwb.showWidget('scripteditor');
      if (typeof bwb.activateScriptEditorTab === 'function') bwb.activateScriptEditorTab();
      return true;
    })()
  `;
  await evaluate(OPEN_EDITOR);

  await evaluate(`
    (function() {
      var btn = document.querySelector('[aria-label="Pine"]')
        || document.querySelector('[data-name="pine-dialog-button"]');
      if (btn) btn.click();
    })()
  `);

  let remounted = false;
  for (let i = 0; i < 50; i++) {
    await new Promise(r => setTimeout(r, 200));
    const ready = await evaluate(`(function() { return ${FIND_MONACO} !== null; })()`);
    if (ready) return true;
    // Stale mount: Monaco DOM is present but its subtree carries no React
    // fiber keys, so FIND_MONACO can never succeed against it. Hide the bar
    // and reopen once to force a fresh React-attached mount.
    if (!remounted && i >= 15) {
      const zombie = await evaluate(`!!document.querySelector('.monaco-editor.pine-editor-monaco')`);
      if (zombie) {
        await evaluate(`
          (function() {
            var bwb = window.TradingView && window.TradingView.bottomWidgetBar;
            if (bwb && typeof bwb.hide === 'function') bwb.hide();
          })()
        `);
        await new Promise(r => setTimeout(r, 400));
        await evaluate(OPEN_EDITOR);
        // Consume the one-shot only on an actual remount attempt, so a
        // slow first mount that turns out fiber-less can still be recovered.
        remounted = true;
      }
    }
  }
  return false;
}

// ── Editor state + safe UI helpers ──
//
// TradingView's Pine Editor holds ONE buffer bound to ONE script (saved or "Untitled script").
// Monaco setValue() on that buffer does not change the binding, so a naive "set source" or
// "open" silently replaces whatever script is bound — and a later Save writes it to the cloud
// under that script's name. Everything below exists to make that impossible by accident:
// read the binding first, refuse to clobber, and drive TradingView's own menu for new/open/save.

const delay = (ms) => new Promise(r => setTimeout(r, ms));

const EDITOR_STATE_JS = `
  (function() {
    var m = ${FIND_MONACO};
    var title = null;
    var nameBtns = document.querySelectorAll('[class*="nameButton"]');
    for (var i = 0; i < nameBtns.length; i++) {
      if (nameBtns[i].offsetParent !== null) { title = (nameBtns[i].textContent || '').trim(); break; }
    }
    var versionLabel = null;
    var all = document.querySelectorAll('button, [class*="button"]');
    for (var j = 0; j < all.length; j++) {
      var tip = all[j].getAttribute('data-tooltip') || all[j].getAttribute('title') || '';
      if (/select script version/i.test(tip) && all[j].offsetParent !== null) { versionLabel = (all[j].textContent || '').trim(); break; }
    }
    var saveUnsaved = false;
    var btns = document.querySelectorAll('button');
    for (var k = 0; k < btns.length; k++) {
      var c = String(btns[k].className || '');
      if (c.indexOf('saveButton') !== -1 && /unsaved/.test(c)) { saveUnsaved = true; break; }
    }
    var value = m ? m.editor.getValue() : null;
    var norm = value === null ? '' : value.replace(/\\r\\n/g, '\\n');
    var lineCount = value === null ? null : norm.split('\\n').length;
    var isUntitled = !title || /^Untitled script/i.test(title);
    // Title declared by the script itself: indicator("...") / strategy("...") / library("...")
    var tm = norm.match(/^[ \\t]*(indicator|strategy|library)\\s*\\(\\s*(["'])([^"'\\n]*)\\2/m);
    var scriptTitle = tm ? tm[3] : null;
    // TradingView's blank templates: a default title and a handful of lines. Not user work.
    var pristine = isUntitled && lineCount !== null && lineCount <= 12 &&
      /^(My script|My strategy|MyLibrary)$/.test(scriptTitle || '');
    // A saved script reports "Unsaved version" once modified. An untitled script has no version
    // selector, so for it "unsaved" means: holds something other than the blank template.
    var unsaved = isUntitled ? !pristine : (versionLabel === 'Unsaved version' || saveUnsaved);
    return {
      editor_found: !!m,
      title: title,
      version_label: versionLabel,
      unsaved: unsaved,
      is_untitled: isUntitled,
      pristine_template: pristine,
      script_title: scriptTitle,
      line_count: lineCount,
      char_count: value === null ? null : value.length
    };
  })()
`;

const CLICK_TITLE_MENU_JS = `
  (function() {
    var els = document.querySelectorAll('[class*="nameButton"]');
    for (var i = 0; i < els.length; i++) { if (els[i].offsetParent !== null) { els[i].click(); return true; } }
    return false;
  })()
`;

const MENU_ITEM_SELECTOR = '[role="menuitem"], [class*="menu"] [class*="item"], [class*="popup"] [class*="item"], [class*="dropdown"] [class*="item"]';

// mode: 'click' → clicks the first visible menu item whose text starts with `label`, returns its text
//       'rect'  → returns the centre {x,y} of that item (for real pointer events / hover flyouts)
const menuItemJS = (label, mode) => `
  (function() {
    var want = ${JSON.stringify(label)};
    var els = document.querySelectorAll(${JSON.stringify(MENU_ITEM_SELECTOR)});
    for (var i = 0; i < els.length; i++) {
      var e = els[i];
      if (e.offsetParent === null) continue;
      var s = (e.textContent || '').trim();
      if (s.indexOf(want) === 0) {
        ${mode === 'click'
          ? "e.click(); return s;"
          : "var r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 };"}
      }
    }
    return null;
  })()
`;

// Centre of the first visible leaf-ish element whose trimmed text equals `text` (optionally inside `scopeSel`)
const exactTextRectJS = (text, scopeSel) => `
  (function() {
    var want = ${JSON.stringify(text)};
    var root = ${scopeSel ? `document.querySelector(${JSON.stringify(scopeSel)})` : 'document'};
    if (!root) return null;
    var els = root.querySelectorAll('*');
    for (var i = 0; i < els.length; i++) {
      var e = els[i];
      if (e.children.length > 4 || e.offsetParent === null) continue;
      if ((e.textContent || '').trim() === want) {
        var r = e.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
      }
    }
    return null;
  })()
`;

const DIALOG_INFO_JS = `
  (function() {
    var out = [];
    var ds = document.querySelectorAll('[role="dialog"]');
    for (var i = 0; i < ds.length; i++) {
      var d = ds[i];
      if (d.offsetParent === null) continue;
      var inputs = [], ins = d.querySelectorAll('input');
      for (var j = 0; j < ins.length; j++) if (ins[j].offsetParent !== null) inputs.push({ placeholder: ins[j].placeholder || '', value: String(ins[j].value || '').slice(0, 80) });
      var buttons = [], bs = d.querySelectorAll('button');
      for (var k = 0; k < bs.length; k++) if (bs[k].offsetParent !== null) buttons.push((bs[k].textContent || '').trim().slice(0, 30) || ('[' + (bs[k].getAttribute('aria-label') || '') + ']'));
      out.push({ text: (d.textContent || '').trim().slice(0, 120), inputs: inputs, buttons: buttons });
    }
    return out;
  })()
`;

// Clicks the first visible button in any open dialog whose text/aria-label matches the regex source
const clickDialogButtonJS = (regexSource) => `
  (function() {
    var re = new RegExp(${JSON.stringify(regexSource)}, 'i');
    var ds = document.querySelectorAll('[role="dialog"]');
    for (var i = 0; i < ds.length; i++) {
      var d = ds[i];
      if (d.offsetParent === null) continue;
      var bs = d.querySelectorAll('button');
      for (var k = 0; k < bs.length; k++) {
        var b = bs[k];
        if (b.offsetParent === null) continue;
        var s = ((b.textContent || '').trim() + ' ' + (b.getAttribute('aria-label') || '')).trim();
        if (re.test(s)) { b.click(); return s; }
      }
    }
    return null;
  })()
`;

const setDialogInputJS = (value) => `
  (function() {
    var ins = document.querySelectorAll('[role="dialog"] input');
    for (var i = 0; i < ins.length; i++) {
      var inp = ins[i];
      if (inp.offsetParent === null) continue;
      var setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      inp.focus();
      setter.call(inp, ${JSON.stringify(value)});
      inp.dispatchEvent(new Event('input', { bubbles: true }));
      inp.dispatchEvent(new Event('change', { bubbles: true }));
      return inp.value;
    }
    return null;
  })()
`;

async function realMouse(x, y, { click = true } = {}) {
  const c = await getClient();
  await c.Input.dispatchMouseEvent({ type: 'mouseMoved', x, y });
  if (click) {
    await c.Input.dispatchMouseEvent({ type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await c.Input.dispatchMouseEvent({ type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  }
}

async function pressEscape() {
  const c = await getClient();
  await c.Input.dispatchKeyEvent({ type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await c.Input.dispatchKeyEvent({ type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
}

async function openTitleMenu() {
  const ok = await evaluate(CLICK_TITLE_MENU_JS);
  if (!ok) throw new Error('Pine Editor title control not found (TradingView UI may have changed). Nothing was changed.');
  await delay(500);
}

async function openDialogs() {
  return (await evaluate(DIALOG_INFO_JS)) || [];
}

/**
 * Which script is the editor bound to, and does it have unsaved changes?
 * Read this before any operation that replaces the buffer.
 */
export async function getEditorState() {
  const editorReady = await ensurePineEditorOpen();
  if (!editorReady) throw new Error('Could not open Pine Editor.');
  const s = await evaluate(EDITOR_STATE_JS);
  if (!s || !s.editor_found) throw new Error('Monaco editor not found.');
  return { success: true, ...s };
}

/** Title declared by a Pine source: indicator("...") / strategy("...") / library("..."). */
export function scriptTitleOf(source) {
  const m = String(source || '').match(/^[ \t]*(indicator|strategy|library)\s*\(\s*(["'])([^"'\n]*)\2/m);
  return m ? m[3] : null;
}

/**
 * Pure guard (unit-tested): decides whether the editor buffer may be replaced.
 *  - saved script with unsaved changes → refuse
 *  - saved script, clean → refuse unless `target` names exactly that script
 *  - untitled script holding real work (not the blank template) → refuse, EXCEPT when the caller
 *    is iterating on that same script (incomingTitle equals the buffer's own indicator() title)
 *  - `force` bypasses everything
 * Throws a descriptive Error; returns nothing on success.
 */
export function assertBufferReplaceable(state, { force = false, target, incomingTitle, action = 'replace the editor buffer' } = {}) {
  if (force) return;
  const lines = state.line_count != null ? ` (${state.line_count} lines)` : '';

  if (state.is_untitled) {
    if (!state.unsaved) return; // blank template — nothing to lose
    const own = state.script_title || 'untitled';
    const sameScript = incomingTitle != null && state.script_title != null
      && incomingTitle === state.script_title && !/^(My script|My strategy|MyLibrary)$/.test(state.script_title);
    if (sameScript) return; // iterating on the same untitled script
    throw new Error(`Refusing to ${action}: the Pine Editor holds unsaved work titled "${own}"${lines} in an untitled script` +
      (incomingTitle != null ? ` and the new source is titled "${incomingTitle}"` : '') +
      `. Save it first (pine_save), or pass force:true to discard it.`);
  }

  if (state.unsaved) {
    throw new Error(`Refusing to ${action}: the Pine Editor has unsaved changes in "${state.title}"${lines}. ` +
      `Save them first (pine_save), or pass force:true to discard them.`);
  }
  if (target !== state.title) {
    throw new Error(`Refusing to ${action}: the editor is bound to the saved script "${state.title}" — this would overwrite it. ` +
      `Pass target:${JSON.stringify(state.title)} to confirm you mean to replace that script's source, or create a fresh script first with pine_new.`);
  }
}

// ── Pure / offline functions ──

export function analyze({ source }) {
  const lines = source.split('\n');
  const diagnostics = [];

  let isV6 = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('//@version=6')) { isV6 = true; break; }
    if (trimmed.startsWith('//@version=')) break;
    if (trimmed === '' || trimmed.startsWith('//')) continue;
    break;
  }

  const arrays = new Map();
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fromMatch = line.match(/(\w+)\s*=\s*array\.from\(([^)]*)\)/);
    if (fromMatch) {
      const name = fromMatch[1].trim();
      const args = fromMatch[2].trim();
      const size = args === '' ? 0 : args.split(',').length;
      arrays.set(name, { name, size, line: i + 1 });
      continue;
    }
    const newMatch = line.match(/(\w+)\s*=\s*array\.new(?:<\w+>|_\w+)\((\d+)?/);
    if (newMatch) {
      const name = newMatch[1].trim();
      const size = newMatch[2] !== undefined ? parseInt(newMatch[2], 10) : null;
      arrays.set(name, { name, size, line: i + 1 });
    }
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const pattern = /array\.(get|set)\(\s*(\w+)\s*,\s*(-?\d+)/g;
    let match;
    while ((match = pattern.exec(line)) !== null) {
      const method = match[1];
      const arrName = match[2];
      const idx = parseInt(match[3], 10);
      const info = arrays.get(arrName);
      if (!info || info.size === null) continue;
      if (idx < 0 || idx >= info.size) {
        diagnostics.push({
          line: i + 1, column: match.index + 1,
          message: `array.${method}(${arrName}, ${idx}) — index ${idx} out of bounds (array size is ${info.size})`,
          severity: 'error',
        });
      }
    }
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const firstLastPattern = /(\w+)\.(first|last)\(\)/g;
    let match;
    while ((match = firstLastPattern.exec(line)) !== null) {
      const arrName = match[1];
      if (arrName === 'array') continue;
      const info = arrays.get(arrName);
      if (info && info.size === 0) {
        diagnostics.push({
          line: i + 1, column: match.index + 1,
          message: `${arrName}.${match[2]}() called on possibly empty array (declared with size 0)`,
          severity: 'warning',
        });
      }
    }
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (trimmed.includes('strategy.entry') || trimmed.includes('strategy.close')) {
      let hasStrategyDecl = false;
      for (const l of lines) {
        if (l.trim().startsWith('strategy(')) { hasStrategyDecl = true; break; }
      }
      if (!hasStrategyDecl) {
        diagnostics.push({
          line: i + 1, column: 1,
          message: 'strategy.entry/close used but no strategy() declaration found — did you mean to use indicator()?',
          severity: 'error',
        });
        break;
      }
    }
  }

  if (!isV6 && source.includes('//@version=')) {
    const vMatch = source.match(/\/\/@version=(\d+)/);
    if (vMatch && parseInt(vMatch[1]) < 5) {
      diagnostics.push({
        line: 1, column: 1,
        message: `Script uses Pine v${vMatch[1]} — consider upgrading to v6 for latest features`,
        severity: 'info',
      });
    }
  }

  return {
    success: true,
    issue_count: diagnostics.length,
    diagnostics,
    note: diagnostics.length === 0 ? 'No static analysis issues found. Use pine_compile or pine_smart_compile for full server-side compilation check.' : undefined,
  };
}

export async function check({ source }) {
  const formData = new URLSearchParams();
  formData.append('source', source);

  const response = await fetch(
    'https://pine-facade.tradingview.com/pine-facade/translate_light?user_name=Guest&pine_id=00000000-0000-0000-0000-000000000000',
    {
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
        'Referer': 'https://www.tradingview.com/',
      },
      body: formData,
    }
  );

  if (!response.ok) {
    throw new Error(`TradingView API returned ${response.status}: ${response.statusText}`);
  }

  const result = await response.json();
  const errors = [];
  const warnings = [];
  const inner = result?.result;

  if (inner) {
    if (inner.errors2 && inner.errors2.length > 0) {
      for (const e of inner.errors2) {
        errors.push({
          line: e.start?.line, column: e.start?.column,
          end_line: e.end?.line, end_column: e.end?.column,
          message: e.message,
        });
      }
    }
    if (inner.warnings2 && inner.warnings2.length > 0) {
      for (const w of inner.warnings2) {
        warnings.push({ line: w.start?.line, column: w.start?.column, message: w.message });
      }
    }
  }

  if (result.error && typeof result.error === 'string') {
    errors.push({ message: result.error });
  }

  const compiled = errors.length === 0;
  return {
    success: true,
    compiled,
    error_count: errors.length,
    warning_count: warnings.length,
    errors: errors.length > 0 ? errors : undefined,
    warnings: warnings.length > 0 ? warnings : undefined,
    note: compiled ? 'Pine Script compiled successfully.' : undefined,
  };
}

// ── Functions requiring TradingView connection ──

export async function getSource() {
  const editorReady = await ensurePineEditorOpen();
  if (!editorReady) throw new Error('Could not open Pine Editor or Monaco not found in React fiber tree.');

  const source = await evaluate(`
    (function() {
      var m = ${FIND_MONACO};
      if (!m) return null;
      return m.editor.getValue();
    })()
  `);

  if (source === null || source === undefined) {
    throw new Error('Monaco editor found but getValue() returned null.');
  }

  return { success: true, source, line_count: source.split('\n').length, char_count: source.length };
}

/**
 * Replace the editor buffer. Guarded: refuses if the buffer has unsaved changes, or if it is
 * bound to a saved script and `target` does not name that script (see assertBufferReplaceable).
 */
export async function setSource({ source, target, force = false } = {}) {
  if (typeof source !== 'string') throw new Error('source (string) is required.');
  const state = await getEditorState();
  assertBufferReplaceable(state, { force: !!force, target, incomingTitle: scriptTitleOf(source), action: 'replace the editor buffer' });

  const escaped = JSON.stringify(source);
  const set = await evaluate(`
    (function() {
      var m = ${FIND_MONACO};
      if (!m) return false;
      m.editor.setValue(${escaped});
      return true;
    })()
  `);

  if (!set) throw new Error('Monaco found but setValue() failed.');
  const after = await evaluate(EDITOR_STATE_JS);
  return {
    success: true,
    lines_set: source.split('\n').length,
    title: after?.title ?? state.title,
    replaced_saved_script: !state.is_untitled,
    note: state.is_untitled
      ? 'Buffer was an untitled script; use pine_save to persist it.'
      : `Buffer of saved script "${state.title}" replaced in the editor only — unsaved until pine_save.`,
  };
}


export async function compile() {
  const editorReady = await ensurePineEditorOpen();
  if (!editorReady) throw new Error('Could not open Pine Editor.');

  const clicked = await evaluate(`
    (function() {
      var found = ${FIND_RUN_BUTTON};
      if (!found) return null;
      found.el.click();
      return found.how;
    })()
  `);

  if (!clicked) {
    const c = await getClient();
    await c.Input.dispatchKeyEvent({ type: 'keyDown', modifiers: 2, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await c.Input.dispatchKeyEvent({ type: 'keyUp', key: 'Enter', code: 'Enter' });
  }

  await new Promise(r => setTimeout(r, 2000));
  return { success: true, button_clicked: clicked || 'keyboard_shortcut', source: 'dom_fallback' };
}

export async function getErrors() {
  const editorReady = await ensurePineEditorOpen();
  if (!editorReady) throw new Error('Could not open Pine Editor.');

  const errors = await evaluate(`
    (function() {
      var m = ${FIND_MONACO};
      if (!m) return [];
      var model = m.editor.getModel();
      if (!model) return [];
      var markers = m.env.editor.getModelMarkers({ resource: model.uri });
      return markers.map(function(mk) {
        return { line: mk.startLineNumber, column: mk.startColumn, message: mk.message, severity: mk.severity };
      });
    })()
  `);

  return {
    success: true,
    has_errors: errors?.length > 0,
    error_count: errors?.length || 0,
    errors: errors || [],
  };
}

/**
 * Save the bound script through the editor's own menu (title control → "Save script").
 * Ctrl+S via CDP is not honoured on macOS (TradingView binds ⌘S and needs editor focus), and the
 * toolbar save button is a hidden element — the menu item is the path that reliably works.
 * For an untitled script TradingView opens a name dialog; `name` overrides its pre-filled value.
 * Reports success only when the version selector no longer shows "Unsaved version".
 */
export async function save({ name } = {}) {
  const before = await getEditorState();

  await openTitleMenu();
  const clicked = await evaluate(menuItemJS('Save script', 'click'));
  if (!clicked) {
    await pressEscape();
    throw new Error('"Save script" not found in the Pine Editor menu (TradingView UI may have changed). Nothing was saved.');
  }
  await delay(800);

  // Untitled scripts get a "Save script" name dialog
  let dialogHandled = false;
  const nameDialog = (await openDialogs()).find(d => d.inputs.length >= 1);
  if (nameDialog) {
    if (name) await evaluate(setDialogInputJS(name));
    const confirmed = await evaluate(clickDialogButtonJS('^(Save|Save script|OK)$'));
    if (!confirmed) throw new Error('The Save dialog appeared but its Save button was not found — the dialog is still open.');
    dialogHandled = true;
  }

  let after = null;
  for (let i = 0; i < 30; i++) {
    await delay(200);
    after = await evaluate(EDITOR_STATE_JS);
    if (after && !after.unsaved && after.version_label && after.version_label !== 'Unsaved version') break;
  }
  const saved = !!(after && !after.unsaved);

  return {
    success: saved,
    action: dialogHandled ? 'saved_with_dialog' : 'menu_save_script',
    title: after?.title ?? before.title,
    version_label: after?.version_label ?? null,
    was_unsaved: before.unsaved,
    ...(saved ? {} : { error: 'Save did not register — the version selector still shows "Unsaved version". Check the editor for an error message.' }),
  };
}

export async function getConsole() {
  const editorReady = await ensurePineEditorOpen();
  if (!editorReady) throw new Error('Could not open Pine Editor.');

  const entries = await evaluate(`
    (function() {
      var results = [];
      var rows = document.querySelectorAll('[class*="consoleRow"], [class*="log-"], [class*="consoleLine"]');
      if (rows.length === 0) {
        var bottomArea = document.querySelector('[class*="layout__area--bottom"]')
          || document.querySelector('[class*="bottom-widgetbar-content"]');
        if (bottomArea) {
          rows = bottomArea.querySelectorAll('[class*="message"], [class*="log"], [class*="console"]');
        }
      }
      if (rows.length === 0) {
        var pinePanel = document.querySelector('.pine-editor-container')
          || document.querySelector('[class*="pine-editor"]')
          || document.querySelector('[class*="layout__area--bottom"]');
        if (pinePanel) {
          var allSpans = pinePanel.querySelectorAll('span, div');
          for (var s = 0; s < allSpans.length; s++) {
            var txt = allSpans[s].textContent.trim();
            if (/^\\d{2}:\\d{2}:\\d{2}/.test(txt) || /error|warning|info/i.test(allSpans[s].className)) {
              rows = Array.from(rows || []);
              rows.push(allSpans[s]);
            }
          }
        }
      }
      for (var i = 0; i < rows.length; i++) {
        var text = rows[i].textContent.trim();
        if (!text) continue;
        var ts = null;
        var tsMatch = text.match(/^(\\d{4}-\\d{2}-\\d{2}\\s+)?\\d{2}:\\d{2}:\\d{2}/);
        if (tsMatch) ts = tsMatch[0];
        var type = 'info';
        var cls = rows[i].className || '';
        if (/error/i.test(cls) || /error/i.test(text.substring(0, 30))) type = 'error';
        else if (/compil/i.test(text.substring(0, 40))) type = 'compile';
        else if (/warn/i.test(cls)) type = 'warning';
        results.push({ timestamp: ts, type: type, message: text });
      }
      return results;
    })()
  `);

  return { success: true, entries: entries || [], entry_count: entries?.length || 0 };
}

export async function smartCompile() {
  const editorReady = await ensurePineEditorOpen();
  if (!editorReady) throw new Error('Could not open Pine Editor.');

  const studiesBefore = await evaluate(`
    (function() {
      try {
        var chart = window.TradingViewApi._activeChartWidgetWV.value();
        if (chart && typeof chart.getAllStudies === 'function') return chart.getAllStudies().length;
      } catch(e) {}
      return null;
    })()
  `);

  const buttonClicked = await evaluate(`
    (function() {
      var found = ${FIND_RUN_BUTTON};
      if (!found) return null;
      found.el.click();
      return found.how;
    })()
  `);

  if (!buttonClicked) {
    const c = await getClient();
    await c.Input.dispatchKeyEvent({ type: 'keyDown', modifiers: 2, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await c.Input.dispatchKeyEvent({ type: 'keyUp', key: 'Enter', code: 'Enter' });
  }

  await new Promise(r => setTimeout(r, 2500));

  const errors = await evaluate(`
    (function() {
      var m = ${FIND_MONACO};
      if (!m) return [];
      var model = m.editor.getModel();
      if (!model) return [];
      var markers = m.env.editor.getModelMarkers({ resource: model.uri });
      return markers.map(function(mk) {
        return { line: mk.startLineNumber, column: mk.startColumn, message: mk.message, severity: mk.severity };
      });
    })()
  `);

  const studiesAfter = await evaluate(`
    (function() {
      try {
        var chart = window.TradingViewApi._activeChartWidgetWV.value();
        if (chart && typeof chart.getAllStudies === 'function') return chart.getAllStudies().length;
      } catch(e) {}
      return null;
    })()
  `);

  const studyAdded = (studiesBefore !== null && studiesAfter !== null) ? studiesAfter > studiesBefore : null;

  return {
    success: true,
    button_clicked: buttonClicked || 'keyboard_shortcut',
    has_errors: errors?.length > 0,
    errors: errors || [],
    study_added: studyAdded,
  };
}

/**
 * Create a genuinely new script through the editor menu: title control → "Create new" (a hover
 * flyout) → Indicator / Strategy / Library. This rebinds the editor to a fresh "Untitled script".
 * The old implementation merely setValue()'d a template over the current buffer — which left the
 * editor bound to whatever script was open, so the next Save overwrote that script.
 * Guarded: refuses if the current buffer has unsaved changes (unless force).
 */
export async function newScript({ type = 'indicator', force = false } = {}) {
  const kind = { indicator: 'Indicator', strategy: 'Strategy', library: 'Library' }[String(type).toLowerCase()];
  if (!kind) throw new Error(`Unknown script type "${type}". Use indicator, strategy, or library.`);

  const state = await getEditorState();
  if (state.unsaved && !force) {
    throw new Error(`Refusing to create a new script: the editor has unsaved changes in "${state.title || 'Untitled script'}" ` +
      `(${state.line_count} lines). Save them first (pine_save) or pass force:true to discard them.`);
  }

  await openTitleMenu();
  const createNew = await evaluate(menuItemJS('Create new', 'rect'));
  if (!createNew) {
    await pressEscape();
    throw new Error('"Create new" not found in the Pine Editor menu (TradingView UI may have changed). Nothing was changed.');
  }

  // "Create new" is a flyout that opens on hover; a plain click does nothing.
  await realMouse(createNew.x, createNew.y, { click: false });
  await delay(700);
  let item = await evaluate(exactTextRectJS(kind));
  if (!item) {
    await realMouse(createNew.x, createNew.y);
    await delay(700);
    item = await evaluate(exactTextRectJS(kind));
  }
  if (!item) {
    await pressEscape();
    throw new Error(`"${kind}" not found in the "Create new" flyout (TradingView UI may have changed). Nothing was changed.`);
  }
  await realMouse(item.x, item.y);

  let after = null;
  for (let i = 0; i < 25; i++) {
    await delay(200);
    after = await evaluate(EDITOR_STATE_JS);
    if (after && after.is_untitled && after.line_count !== null && after.line_count < 20) {
      return {
        success: true,
        type: kind.toLowerCase(),
        action: 'new_script_created',
        title: after.title,
        lines: after.line_count,
        previous_script: state.title,
        note: 'Editor is bound to a fresh untitled script; pine_set_source may now replace its buffer without a target.',
      };
    }
  }
  throw new Error(`Clicked "${kind}" but the editor did not switch to a new untitled script ` +
    `(title is "${after?.title}", ${after?.line_count} lines). Check the editor before writing.`);
}

/**
 * Open a saved script through the editor's own "Open script…" dialog so the editor is genuinely
 * bound to it. The old implementation fetched the source over pine-facade and setValue()'d it into
 * whatever script was open, leaving the binding unchanged — a later Save wrote the opened script's
 * code into the previously bound script.
 * Guarded: refuses if the current buffer has unsaved changes (unless force).
 */
export async function openScript({ name, force = false } = {}) {
  if (!name || !String(name).trim()) throw new Error('name is required.');

  const state = await getEditorState();
  if (state.unsaved && !force) {
    throw new Error(`Refusing to open "${name}": the editor has unsaved changes in "${state.title || 'Untitled script'}" ` +
      `(${state.line_count} lines). Save them first (pine_save) or pass force:true to discard them.`);
  }

  // Resolve the exact saved-script name (exact match first, then substring), case-insensitive.
  const list = await listScripts();
  const want = String(name).trim().toLowerCase();
  const scripts = list.scripts || [];
  const match = scripts.find(s => (s.name || '').toLowerCase() === want || (s.title || '').toLowerCase() === want)
    || scripts.find(s => (s.name || '').toLowerCase().includes(want) || (s.title || '').toLowerCase().includes(want));
  if (!match) throw new Error(`Script "${name}" not found. Use pine_list_scripts to see available scripts.`);

  if (state.title === match.name && !state.unsaved) {
    return { success: true, name: match.name, script_id: match.id, version: match.version, title: state.title, lines: state.line_count, already_open: true, opened: true, source: 'ui' };
  }

  await openTitleMenu();
  const clicked = await evaluate(menuItemJS('Open script', 'click'));
  if (!clicked) {
    await pressEscape();
    throw new Error('"Open script…" not found in the Pine Editor menu (TradingView UI may have changed). Nothing was changed.');
  }

  let dialogSeen = false;
  for (let i = 0; i < 20; i++) {
    await delay(200);
    if ((await openDialogs()).some(d => /Open my script/i.test(d.text))) { dialogSeen = true; break; }
  }
  if (!dialogSeen) throw new Error('The "Open my script" dialog did not appear.');

  // Rows ignore synthetic .click(); a real pointer click on the row's centre is required.
  const row = await evaluate(exactTextRectJS(match.name, '[role="dialog"]'));
  if (!row) {
    await evaluate(clickDialogButtonJS('close menu'));
    throw new Error(`"${match.name}" is not visible in the Open dialog (the list may be scrolled). Nothing was changed.`);
  }
  await realMouse(row.x, row.y);

  let after = null;
  for (let i = 0; i < 25; i++) {
    await delay(200);
    // If TradingView asks about discarding unsaved changes, honour force; otherwise leave it for the user.
    const prompt = (await openDialogs()).find(d => /unsaved|save changes|not saved/i.test(d.text));
    if (prompt) {
      if (!force) throw new Error('TradingView is asking about unsaved changes — dialog left open for you to decide.');
      await evaluate(clickDialogButtonJS("^(Don'?t save|Don’t save|Discard( changes)?|No)$"));
    }
    after = await evaluate(EDITOR_STATE_JS);
    if (after && after.title === match.name) break;
  }

  if ((await openDialogs()).some(d => /Open my script/i.test(d.text))) await evaluate(clickDialogButtonJS('close menu'));

  if (!after || after.title !== match.name) {
    throw new Error(`Clicked "${match.name}" but the editor title is "${after?.title}" — open did not complete.`);
  }

  return { success: true, name: match.name, script_id: match.id, version: match.version, title: after.title, lines: after.line_count, opened: true, source: 'ui' };
}

export async function listScripts() {
  const scripts = await evaluateAsync(`
    fetch('https://pine-facade.tradingview.com/pine-facade/list/?filter=saved', { credentials: 'include' })
      .then(function(r) { return r.json(); })
      .then(function(data) {
        if (!Array.isArray(data)) return {scripts: [], error: 'Unexpected response from pine-facade'};
        return {
          scripts: data.map(function(s) {
            return {
              id: s.scriptIdPart || null,
              name: s.scriptName || s.scriptTitle || 'Untitled',
              title: s.scriptTitle || null,
              version: s.version || null,
              modified: s.modified || null,
            };
          })
        };
      })
      .catch(function(e) { return {scripts: [], error: e.message}; })
  `);

  return {
    success: true,
    scripts: scripts?.scripts || [],
    count: scripts?.scripts?.length || 0,
    source: 'internal_api',
    error: scripts?.error,
  };
}
