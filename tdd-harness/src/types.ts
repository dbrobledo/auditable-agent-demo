/** Shared domain types. */

export type FailureReason =
  | 'no_tests_found'        // the suite is empty; exitCode 0 would prove nothing
  | 'tests_were_never_red'  // the suite passed before any implementation existed
  | 'test_files_tampered'   // the model edited the spec instead of the code
  | 'tests_still_failing'   // honest failure: repairs exhausted
  | 'sandbox_error'         // infrastructure fault; the verdict is unknown
  | 'timeout'               // a deadline was hit
  | 'budget_exhausted'      // wall-clock or token ceiling reached
  | 'model_error';          // the model or its transport failed

export interface TaskOutcome {
  passed: boolean;
  /** Present iff passed === false. */
  reason?: FailureReason;
  detail?: string;
  attempts: number;
  /** Test-suite shape at the moment of the verdict, when it could be parsed. */
  report?: TestReport;
  /** Files the model wrote, excluding rejected writes. */
  filesWritten: string[];
  /** Digests of the pinned spec, so a caller can prove which tests passed. */
  pinnedSpec: Record<string, string>;
  durationMs: number;
  tokensUsed: number;
  /** Path of the append-only decision log for this run. */
  logPath: string | null;
  runId: string;
}

export interface TestReport {
  total: number;
  passed: number;
  failed: number;
  /** Which parser produced this, for auditability. */
  parser: 'node-test' | 'jest' | 'vitest' | 'mocha';
}

export class HarnessError extends Error {
  constructor(message: string, readonly reason: FailureReason) {
    super(message);
    this.name = 'HarnessError';
  }
}
