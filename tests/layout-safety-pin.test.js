/**
 * While a chart-bound tool runs, the shared connection is pinned to the tab the guard checked.
 * A reconnect (slow ping, timed-out evaluate) may only reach that tab, or must fail; it must never
 * land on another tab. Runs against a fake DevTools endpoint on a random local port.
 */
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { startFakeCdp } from './helpers/fake-cdp.js';

let frozen = false; // when true, the checked tab never answers (a frozen renderer)
const fake = await startFakeCdp({
  targets: [
    { id: 'page1', url: 'https://www.tradingview.com/chart/free0001/' },
    { id: 'page2', url: 'https://www.tradingview.com/chart/real0001/' },
  ],
  respond: () => 42,
  hang: (_e, target) => frozen && target === 'page1',
});
process.env.TV_CDP_HOST = '127.0.0.1';
process.env.TV_CDP_PORT = String(fake.port);
const { CDP_PORT, evaluate, reconnectTo, pinTarget, unpinTarget, pinnedTarget, followActiveTab, getTargetInfo, disconnect } =
  await import('../src/connection.js');
assert.equal(CDP_PORT, fake.port);

after(async () => { unpinTarget(); await disconnect(); await fake.close(); });

const evaluatesOn = (target, from = 0) => fake.log.slice(from).filter(e => e.kind === 'evaluate' && e.target === target);

describe('connection pinned to the checked tab', () => {
  it('works normally on the pinned tab', async () => {
    await reconnectTo('page1');
    pinTarget('page1');
    try {
      assert.equal(await evaluate('40+2'), 42);
      assert.equal((await getTargetInfo()).id, 'page1');
    } finally { unpinTarget(); }
  });

  it('refuses to move to another tab while pinned', async () => {
    await reconnectTo('page1');
    pinTarget('page1');
    const start = fake.log.length;
    try {
      await followActiveTab(); // a no-op while pinned
      await assert.rejects(reconnectTo('page2'), /TARGET_PINNED/);
      assert.equal(pinnedTarget(), 'page1');
      assert.deepEqual(evaluatesOn('page2', start), []);
    } finally { unpinTarget(); }
  });

  it('a frozen pinned tab makes the call fail; the other tab is never touched', { timeout: 60000 }, async () => {
    await reconnectTo('page1');
    pinTarget('page1');
    const start = fake.log.length;
    frozen = true;
    try {
      await assert.rejects(evaluate('window.__write = 1'));
      assert.deepEqual(evaluatesOn('page2', start), [], 'the other tab received an evaluate');
      assert.ok(!fake.log.slice(start).some(e => e.kind === 'evaluate' && e.expression.includes('__write')), 'the write was sent');
    } finally { frozen = false; unpinTarget(); }
  });

  it('after unpinning, the connection may attach anywhere again', async () => {
    unpinTarget();
    await reconnectTo('page2');
    assert.equal(await evaluate('1+1'), 42);
    assert.equal((await getTargetInfo()).id, 'page2');
  });
});
