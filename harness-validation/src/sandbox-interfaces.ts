// sandbox-interfaces.ts  — VERBATIM from the design document under validation.

export interface SandboxExecutionResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
  error?: string;
}

export interface ExecuteCommandParams {
  command: string;
  cwd?: string;
  timeoutMs?: number;
}

export interface WriteFileParams {
  filePath: string;
  content: string;
}

export interface ReadFileParams {
  filePath: string;
}

export interface SandboxService {
  startSession(): Promise<string>;
  executeCommand(params: ExecuteCommandParams): Promise<SandboxExecutionResult>;
  writeFile(params: WriteFileParams): Promise<void>;
  readFile(params: ReadFileParams): Promise<string>;
  closeSession(): Promise<void>;
}
