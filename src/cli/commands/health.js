import { register } from '../router.js';
import * as core from '../../core/health.js';

register('status', {
  description: 'Check CDP connection to TradingView',
  handler: () => core.healthCheck(),
});

register('launch', {
  description: 'Launch TradingView with CDP enabled',
  options: {
    port: { type: 'string', short: 'p', description: 'CDP port (default 9222)' },
    'no-kill': { type: 'boolean', description: 'Do not kill existing instances' },
    'local-copy': { type: 'boolean', description: 'Windows Store build, last resort: run from a copy of the package (may start signed out)' },
  },
  handler: (opts) => core.launch({
    port: opts.port ? Number(opts.port) : undefined,
    kill_existing: !opts['no-kill'],
    allow_local_copy: !!opts['local-copy'],
  }),
});

