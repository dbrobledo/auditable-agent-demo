// Adapts the probe suite's LocalSandbox (which implements the DOCUMENT's flat
// contract) to the hardened handle-based contract, so both orchestrators can be
// driven through the exact same sandbox instance and the same recorded call log.
import type { LocalSandbox } from './local-sandbox.js';
import type {
  SandboxService, SandboxSession, ExecuteCommandParams,
  SandboxExecutionResult, WriteFileParams, ReadFileParams,
} from '../src/hardened/sandbox-interfaces.js';

export class HardenedLocalSandbox implements SandboxService {
  constructor(private inner: LocalSandbox) {}

  async startSession(): Promise<SandboxSession> {
    const id = await this.inner.startSession();
    const inner = this.inner;
    return {
      sessionId: id,
      async executeCommand(params: ExecuteCommandParams): Promise<SandboxExecutionResult> {
        const r = await inner.executeCommand(params);
        // The mapping the document's loop was missing: an execution that reports
        // an error did NOT complete, whatever exitCode happens to say.
        if (r.error) {
          return { outcome: /timeout|killed/i.test(r.error) ? 'timeout' : 'sandbox_error',
                   stdout: r.stdout, stderr: r.stderr, exitCode: null,
                   durationMs: r.durationMs, error: r.error };
        }
        return { outcome: 'completed', stdout: r.stdout, stderr: r.stderr,
                 exitCode: r.exitCode, durationMs: r.durationMs };
      },
      writeFile: (p: WriteFileParams) => inner.writeFile(p),
      readFile: (p: ReadFileParams) => inner.readFile(p),
      close: () => inner.closeSession(),
    };
  }
}
