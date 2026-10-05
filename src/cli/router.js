/**
 * CLI command router using node:util parseArgs.
 * Zero dependencies — uses only Node.js built-ins.
 */
import { parseArgs } from 'node:util';

/** @type {Map<string, { description: string, options?: object, handler: Function, subcommands?: Map<string, object> }>} */
const commands = new Map();

export function register(name, config) {
  commands.set(name, config);
}

function printHelp() {
  console.log('Usage: tv <command> [options]\n');
  console.log('Commands:');
  const maxLen = Math.max(...[...commands.keys()].map(k => k.length));
  for (const [name, cmd] of commands) {
    if (cmd.subcommands) {
      const subs = [...cmd.subcommands.keys()].join(', ');
      console.log(`  ${name.padEnd(maxLen + 2)}${cmd.description}  [${subs}]`);
    } else {
      console.log(`  ${name.padEnd(maxLen + 2)}${cmd.description}`);
    }
  }
  console.log('\nRun "tv <command> --help" for command-specific options.');
  console.log('\nDISCLAIMER');
  console.log('  Not affiliated with TradingView Inc. or Anthropic, PBC.');
  console.log('  Use subject to TradingView\'s Terms of Use: tradingview.com/policies');
}

function printCommandHelp(name, cmd) {
  if (cmd.subcommands) {
    console.log(`Usage: tv ${name} <subcommand> [options]\n`);
    console.log('Subcommands:');
    for (const [sub, subConf] of cmd.subcommands) {
      console.log(`  ${sub.padEnd(12)}${subConf.description}`);
    }
  } else {
    console.log(`Usage: tv ${name} [options]\n`);
    console.log(cmd.description);
  }
  const opts = cmd.options || {};
  if (Object.keys(opts).length > 0) {
    console.log('\nOptions:');
    for (const [k, v] of Object.entries(opts)) {
      const flag = v.short ? `-${v.short}, --${k}` : `    --${k}`;
      console.log(`  ${flag.padEnd(20)}${v.description || ''}`);
    }
  }
}

export async function run(argv) {
  const args = argv.slice(2);

  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    printHelp();
    process.exit(0);
  }

  const cmdName = args[0];
  const cmd = commands.get(cmdName);

  if (!cmd) {
    console.error(`Unknown command: ${cmdName}`);
    console.error('Run "tv --help" for a list of commands.');
    process.exit(1);
  }

  // Handle subcommands (e.g., tv pine get)
  let handler, options;
  if (cmd.subcommands) {
    const subName = args[1];
    if (!subName || subName === '--help' || subName === '-h') {
      printCommandHelp(cmdName, cmd);
      process.exit(0);
    }
    const sub = cmd.subcommands.get(subName);
    if (!sub) {
      console.error(`Unknown subcommand: ${cmdName} ${subName}`);
      printCommandHelp(cmdName, cmd);
      process.exit(1);
    }
    handler = sub.handler;
    options = sub.options || {};
    // Parse remaining args after command + subcommand
    try {
      const { values, positionals } = parseArgs({
        args: args.slice(2),
        options: { help: { type: 'boolean', short: 'h' }, ...options },
        allowPositionals: true,
        strict: false,
      });
      if (values.help) {
        console.log(`Usage: tv ${cmdName} ${subName} [options]\n`);
        console.log(sub.description);
        if (Object.keys(options).length > 0) {
          console.log('\nOptions:');
          for (const [k, v] of Object.entries(options)) {
            const flag = v.short ? `-${v.short}, --${k}` : `    --${k}`;
            console.log(`  ${flag.padEnd(20)}${v.description || ''}`);
          }
        }
        process.exit(0);
      }
      await execute(handler, values, positionals);
    } catch (err) {
      handleError(err);
    }
  } else {
    handler = cmd.handler;
    options = cmd.options || {};
    try {
      const { values, positionals } = parseArgs({
        args: args.slice(1),
        options: { help: { type: 'boolean', short: 'h' }, ...options },
        allowPositionals: true,
        strict: false,
      });
      if (values.help) {
        printCommandHelp(cmdName, cmd);
        process.exit(0);
      }
      await execute(handler, values, positionals);
    } catch (err) {
      handleError(err);
    }
  }
}

async function execute(handler, values, positionals) {
  try {
    const result = await handler(values, positionals);
    console.log(JSON.stringify(result, null, 2));
    await finish(0);
  } catch (err) {
    handleError(err);
  }
}

// Let the process end on its own instead of process.exit(): on Windows, Node 24
// aborts with a libuv assertion (UV_HANDLE_CLOSING) when process.exit() runs while a
// fetch() socket is still closing. Close the CDP socket so the event loop can drain;
// the unref'd timer only fires if something else keeps the process alive.
async function finish(code) {
  process.exitCode = code;
  try {
    const { disconnect } = await import('../connection.js');
    await disconnect();
  } catch { /* not connected */ }
  setTimeout(() => process.exit(code), 1500).unref();
}

function handleError(err) {
  const message = err.message || String(err);
  console.error(JSON.stringify({ success: false, error: message }, null, 2));
  // Connection failures get exit code 2
  return finish(/CDP|connection|ECONNREFUSED|not running/i.test(message) ? 2 : 1);
}
