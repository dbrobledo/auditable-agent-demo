// Hardened TDD orchestrator -- the design document's loop with the 12 confirmed
// defects closed. Used as the CONTROL GROUP for the probe suite: the probes are
// only a fair test of the document if a correct implementation passes them all.

import { createHash } from 'node:crypto';
import type { SandboxService, SandboxSession } from './sandbox-interfaces.js';
import type { LLMClient, Message } from './llm-client.js';

export type FailureReason =
  | 'tests_still_failing' | 'no_tests_found' | 'tests_were_never_red'
  | 'test_files_tampered' | 'sandbox_error' | 'timeout' | 'model_error';

export interface TDDResult {
  passed: boolean;
  reason?: FailureReason;
  attempts: number;
  detail?: string;
  /** Append-only record of every decision, in the spirit of this repo. */
  trace: TraceEntry[];
}

export interface TraceEntry {
  ts: string; event: string; decision: string; basis: string; inputHash: string;
}

export interface TDDOptions {
  /** Verification runs. Repairs allowed = maxVerifications - 1. */
  maxVerifications?: number;
  testCommand?: string;
  testTimeoutMs?: number;
  /** Max chars of a failure trace admitted to context, head+tail windowed. */
  maxTraceChars?: number;
  /** Shell command listing the test files whose contents are pinned. */
  listTestsCommand?: string;
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

/** Head+tail window: the assertion is at the top, the summary at the bottom. */
export function windowTrace(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const half = Math.floor((maxChars - 80) / 2);
  const omitted = text.length - half * 2;
  return `${text.slice(0, half)}\n\n...[${omitted} chars of trace omitted]...\n\n${text.slice(-half)}`;
}

export class HardenedTDDOrchestrator {
  constructor(private sandboxService: SandboxService, private llm: LLMClient) {}

  async executeTDDTask(taskDescription: string, opts: TDDOptions = {}): Promise<TDDResult> {
    const maxVerifications = Math.max(1, opts.maxVerifications ?? 3);
    const testCommand = opts.testCommand ?? 'npm run test';
    const testTimeoutMs = opts.testTimeoutMs ?? 120_000;
    const maxTraceChars = opts.maxTraceChars ?? 6_000;
    const listTestsCommand = opts.listTestsCommand ??
      `find . -path ./node_modules -prune -o \\( -name '*.test.*' -o -name '*.spec.*' \\) -print`;

    const trace: TraceEntry[] = [];
    const log = (event: string, decision: string, basis: string, input = '') =>
      trace.push({ ts: new Date().toISOString(), event, decision, basis, inputHash: sha256(input) });

    const done = (passed: boolean, attempts: number, reason?: FailureReason, detail?: string): TDDResult => {
      log('TASK_COMPLETE', passed ? 'PASSED' : `FAILED:${reason}`, detail ?? '', taskDescription);
      return passed ? { passed, attempts, trace } : { passed, attempts, trace, ...(reason ? { reason } : {}), ...(detail ? { detail } : {}) };
    };

    // DEFECT 2/7: acquire the session explicitly, release it in `finally`.
    let session: SandboxSession;
    try {
      session = await this.sandboxService.startSession();
      log('SESSION_OPEN', 'OPENED', 'sandbox acquired', taskDescription);
    } catch (e) {
      return done(false, 0, 'sandbox_error', `startSession failed: ${(e as Error).message}`);
    }

    try {
      // DEFECT 3: a real transcript. Assistant + tool turns are appended.
      const context: Message[] = [
        { role: 'system', content: 'You are an expert TDD developer.' },
        { role: 'user', content: `Write tests and implementation for: ${taskDescription}. Use tools to write files to the sandbox.` },
      ];

      const runModel = async (): Promise<string | null> => {
        try {
          const produced = await this.llm.generateAndExecuteTools(context);
          context.push(...produced);
          return null;
        } catch (e) { return (e as Error).message; }      // DEFECT 7: contained.
      };

      const modelErr = await runModel();
      if (modelErr) return done(false, 0, 'model_error', modelErr);

      // DEFECT 9/10: pin the spec. Snapshot every test file after generation;
      // any later divergence is tampering, not a fix.
      const digestTestFiles = async (): Promise<Map<string, string>> => {
        const ls = await session.executeCommand({ command: listTestsCommand, timeoutMs: 15_000 });
        const files = ls.stdout.split('\n').map(s => s.trim()).filter(Boolean);
        const out = new Map<string, string>();
        for (const f of files) {
          try { out.set(f, sha256(await session.readFile({ filePath: f }))); } catch { /* vanished */ }
        }
        return out;
      };

      const pinned = await digestTestFiles();
      if (pinned.size === 0) {
        // DEFECT 9: `node --test` / `--passWithNoTests` exit 0 with no tests.
        return done(false, 0, 'no_tests_found',
          'model wrote no test files; exitCode 0 would be indistinguishable from success');
      }
      log('SPEC_PINNED', `PINNED:${pinned.size}`, [...pinned.keys()].join(','), [...pinned.values()].join(','));

      let sawRed = false;

      for (let attempt = 1; attempt <= maxVerifications; attempt++) {
        // DEFECT 10: re-pin before every verification.
        const now = await digestTestFiles();
        for (const [file, digest] of pinned) {
          if (now.get(file) !== digest) {
            return done(false, attempt, 'test_files_tampered',
              `${file} changed after the spec was pinned; the model edited the test instead of the implementation`);
          }
        }
        if (now.size > pinned.size) log('SPEC_EXTENDED', 'ALLOWED', 'model added new test files', '');

        // DEFECT 11: bounded execution.
        const result = await session.executeCommand({ command: testCommand, timeoutMs: testTimeoutMs });

        // DEFECT 8: an infrastructure fault is never a green run.
        if (result.outcome !== 'completed') {
          return done(false, attempt, result.outcome === 'timeout' ? 'timeout' : 'sandbox_error',
            result.error ?? `test command did not complete (${result.outcome})`);
        }

        if (result.exitCode === 0) {
          // DEFECT 9 (second half): green on attempt 1 without ever being red
          // means the suite never constrained anything.
          if (!sawRed && attempt === 1) {
            return done(false, attempt, 'tests_were_never_red',
              'suite passed on the first run; it never demonstrated it can fail, so it does not verify the implementation');
          }
          log('VERIFY', 'GREEN', `attempt ${attempt}`, result.stdout);
          return done(true, attempt);
        }

        sawRed = true;
        log('VERIFY', 'RED', `attempt ${attempt} exit ${result.exitCode}`, result.stdout);

        // DEFECT 5: never spend a generation whose result cannot be verified.
        if (attempt === maxVerifications) {
          return done(false, attempt, 'tests_still_failing',
            `exhausted ${maxVerifications} verifications`);
        }

        // DEFECT 4: window the trace instead of pasting it whole.
        context.push({
          role: 'user',
          content: `The test run failed with exit code ${result.exitCode}.\n\nSTDOUT:\n` +
            `${windowTrace(result.stdout, maxTraceChars)}\n\nSTDERR:\n${windowTrace(result.stderr, maxTraceChars)}\n\n` +
            `Fix the IMPLEMENTATION so these tests pass. The test files are pinned and ` +
            `must not be modified; editing them fails the task.`,
        });

        const err = await runModel();
        if (err) return done(false, attempt, 'model_error', err);
      }

      return done(false, maxVerifications, 'tests_still_failing', 'loop exhausted');
    } finally {
      // DEFECT 2/7: the microVM is released on every path, including throws.
      try { await session.close(); } catch { /* already gone */ }
    }
  }
}
