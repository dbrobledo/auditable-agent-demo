/**
 * Local process driver.
 *
 * Runs commands as child processes in a working directory on this machine.
 * It is NOT an isolation boundary -- it exists so the harness is runnable,
 * testable and debuggable without cloud credentials. Use the E2B driver for
 * anything executing code you did not write.
 */

import { exec } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import type {
  ExecuteCommandParams, ListFilesParams, ReadFileParams, SandboxExecutionResult,
  SandboxService, SandboxSession, WriteFileParams,
} from './types.js';

export interface LocalProcessOptions {
  /** Working directory. A fresh temp dir is created when omitted. */
  workspaceRoot?: string;
  /** Delete the workspace on close. Defaults to true for temp dirs only. */
  cleanup?: boolean;
  /** Hard ceiling applied to any requested timeout. */
  maxTimeoutMs?: number;
  /** Inherit the parent environment (scrubbed). Default true. */
  inheritEnv?: boolean;
}

/**
 * Variables that must never reach the sandboxed command.
 *
 * `NODE_TEST_CONTEXT` is the dangerous one and the reason this list exists: if
 * the harness is itself run under `node --test`, that variable is inherited,
 * and the child `node --test` then switches into child-reporter mode. It prints
 * no summary and EXITS 0 EVEN WHEN TESTS FAIL -- a false green produced purely
 * by environment leakage. `NODE_OPTIONS` carries loaders (tsx, ts-node,
 * coverage hooks) from the parent into a workspace that did not ask for them.
 *
 * The sandbox owes the command a clean environment, not the harness's own.
 */
const SCRUBBED_ENV = [
  'NODE_TEST_CONTEXT',
  'NODE_OPTIONS',
  'NODE_V8_COVERAGE',
  'NODE_REPL_EXTERNAL_MODULE',
];

function cleanEnv(extra: Record<string, string> | undefined, inherit: boolean): NodeJS.ProcessEnv {
  const base: NodeJS.ProcessEnv = {};
  if (inherit) {
    for (const [key, value] of Object.entries(process.env)) {
      if (SCRUBBED_ENV.includes(key)) continue;
      // npm re-derives its own npm_* variables; inherited ones describe the
      // harness's package, not the workspace's, and confuse nested installs.
      if (key.startsWith('npm_')) continue;
      base[key] = value;
    }
  } else {
    base['PATH'] = process.env['PATH'];
    base['HOME'] = process.env['HOME'];
  }
  return { ...base, ...extra };
}

class LocalSession implements SandboxSession {
  readonly sessionId = `local-${randomUUID()}`;

  constructor(
    readonly root: string,
    private readonly cleanup: boolean,
    private readonly maxTimeoutMs: number,
    private readonly inheritEnv: boolean,
  ) {}

  private within(p: string): string {
    const abs = resolve(this.root, p);
    const rel = relative(this.root, abs);
    if (rel.startsWith('..') || (rel !== '' && resolve(this.root, rel) !== abs)) {
      throw new Error(`path escapes the workspace: ${p}`);
    }
    return abs;
  }

  async executeCommand(params: ExecuteCommandParams): Promise<SandboxExecutionResult> {
    const started = Date.now();
    const timeout = Math.min(Math.max(1, params.timeoutMs), this.maxTimeoutMs);
    const cwd = params.cwd ? this.within(params.cwd) : this.root;

    return await new Promise<SandboxExecutionResult>((done) => {
      exec(
        params.command,
        {
          cwd,
          timeout,
          killSignal: 'SIGKILL',
          maxBuffer: 32 * 1024 * 1024,
          env: cleanEnv(params.env, this.inheritEnv),
        },
        (err, stdout, stderr) => {
          const durationMs = Date.now() - started;
          const out = String(stdout);
          const errOut = String(stderr);
          const e = err as (Error & { code?: number | string; killed?: boolean; signal?: string }) | null;

          if (e?.killed || e?.signal === 'SIGKILL') {
            return done({
              outcome: 'timeout', stdout: out, stderr: errOut, durationMs,
              error: `command exceeded ${timeout}ms and was killed`,
            });
          }
          // A non-numeric code means spawn failed (ENOENT, EACCES): the command
          // never ran, so there is no verdict to report.
          if (e && typeof e.code !== 'number') {
            return done({
              outcome: 'sandbox_error', stdout: out, stderr: errOut, durationMs,
              error: `failed to execute: ${e.message}`,
            });
          }
          done({ outcome: 'completed', exitCode: e ? Number(e.code) : 0, stdout: out, stderr: errOut, durationMs });
        },
      );
    });
  }

  async writeFile(params: WriteFileParams): Promise<void> {
    const target = this.within(params.filePath);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, params.content, 'utf8');
  }

  async readFile(params: ReadFileParams): Promise<string> {
    return readFileSync(this.within(params.filePath), 'utf8');
  }

  async listFiles(params: ListFilesParams): Promise<string[]> {
    const base = this.within(params.dirPath);
    const walk = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        if (entry.name === 'node_modules' || entry.name === '.git') return [];
        const full = join(dir, entry.name);
        if (entry.isDirectory()) return params.recursive ? walk(full) : [`${full}${sep}`];
        return [full];
      });
    return walk(base);
  }

  async close(): Promise<void> {
    if (this.cleanup) rmSync(this.root, { recursive: true, force: true });
  }
}

export class LocalProcessSandbox implements SandboxService {
  readonly driver = 'local-process';

  constructor(private readonly options: LocalProcessOptions = {}) {}

  async startSession(): Promise<SandboxSession> {
    const explicit = this.options.workspaceRoot;
    const root = explicit ?? mkdtempSync(join(tmpdir(), 'tdd-harness-'));
    if (explicit) mkdirSync(explicit, { recursive: true });
    return new LocalSession(
      root,
      this.options.cleanup ?? explicit === undefined,
      this.options.maxTimeoutMs ?? 600_000,
      this.options.inheritEnv ?? true,
    );
  }
}
