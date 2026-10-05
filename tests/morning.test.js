/**
 * Tests for the morning brief's file-safety guards (src/core/morning.js).
 * These run without TradingView: every case fails before any CDP call.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runBrief, saveSession, getSession, assertSafeRulesPath } from '../src/core/morning.js';

describe('morning brief — rules_path guard', () => {
  it('rejects a rules file outside the project and ~/.tradingview-mcp', async () => {
    await assert.rejects(() => runBrief({ rules_path: join(tmpdir(), 'rules.json') }), /must live inside the project/);
  });

  it('rejects traversal out of ~/.tradingview-mcp', async () => {
    await assert.rejects(
      () => runBrief({ rules_path: join(homedir(), '.tradingview-mcp', '..', 'rules.json') }),
      /must live inside the project/,
    );
  });

  it('accepts paths inside ~/.tradingview-mcp and the project (native separators)', () => {
    // Regression: the upstream guard compared against "/", so every Windows
    // (backslash) path was rejected.
    assert.doesNotThrow(() => assertSafeRulesPath(join(homedir(), '.tradingview-mcp', 'rules.json')));
    assert.doesNotThrow(() => assertSafeRulesPath(join(homedir(), '.tradingview-mcp', 'sub', 'rules.json')));
    assert.doesNotThrow(() => assertSafeRulesPath(fileURLToPath(new URL('../rules.json', import.meta.url))));
  });
});

describe('morning brief — session date guard', () => {
  for (const date of ['../../evil', '2026-1-1', '2026-01-01.json', '..\\..\\evil']) {
    it(`saveSession rejects date ${JSON.stringify(date)}`, () => {
      assert.throws(() => saveSession({ brief: 'x', date }), /Invalid date/);
    });
    it(`getSession rejects date ${JSON.stringify(date)}`, () => {
      assert.throws(() => getSession({ date }), /Invalid date/);
    });
  }
});
