/**
 * E2B driver -- ephemeral microVMs.
 *
 * `e2b` is an OPTIONAL peer dependency, imported dynamically, so the package
 * installs and runs without cloud credentials. Install it and set E2B_API_KEY
 * to use this driver.
 *
 * Written against the e2b v1 SDK surface (Sandbox.create / files.* /
 * commands.run / kill). See README "Verification status": this driver is
 * structurally identical to the local one but has not been exercised against
 * live E2B infrastructure in the build environment, which had no API key.
 */

import type {
  ExecuteCommandParams, ListFilesParams, ReadFileParams, SandboxExecutionResult,
  SandboxService, SandboxSession, WriteFileParams,
} from './types.js';

export interface E2BOptions {
  apiKey?: string;
  /** E2B template id. Defaults to the SDK's base template. */
  template?: string;
  /** Lifetime of the microVM itself. */
  sandboxTimeoutMs?: number;
  /** Ceiling applied to any single command's timeout. */
  maxTimeoutMs?: number;
}

/** Minimal structural view of the e2b SDK, so we do not depend on its types. */
interface E2BCommandResult { stdout?: string; stderr?: string; exitCode?: number; error?: unknown }
interface E2BSandbox {
  sandboxId: string;
  files: {
    write(path: string, data: string): Promise<unknown>;
    read(path: string): Promise<string>;
    list(path: string): Promise<{ name: string; path?: string; type?: string }[]>;
  };
  commands: {
    run(cmd: string, opts?: { cwd?: string; timeoutMs?: number; envs?: Record<string, string> }): Promise<E2BCommandResult>;
  };
  kill(): Promise<unknown>;
}

class E2BSession implements SandboxSession {
  constructor(private readonly sandbox: E2BSandbox, private readonly maxTimeoutMs: number) {}

  get sessionId(): string { return this.sandbox.sandboxId; }

  async executeCommand(params: ExecuteCommandParams): Promise<SandboxExecutionResult> {
    const started = Date.now();
    const timeoutMs = Math.min(Math.max(1, params.timeoutMs), this.maxTimeoutMs);
    try {
      const r = await this.sandbox.commands.run(params.command, {
        ...(params.cwd ? { cwd: params.cwd } : {}),
        timeoutMs,
        ...(params.env ? { envs: params.env } : {}),
      });
      const durationMs = Date.now() - started;
      const stdout = r.stdout ?? '';
      const stderr = r.stderr ?? '';
      if (typeof r.exitCode !== 'number') {
        return { outcome: 'sandbox_error', stdout, stderr, durationMs,
                 error: `e2b returned no exit code: ${String(r.error ?? 'unknown')}` };
      }
      return { outcome: 'completed', exitCode: r.exitCode, stdout, stderr, durationMs };
    } catch (e) {
      const durationMs = Date.now() - started;
      const message = e instanceof Error ? e.message : String(e);
      // The SDK signals a deadline by throwing; a deadline is not a test verdict.
      const timedOut = /timeout|timed out|deadline/i.test(message) || durationMs >= timeoutMs;
      return timedOut
        ? { outcome: 'timeout', stdout: '', stderr: '', durationMs, error: message }
        : { outcome: 'sandbox_error', stdout: '', stderr: '', durationMs, error: message };
    }
  }

  async writeFile(params: WriteFileParams): Promise<void> {
    await this.sandbox.files.write(params.filePath, params.content);
  }

  async readFile(params: ReadFileParams): Promise<string> {
    return await this.sandbox.files.read(params.filePath);
  }

  async listFiles(params: ListFilesParams): Promise<string[]> {
    const entries = await this.sandbox.files.list(params.dirPath);
    const here = entries.map((e) => e.path ?? `${params.dirPath}/${e.name}`);
    if (!params.recursive) return here;
    const out: string[] = [];
    for (const [i, entry] of entries.entries()) {
      const path = here[i] as string;
      if (entry.type === 'dir' && entry.name !== 'node_modules' && entry.name !== '.git') {
        out.push(...await this.listFiles({ dirPath: path, recursive: true }));
      } else if (entry.type !== 'dir') {
        out.push(path);
      }
    }
    return out;
  }

  async close(): Promise<void> {
    // Never let a teardown failure mask the task's own result.
    try { await this.sandbox.kill(); } catch { /* already reclaimed */ }
  }
}

export class E2BSandboxService implements SandboxService {
  readonly driver = 'e2b';

  constructor(private readonly options: E2BOptions = {}) {}

  async startSession(): Promise<SandboxSession> {
    const apiKey = this.options.apiKey ?? process.env['E2B_API_KEY'];
    if (!apiKey) {
      throw new Error('E2B driver requires an API key: set E2B_API_KEY or pass { apiKey }.');
    }
    let mod: { Sandbox: { create(opts: Record<string, unknown>): Promise<E2BSandbox> } };
    try {
      // Indirect specifier: `e2b` is an optional peer dependency, so it must not
      // be a static import target -- the package has to typecheck and run
      // without it installed.
      const specifier = 'e2b';
      mod = (await import(specifier)) as unknown as typeof mod;
    } catch {
      throw new Error("E2B driver requires the optional peer dependency: npm install e2b");
    }
    const sandbox = await mod.Sandbox.create({
      apiKey,
      ...(this.options.template ? { template: this.options.template } : {}),
      timeoutMs: this.options.sandboxTimeoutMs ?? 300_000,
    });
    return new E2BSession(sandbox, this.options.maxTimeoutMs ?? 600_000);
  }
}
