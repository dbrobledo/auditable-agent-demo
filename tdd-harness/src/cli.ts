#!/usr/bin/env node
/**
 * CLI entrypoint.
 *
 *   tdd-harness --task "implement a CSV parser" \
 *               --workspace ./work --driver local \
 *               --model qwen2.5-coder:7b --log .harness/decisions.jsonl
 *
 * Exit codes: 0 the task passed, 1 it did not, 2 the arguments were wrong.
 */

import { TDDOrchestrator } from './tdd/orchestrator.js';
import { LocalProcessSandbox } from './sandbox/local-process.js';
import { E2BSandboxService } from './sandbox/e2b.js';
import { OpenAICompatibleClient } from './llm/openai-compatible.js';
import { DecisionLog } from './audit/decision-log.js';
import type { SandboxService } from './sandbox/types.js';

const USAGE = `tdd-harness -- an AI coding agent whose green runs mean something

Usage:
  tdd-harness --task <description> [options]

Options:
  --task <text>         What to build. Required.
  --driver <name>       local | e2b            (default: local)
  --workspace <path>    Workspace directory    (default: a temp dir)
  --model <name>        Model id               (default: $HARNESS_MODEL or qwen2.5-coder:7b)
  --base-url <url>      OpenAI-compatible API  (default: $HARNESS_BASE_URL or http://localhost:11434/v1)
  --test-command <cmd>  Verification command   (default: npm test)
  --setup-command <cmd> Run once before verifying, e.g. "npm install"
  --attempts <n>        Verification runs; repairs = n - 1  (default: 3)
  --timeout <ms>        Per-test-run deadline  (default: 120000)
  --budget-ms <ms>      Whole-task wall clock  (default: 900000)
  --budget-tokens <n>   Whole-task token cap   (default: unlimited)
  --log <path>          Decision log           (default: .harness/decisions.jsonl)
  --no-log              Disable the decision log
  --verify-log <path>   Check an existing log and exit
  -h, --help
`;

function parseArgs(argv: string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) { out.set(key, next); i++; }
    else out.set(key, 'true');
  }
  return out;
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv.includes('-h') || argv.includes('--help')) {
    process.stdout.write(USAGE);
    return argv.length === 0 ? 2 : 0;
  }
  const args = parseArgs(argv);

  const verifyLog = args.get('verify-log');
  if (verifyLog) {
    const result = DecisionLog.verify(verifyLog);
    process.stdout.write(result.ok
      ? `decision log OK: ${result.lines} well-formed record(s)\n`
      : `decision log INVALID: ${result.error}\n`);
    return result.ok ? 0 : 1;
  }

  const task = args.get('task');
  if (!task || task === 'true') {
    process.stderr.write('error: --task is required\n\n' + USAGE);
    return 2;
  }

  const driverName = args.get('driver') ?? 'local';
  const workspace = args.get('workspace');
  const logPath = args.has('no-log') ? null : (args.get('log') ?? '.harness/decisions.jsonl');

  let sandbox: SandboxService;
  if (driverName === 'e2b') {
    sandbox = new E2BSandboxService({});
  } else if (driverName === 'local') {
    sandbox = new LocalProcessSandbox(workspace ? { workspaceRoot: workspace, cleanup: false } : {});
  } else {
    process.stderr.write(`error: unknown driver "${driverName}" (expected local or e2b)\n`);
    return 2;
  }

  const num = (key: string, fallback: number): number => {
    const raw = args.get(key);
    const parsed = raw === undefined ? NaN : Number(raw);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  };

  // The local driver resolves model paths against the real workspace directory.
  const session = await sandbox.startSession();
  const workspaceRoot = driverName === 'local'
    ? (session as unknown as { root?: string }).root ?? workspace ?? process.cwd()
    : '/home/user/workspace';
  await session.close();

  const orchestrator = new TDDOrchestrator(
    sandbox,
    (guarded) => new OpenAICompatibleClient(guarded, {
      ...(args.get('model') ? { model: args.get('model') as string } : {}),
      ...(args.get('base-url') ? { baseUrl: args.get('base-url') as string } : {}),
    }),
    {
      workspaceRoot,
      maxVerifications: num('attempts', 3),
      testCommand: args.get('test-command') ?? 'npm test',
      ...(args.get('setup-command') ? { setupCommand: args.get('setup-command') as string } : {}),
      testTimeoutMs: num('timeout', 120_000),
      budgetMs: num('budget-ms', 900_000),
      budgetTokens: num('budget-tokens', 0),
      logPath,
      onEvent: (line) => process.stdout.write(`${line}\n`),
    },
  );

  const outcome = await orchestrator.executeTDDTask(task);
  process.stdout.write('\n' + JSON.stringify(outcome, null, 2) + '\n');
  return outcome.passed ? 0 : 1;
}

main().then(
  (code) => { process.exitCode = code; },
  (e: unknown) => {
    process.stderr.write(`fatal: ${e instanceof Error ? e.stack ?? e.message : String(e)}\n`);
    process.exitCode = 1;
  },
);
