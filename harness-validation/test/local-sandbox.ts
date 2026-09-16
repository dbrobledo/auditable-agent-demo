// A REAL implementation of the document's SandboxService contract, backed by a
// temp dir and a child process. Not a stub: writeFile writes bytes, and
// executeCommand runs the actual command. Stands in for E2B so the document's
// TDDOrchestrator can be exercised end-to-end without a network sandbox.
//
// Every call is instrumented so probes can assert on the orchestrator's
// behaviour (what it called, in what order, with what arguments).

import { exec } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type {
  SandboxService,
  SandboxExecutionResult,
  ExecuteCommandParams,
  WriteFileParams,
  ReadFileParams,
} from '../src/sandbox-interfaces.js';

export interface SandboxCall {
  method: 'startSession' | 'executeCommand' | 'writeFile' | 'readFile' | 'closeSession';
  args?: unknown;
}

export class LocalSandbox implements SandboxService {
  readonly calls: SandboxCall[] = [];
  readonly root: string;
  sessionOpen = false;
  closed = false;

  /**
   * Fault injection. Return a canned result to intercept the command, or null
   * to let it execute for real. Command-scoped so a probe can poison only the
   * test command while `find` etc. still work.
   */
  stub: ((params: ExecuteCommandParams) => SandboxExecutionResult | null) | null = null;

  constructor(prefix = 'harness-probe-') {
    this.root = mkdtempSync(join(tmpdir(), prefix));
  }

  async startSession(): Promise<string> {
    this.calls.push({ method: 'startSession' });
    this.sessionOpen = true;
    return `session-${Math.random().toString(36).slice(2, 10)}`;
  }

  async executeCommand(params: ExecuteCommandParams): Promise<SandboxExecutionResult> {
    this.calls.push({ method: 'executeCommand', args: params });
    if (this.stub) {
      const canned = this.stub(params);
      if (canned) return canned;
    }

    const started = Date.now();
    const cwd = params.cwd ? resolve(this.root, params.cwd) : this.root;

    return await new Promise<SandboxExecutionResult>((resolvePromise) => {
      exec(
        params.command,
        // timeoutMs is honoured ONLY if the caller supplies it. The document's
        // orchestrator never does -- that is what probe 9 measures.
        { cwd, timeout: params.timeoutMs ?? 0, maxBuffer: 32 * 1024 * 1024 },
        (err, stdout, stderr) => {
          const e = err as (Error & { code?: number; killed?: boolean }) | null;
          resolvePromise({
            stdout: String(stdout),
            stderr: String(stderr),
            exitCode: e ? (typeof e.code === 'number' ? e.code : 1) : 0,
            durationMs: Date.now() - started,
            ...(e?.killed ? { error: `killed: command exceeded timeout` } : {}),
          });
        },
      );
    });
  }

  async writeFile(params: WriteFileParams): Promise<void> {
    this.calls.push({ method: 'writeFile', args: params });
    const target = resolve(this.root, params.filePath);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, params.content, 'utf8');
  }

  async readFile(params: ReadFileParams): Promise<string> {
    this.calls.push({ method: 'readFile', args: params });
    return readFileSync(resolve(this.root, params.filePath), 'utf8');
  }

  async closeSession(): Promise<void> {
    this.calls.push({ method: 'closeSession' });
    this.sessionOpen = false;
    this.closed = true;
  }

  /** Test-only helper: seed a runnable npm project into the sandbox. */
  seedProject(testScript = 'node --test'): void {
    writeFileSync(
      join(this.root, 'package.json'),
      JSON.stringify({ name: 'sut', version: '1.0.0', type: 'module', scripts: { test: testScript } }, null, 2),
    );
  }

  countOf(method: SandboxCall['method']): number {
    return this.calls.filter((c) => c.method === method).length;
  }

  destroy(): void {
    rmSync(this.root, { recursive: true, force: true });
  }
}
