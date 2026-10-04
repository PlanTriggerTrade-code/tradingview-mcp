import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { assertBufferReplaceable } from '../src/core/pine.js';

// Pure guard behind pine_set_source / pine_new / pine_open. No TradingView needed.

const untitledClean = { title: 'Untitled script', is_untitled: true,  unsaved: false, pristine_template: true,  script_title: 'My script',   line_count: 7 };
const untitledWork  = { title: 'Untitled script', is_untitled: true,  unsaved: true,  pristine_template: false, script_title: 'Desk Levels', line_count: 56 };
const untitledWip   = { title: 'Untitled script', is_untitled: true,  unsaved: true,  pristine_template: false, script_title: 'My script',   line_count: 145 };
const savedClean    = { title: 'Desk Levels',     is_untitled: false, unsaved: false, pristine_template: false, script_title: 'Desk Levels', line_count: 56 };
const savedDirty    = { title: 'Desk Levels',     is_untitled: false, unsaved: true,  pristine_template: false, script_title: 'Desk Levels', line_count: 60 };

describe('assertBufferReplaceable — saved scripts', () => {
  test('refuses to overwrite a saved script without target', () => {
    assert.throws(() => assertBufferReplaceable(savedClean, {}), /bound to the saved script "Desk Levels"/);
  });

  test('allows overwriting a saved script when target names it exactly', () => {
    assert.doesNotThrow(() => assertBufferReplaceable(savedClean, { target: 'Desk Levels' }));
  });

  test('refuses when target names a different script', () => {
    assert.throws(() => assertBufferReplaceable(savedClean, { target: 'Event Stats Dashboard' }), /bound to the saved script "Desk Levels"/);
  });

  test('refuses on unsaved changes even when target matches', () => {
    assert.throws(() => assertBufferReplaceable(savedDirty, { target: 'Desk Levels' }), /unsaved changes/);
  });
});

describe('assertBufferReplaceable — untitled scripts', () => {
  test('allows replacing a pristine blank template', () => {
    assert.doesNotThrow(() => assertBufferReplaceable(untitledClean, {}));
    assert.doesNotThrow(() => assertBufferReplaceable(untitledClean, { incomingTitle: 'Anything' }));
  });

  test('allows iterating on the same untitled script (matching indicator title)', () => {
    assert.doesNotThrow(() => assertBufferReplaceable(untitledWork, { incomingTitle: 'Desk Levels' }));
  });

  test('refuses to replace untitled work with a different script', () => {
    assert.throws(() => assertBufferReplaceable(untitledWork, { incomingTitle: 'Other Script' }), /unsaved work titled "Desk Levels"/);
  });

  test('refuses to replace untitled work when the incoming title is unknown', () => {
    assert.throws(() => assertBufferReplaceable(untitledWork, {}), /unsaved work titled "Desk Levels"/);
  });

  test('the real-world near-miss: 145-line WIP under a leftover template title is protected', () => {
    // Ben's dashboard began with indicator("My script") from the template, so script_title is
    // "My script" — but it is 145 lines, not pristine. Desk Levels must not overwrite it.
    assert.throws(() => assertBufferReplaceable(untitledWip, { incomingTitle: 'Desk Levels' }), /unsaved work titled "My script" \(145 lines\)/);
  });

  test('new/open (no incomingTitle, action supplied) refuse on any untitled work', () => {
    assert.throws(() => assertBufferReplaceable(untitledWork, { action: 'create a new script' }), /Refusing to create a new script/);
  });
});

describe('assertBufferReplaceable — force and messages', () => {
  test('force bypasses every guard', () => {
    assert.doesNotThrow(() => assertBufferReplaceable(savedDirty, { force: true }));
    assert.doesNotThrow(() => assertBufferReplaceable(untitledWip, { force: true }));
  });

  test('error message uses the caller-supplied action verb', () => {
    assert.throws(() => assertBufferReplaceable(savedClean, { action: 'open "Other"' }), /Refusing to open "Other"/);
  });
});
