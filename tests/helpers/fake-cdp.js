/**
 * A fake Chrome DevTools endpoint for tests: HTTP /json/* plus a WebSocket per page target that
 * answers CDP commands and records every one. It listens on a random local port, so tools aimed at
 * it can never reach a running TradingView. Uses `ws`, which chrome-remote-interface already
 * depends on.
 */
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const WebSocket = require('ws');
const PROTOCOL = readFileSync(require.resolve('chrome-remote-interface/lib/protocol.json'), 'utf8');

export const FAKE_CHART_URL = 'https://www.tradingview.com/chart/fake1234/';

/**
 * Options:
 *   targets: [{ id, url }] page targets (default: one chart page "page1")
 *   respond(expression, targetId): what Runtime.evaluate returns (a value, or undefined)
 *   hang(expression, targetId): true to never answer that evaluate (a frozen renderer)
 * Returns { port, log, close }; log holds { kind: 'http'|'cdp'|'evaluate', target, ... } entries.
 */
export async function startFakeCdp({ respond = () => undefined, targets: pages = [{ id: 'page1', url: FAKE_CHART_URL }], hang = () => false } = {}) {
  const log = [];
  let port;
  const targets = () => pages.map(p => ({
    id: p.id, type: 'page', title: 'Fake ' + p.id, url: p.url,
    webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/${p.id}`,
  }));
  const http = createServer((req, res) => {
    log.push({ kind: 'http', path: req.url });
    const json = (body) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(typeof body === 'string' ? body : JSON.stringify(body)); };
    if (req.url.startsWith('/json/list') || req.url === '/json') return json(targets());
    if (req.url.startsWith('/json/version')) return json({ Browser: 'FakeCDP/1.0', 'Protocol-Version': '1.3' });
    if (req.url.startsWith('/json/protocol')) return json(PROTOCOL);
    res.writeHead(404); res.end('not supported by the fake');
  });
  const wss = new WebSocket.Server({ server: http });
  wss.on('connection', (socket, req) => {
    const target = String(req.url || '').split('/').pop();
    socket.on('message', (data) => {
      const msg = JSON.parse(data);
      log.push({ kind: 'cdp', target, method: msg.method, params: msg.params });
      let reply;
      if (msg.method === 'Runtime.evaluate') {
        const expression = msg.params?.expression ?? '';
        log.push({ kind: 'evaluate', target, expression });
        if (hang(expression, target)) return;
        const value = expression.trim() === '1' ? 1 : respond(expression, target);
        reply = { result: value === undefined ? { type: 'undefined' } : { type: typeof value, value } };
      } else if (msg.method === 'Page.captureScreenshot') {
        socket.send(JSON.stringify({ id: msg.id, error: { code: -32000, message: 'fake: no screenshots' } }));
        return;
      } else {
        reply = {};
      }
      socket.send(JSON.stringify({ id: msg.id, result: reply }));
    });
  });
  await new Promise(r => http.listen(0, '127.0.0.1', r));
  port = http.address().port;
  return {
    port, log,
    close: async () => {
      for (const c of wss.clients) c.terminate();
      await new Promise(r => wss.close(r));
      await new Promise(r => http.close(r));
    },
  };
}
