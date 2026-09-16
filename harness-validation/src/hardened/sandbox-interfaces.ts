// Hardened sandbox contract. Differences from the design document:
//
//  1. startSession() returns a SESSION HANDLE, not a bare string id. Per-session
//     operations live on the handle, so one service can drive N concurrent
//     sandboxes -- which the Kafka/multi-agent architecture requires and the
//     document's flat interface cannot express.
//  2. Execution results carry an explicit, exhaustive outcome discriminant, so
//     "the runner said the tests failed" is not representable as the same value
//     as "the VM died before the runner spoke".
//  3. timeoutMs is REQUIRED on execution, not optional.

export type ExecOutcome =
  | 'completed'          // the command ran to completion; exitCode is meaningful
  | 'timeout'            // killed by the harness deadline
  | 'sandbox_error';     // infrastructure fault; exitCode is NOT meaningful

export interface SandboxExecutionResult {
  outcome: ExecOutcome;
  stdout: string;
  stderr: string;
  /** Meaningful only when outcome === 'completed'. */
  exitCode: number | null;
  durationMs: number;
  error?: string;
}

export interface ExecuteCommandParams {
  command: string;
  cwd?: string;
  /** Required: no command may run unbounded. */
  timeoutMs: number;
}

export interface WriteFileParams { filePath: string; content: string }
export interface ReadFileParams { filePath: string }

/** A handle to one live sandbox. Obtained from SandboxService.startSession(). */
export interface SandboxSession {
  readonly sessionId: string;
  executeCommand(params: ExecuteCommandParams): Promise<SandboxExecutionResult>;
  writeFile(params: WriteFileParams): Promise<void>;
  readFile(params: ReadFileParams): Promise<string>;
  close(): Promise<void>;
}

export interface SandboxService {
  startSession(): Promise<SandboxSession>;
}
