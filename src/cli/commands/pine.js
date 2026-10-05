import { register } from '../router.js';
import * as core from '../../core/pine.js';
import { readFileSync } from 'fs';

async function readStdin() {
  if (process.stdin.isTTY) return null;
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf-8');
}

register('pine', {
  description: 'Pine Script tools',
  subcommands: new Map([
    ['get', {
      description: 'Get current Pine Script source from editor',
      handler: () => core.getSource(),
    }],
    ['state', {
      description: 'Which script the editor is bound to, and whether it has unsaved changes',
      handler: () => core.getEditorState(),
    }],
    ['set', {
      description: 'Set Pine Script source (reads stdin or --file). Refuses to clobber unsaved work or a saved script unless --target/--force',
      options: {
        file: { type: 'string', short: 'f', description: 'Read source from file' },
        target: { type: 'string', short: 't', description: 'Name of the saved script you intend to overwrite (must match the editor title)' },
        force: { type: 'boolean', description: 'Bypass the unsaved-changes / saved-script guards' },
      },
      handler: async (opts) => {
        let source;
        if (opts.file) {
          source = readFileSync(opts.file, 'utf-8');
        } else {
          source = await readStdin();
        }
        if (!source) throw new Error('No source provided. Pipe source via stdin or use --file.');
        return core.setSource({ source, target: opts.target, force: opts.force });
      },
    }],
    ['compile', {
      description: 'Smart compile: detect button, compile, check errors',
      handler: () => core.smartCompile(),
    }],
    ['raw-compile', {
      description: 'Click compile/add button without smart detection',
      handler: () => core.compile(),
    }],
    ['analyze', {
      description: 'Offline static analysis (no TradingView needed)',
      options: {
        file: { type: 'string', short: 'f', description: 'Read source from file' },
      },
      handler: async (opts) => {
        let source;
        if (opts.file) {
          source = readFileSync(opts.file, 'utf-8');
        } else {
          source = await readStdin();
        }
        if (!source) throw new Error('No source provided. Pipe source via stdin or use --file.');
        return core.analyze({ source });
      },
    }],
    ['check', {
      description: 'Server-side compile check (no chart needed)',
      options: {
        file: { type: 'string', short: 'f', description: 'Read source from file' },
      },
      handler: async (opts) => {
        let source;
        if (opts.file) {
          source = readFileSync(opts.file, 'utf-8');
        } else {
          source = await readStdin();
        }
        if (!source) throw new Error('No source provided. Pipe source via stdin or use --file.');
        return core.check({ source });
      },
    }],
    ['save', {
      description: 'Save the current Pine Script via the editor menu (handles the name dialog for untitled scripts)',
      options: {
        name: { type: 'string', short: 'n', description: 'Name for an untitled script when the Save dialog appears' },
      },
      handler: (opts) => core.save({ name: opts.name }),
    }],
    ['new', {
      description: 'Create a genuinely new Pine Script via the editor menu (indicator, strategy, library)',
      options: {
        force: { type: 'boolean', description: 'Proceed even if the current buffer has unsaved changes' },
      },
      handler: (opts, positionals) => {
        const type = positionals[0] || 'indicator';
        return core.newScript({ type, force: opts.force });
      },
    }],
    ['open', {
      description: 'Open a saved Pine Script by name via the editor Open dialog (rebinds the editor)',
      options: {
        force: { type: 'boolean', description: 'Proceed even if the current buffer has unsaved changes' },
      },
      handler: (opts, positionals) => {
        if (!positionals[0]) throw new Error('Script name required. Usage: tv pine open "My Script"');
        return core.openScript({ name: positionals.join(' '), force: opts.force });
      },
    }],
    ['list', {
      description: 'List saved Pine Scripts',
      handler: () => core.listScripts(),
    }],
    ['errors', {
      description: 'Get Pine Script compilation errors',
      handler: () => core.getErrors(),
    }],
    ['console', {
      description: 'Get Pine Script console/log output',
      handler: () => core.getConsole(),
    }],
  ]),
});
