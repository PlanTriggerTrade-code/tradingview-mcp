/**
 * Tests for setInputs write verification in src/core/indicators.js.
 *
 * setInputs built its `updated_inputs` receipt from key matching alone: if a
 * requested id existed on the study it was reported as updated, without ever
 * reading the value back. TradingView silently ignores programmatic input
 * writes on protected / invite-only scripts, so the receipt reported changes
 * that never happened — and on those scripts the rejected write also CLEARS
 * the study's value array, so the damage was invisible too.
 *
 * The mock below emulates the browser side of the IIFE for each mode a real
 * study can exhibit.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { setInputs } from '../src/core/indicators.js';

// mode:
//   'normal'        writes apply and read back
//   'ignore'        setInputValues is a no-op (protected script)
//   'clear'         setInputValues empties the array; restore succeeds
//   'clear_norestore' empties the array and the restore also fails
//   'empty'         the study reports no inputs at all
function mockStudy({ defaults, mode = 'normal', missing = false }) {
  const state = { inputs: defaults.map((d) => ({ ...d })), writes: 0 };

  const evaluate = async (expr) => {
    if (missing) return { error: 'Study not found: study_1' };

    const m = expr.match(/var overrides = (\{[\s\S]*?\});/);
    const overrides = m ? JSON.parse(m[1]) : {};

    const before = state.inputs.map((x) => ({ ...x }));
    if (before.length === 0) {
      return { error: 'Study "study_1" reports no readable inputs, so a write cannot be verified.' };
    }

    const known = new Set(before.map((i) => i.id));
    const unknown = Object.keys(overrides).filter((k) => !known.has(k));

    state.writes += 1;
    if (mode === 'normal') {
      state.inputs = before.map((x) => (
        Object.prototype.hasOwnProperty.call(overrides, x.id) ? { id: x.id, value: overrides[x.id] } : x
      ));
    } else if (mode === 'ignore') {
      // accepted, silently discarded
    } else if (mode === 'clear' || mode === 'clear_norestore') {
      state.inputs = [];
    }

    const afterCount = state.inputs.length;
    let restored = false;
    if (afterCount === 0) {
      if (mode === 'clear') { state.inputs = before.map((x) => ({ ...x })); restored = true; }
      else { restored = false; }
    }

    const actual = {};
    for (const i of state.inputs) {
      if (Object.prototype.hasOwnProperty.call(overrides, i.id)) actual[i.id] = i.value;
    }
    return {
      before_count: before.length,
      after_count: afterCount,
      actual,
      unknown_inputs: unknown,
      restored,
    };
  };

  return { _deps: { evaluate }, state };
}

const DEFAULTS = [{ id: 'in_216', value: '5' }, { id: 'in_218', value: 15 }];

describe('setInputs — writes that land', () => {
  it('confirms the value by reading it back', async () => {
    const { _deps, state } = mockStudy({ defaults: DEFAULTS });
    const r = await setInputs({ entity_id: 'study_1', inputs: { in_216: '240' }, _deps });
    assert.equal(r.success, true);
    assert.equal(r.verified, true);
    assert.deepEqual(r.updated_inputs, { in_216: '240' });
    assert.equal(state.inputs.find((i) => i.id === 'in_216').value, '240');
  });

  it('accepts a JSON string for inputs, as the CLI passes it', async () => {
    const { _deps } = mockStudy({ defaults: DEFAULTS });
    const r = await setInputs({ entity_id: 'study_1', inputs: '{"in_218": 20}', _deps });
    assert.deepEqual(r.updated_inputs, { in_218: 20 });
  });

  it('does not treat TradingView\'s type coercion as a failure', async () => {
    // An int input written as "240" legitimately reads back as the number 240.
    const coercing = mockStudy({ defaults: [{ id: 'in_216', value: 5 }] });
    coercing._deps.evaluate = async () => ({
      before_count: 1, after_count: 1, actual: { in_216: 240 }, unknown_inputs: [], restored: false,
    });
    const r = await setInputs({ entity_id: 'study_1', inputs: { in_216: '240' }, _deps: coercing._deps });
    assert.equal(r.success, true);
  });

  it('reports unknown ids without failing, matching manageIndicator', async () => {
    const { _deps } = mockStudy({ defaults: DEFAULTS });
    const r = await setInputs({ entity_id: 'study_1', inputs: { in_216: '240', bogus: 1 }, _deps });
    assert.equal(r.success, true);
    assert.deepEqual(r.updated_inputs, { in_216: '240' });
    assert.deepEqual(r.unknown_inputs, ['bogus']);
  });
});

describe('setInputs — writes that silently fail (the bug)', () => {
  it('throws when a protected script ignores the write', async () => {
    // The real case: RaMi'$ in_216 set to "240", still reads back "5".
    const { _deps } = mockStudy({ defaults: DEFAULTS, mode: 'ignore' });
    await assert.rejects(
      () => setInputs({ entity_id: 'study_1', inputs: { in_216: '240' }, _deps }),
      (e) => {
        assert.match(e.message, /did not take effect/);
        assert.match(e.message, /in_216 wanted "240", reads back "5"/);
        assert.match(e.message, /settings dialog/);
        return true;
      },
    );
  });

  it('throws when the write clears the input array, and says it restored them', async () => {
    const { _deps, state } = mockStudy({ defaults: DEFAULTS, mode: 'clear' });
    await assert.rejects(
      () => setInputs({ entity_id: 'study_1', inputs: { in_216: '240' }, _deps }),
      (e) => {
        assert.match(e.message, /cleared this study's input values/);
        assert.match(e.message, /2 inputs before, 0 after/);
        assert.match(e.message, /they were restored/);
        return true;
      },
    );
    assert.equal(state.inputs.length, 2, 'values were put back');
  });

  it('says so when the restore also failed', async () => {
    const { _deps } = mockStudy({ defaults: DEFAULTS, mode: 'clear_norestore' });
    await assert.rejects(
      () => setInputs({ entity_id: 'study_1', inputs: { in_216: '240' }, _deps }),
      (e) => {
        assert.match(e.message, /restore attempt also failed/);
        return true;
      },
    );
  });

  it('names only the inputs that failed, not the ones that landed', async () => {
    const { _deps } = mockStudy({ defaults: DEFAULTS });
    _deps.evaluate = async () => ({
      before_count: 2, after_count: 2,
      actual: { in_216: '5', in_218: 20 }, unknown_inputs: [], restored: false,
    });
    await assert.rejects(
      () => setInputs({ entity_id: 'study_1', inputs: { in_216: '240', in_218: 20 }, _deps }),
      (e) => {
        assert.match(e.message, /in_216/);
        assert.doesNotMatch(e.message, /in_218/);
        return true;
      },
    );
  });
});

describe('setInputs — guards', () => {
  it('refuses a study with no readable inputs rather than writing blind', async () => {
    const { _deps } = mockStudy({ defaults: [], mode: 'normal' });
    await assert.rejects(
      () => setInputs({ entity_id: 'study_1', inputs: { in_216: '240' }, _deps }),
      /no readable inputs/,
    );
  });

  it('still requires entity_id and a non-empty inputs object', async () => {
    const { _deps } = mockStudy({ defaults: DEFAULTS });
    await assert.rejects(() => setInputs({ inputs: { a: 1 }, _deps }), /entity_id is required/);
    await assert.rejects(() => setInputs({ entity_id: 'study_1', inputs: {}, _deps }), /non-empty object/);
  });

  it('propagates study-not-found', async () => {
    const { _deps } = mockStudy({ defaults: DEFAULTS, missing: true });
    await assert.rejects(
      () => setInputs({ entity_id: 'study_1', inputs: { in_216: '240' }, _deps }),
      /Study not found/,
    );
  });
});
