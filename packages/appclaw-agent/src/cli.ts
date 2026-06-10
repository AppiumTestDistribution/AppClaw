import { sendCommand } from './client.js';
import { helpText, VERSION, workflowText } from './help.js';
import { parseInvocation } from './parser.js';

const c = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  cyan: '\x1b[36m',
  yellow: '\x1b[33m',
  magenta: '\x1b[35m',
};

function colorOutput(session: string | undefined, ok: boolean, message: string, output?: string) {
  const icon = ok ? `${c.green}✔${c.reset}` : `${c.red}✘${c.reset}`;
  const tag = session ? ` ${c.cyan}[${session}]${c.reset}` : '';
  if (output) process.stdout.write(`${c.dim}${output}${c.reset}\n`);
  process.stdout.write(`${icon}${tag} ${message}\n`);
}

export async function run(argv: string[]): Promise<number> {
  try {
    const parsed = parseInvocation(argv);
    if (parsed.local === 'version') {
      console.log(VERSION);
      return 0;
    }
    if (parsed.local === 'help') {
      console.log(argv.includes('workflow') ? workflowText() : helpText());
      return 0;
    }
    const response = await sendCommand(parsed.session, parsed.command!);
    if (parsed.json) {
      process.stdout.write(`${JSON.stringify(response)}\n`);
    } else {
      colorOutput(response.session, response.ok, response.message, response.output);
    }
    return response.ok ? 0 : 1;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (argv.includes('--json')) {
      process.stdout.write(`${JSON.stringify({ ok: false, message })}\n`);
    } else {
      process.stderr.write(`${c.red}✘${c.reset} ${c.bold}Error:${c.reset} ${message}\n`);
    }
    return 1;
  }
}

if (process.argv[1]?.endsWith('cli.js')) {
  process.exitCode = await run(process.argv.slice(2));
}
