/**
 * Sandbox contracts.
 *
 * Two deliberate differences from the naive shape:
 *
 * 1. `startSession()` returns a HANDLE, not a bare session id string. A flat
 *    service with an unused id cannot address two sandboxes at once, which any
 *    queue-driven or multi-agent deployment needs.
 *
 * 2. `SandboxExecutionResult` is discriminated on `outcome`. `exitCode` is only
 *    reachable when the command actually completed, so "the VM died" cannot be
 *    silently read as "exit code 0, tests passed".
 */

export interface ExecuteCommandParams {
  command: string;
  cwd?: string;
  /** Required. No command may run unbounded. */
  timeoutMs: number;
  env?: Record<string, string>;
}

export interface WriteFileParams { filePath: string; content: string }
export interface ReadFileParams { filePath: string }
export interface ListFilesParams { dirPath: string; recursive?: boolean }

export type SandboxExecutionResult =
  | { outcome: 'completed'; exitCode: number; stdout: string; stderr: string; durationMs: number }
  | { outcome: 'timeout'; stdout: string; stderr: string; durationMs: number; error: string }
  | { outcome: 'sandbox_error'; stdout: string; stderr: string; durationMs: number; error: string };

/** A handle to one live sandbox. */
export interface SandboxSession {
  readonly sessionId: string;
  executeCommand(params: ExecuteCommandParams): Promise<SandboxExecutionResult>;
  writeFile(params: WriteFileParams): Promise<void>;
  readFile(params: ReadFileParams): Promise<string>;
  listFiles(params: ListFilesParams): Promise<string[]>;
  close(): Promise<void>;
}

export interface SandboxService {
  readonly driver: string;
  startSession(): Promise<SandboxSession>;
}

/** Thrown by the guard when a write is refused. Never a silent no-op. */
export class WriteRefusedError extends Error {
  constructor(readonly filePath: string, readonly why: 'outside_workspace' | 'pinned_spec') {
    super(
      why === 'outside_workspace'
        ? `refused write outside the workspace: ${filePath}`
        : `refused write to a pinned test file: ${filePath}`,
    );
    this.name = 'WriteRefusedError';
  }
}
