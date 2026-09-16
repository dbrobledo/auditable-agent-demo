/**
 * Enforces the two write rules at the SESSION boundary.
 *
 *   1. No write may escape the workspace root.
 *   2. Once the spec is pinned, no write may touch a pinned test file.
 *
 * Both rules live here, not in a prompt and not in a tool description, because
 * a model that is asked nicely to leave the tests alone will eventually not.
 * A schema description is documentation; this is a mechanism.
 *
 * Rule 2 is what makes a green run mean something. Without it the cheapest path
 * to green is to rewrite the assertion, and the harness reports success.
 */

import { posix } from 'node:path';
import {
  WriteRefusedError,
  type ListFilesParams,
  type ExecuteCommandParams,
  type ReadFileParams,
  type SandboxExecutionResult,
  type SandboxSession,
  type WriteFileParams,
} from './types.js';

export interface GuardOptions {
  /** Absolute POSIX path inside the sandbox that all paths resolve under. */
  workspaceRoot: string;
}

/** Resolve a model-supplied path against the workspace, or reject it. */
export function resolveInWorkspace(root: string, filePath: string): string {
  const normalisedRoot = posix.normalize(root).replace(/\/+$/, '');
  const candidate = posix.isAbsolute(filePath)
    ? posix.normalize(filePath)
    : posix.normalize(posix.join(normalisedRoot, filePath));
  if (candidate !== normalisedRoot && !candidate.startsWith(`${normalisedRoot}/`)) {
    throw new WriteRefusedError(filePath, 'outside_workspace');
  }
  return candidate;
}

export class GuardedSession implements SandboxSession {
  private pinned = new Set<string>();
  /** Every write the guard refused, for the decision log. */
  readonly refusals: { filePath: string; why: string }[] = [];
  /** Every write the guard allowed, in order. */
  readonly written: string[] = [];

  constructor(private readonly inner: SandboxSession, private readonly options: GuardOptions) {}

  get sessionId(): string { return this.inner.sessionId; }

  /** Freeze a set of absolute paths as immutable for the rest of the run. */
  pinSpec(paths: Iterable<string>): void {
    this.pinned = new Set([...paths].map((p) => resolveInWorkspace(this.options.workspaceRoot, p)));
  }

  isPinned(filePath: string): boolean {
    try {
      return this.pinned.has(resolveInWorkspace(this.options.workspaceRoot, filePath));
    } catch {
      return false;
    }
  }

  async writeFile(params: WriteFileParams): Promise<void> {
    let resolved: string;
    try {
      resolved = resolveInWorkspace(this.options.workspaceRoot, params.filePath);
    } catch (e) {
      this.refusals.push({ filePath: params.filePath, why: 'outside_workspace' });
      throw e;
    }
    if (this.pinned.has(resolved)) {
      this.refusals.push({ filePath: resolved, why: 'pinned_spec' });
      throw new WriteRefusedError(resolved, 'pinned_spec');
    }
    await this.inner.writeFile({ filePath: resolved, content: params.content });
    this.written.push(resolved);
  }

  async readFile(params: ReadFileParams): Promise<string> {
    return this.inner.readFile({
      filePath: resolveInWorkspace(this.options.workspaceRoot, params.filePath),
    });
  }

  async listFiles(params: ListFilesParams): Promise<string[]> {
    return this.inner.listFiles({
      dirPath: resolveInWorkspace(this.options.workspaceRoot, params.dirPath),
      ...(params.recursive === undefined ? {} : { recursive: params.recursive }),
    });
  }

  async executeCommand(params: ExecuteCommandParams): Promise<SandboxExecutionResult> {
    return this.inner.executeCommand({
      ...params,
      cwd: params.cwd
        ? resolveInWorkspace(this.options.workspaceRoot, params.cwd)
        : this.options.workspaceRoot,
    });
  }

  async close(): Promise<void> { await this.inner.close(); }
}
