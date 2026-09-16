/**
 * The TDD verification loop.
 *
 * The contract it enforces: a `passed: true` outcome means a non-empty test
 * suite, pinned byte-for-byte since the moment it was written, was observed
 * failing and then observed passing, inside a bounded execution, with every
 * step recorded in an append-only log.
 *
 * Anything weaker than that is reported as a typed failure, never as a pass.
 */

import { randomUUID } from 'node:crypto';
import { DecisionLog, sha256 } from '../audit/decision-log.js';
import { GuardedSession } from '../sandbox/guard.js';
import type { SandboxService } from '../sandbox/types.js';
import type { LLMClient, Message } from '../llm/types.js';
import type { FailureReason, TaskOutcome, TestReport } from '../types.js';
import { parseTestReport } from './test-report.js';
import { dedupeTrace, windowTrace } from './trace-window.js';

export interface OrchestratorOptions {
  /** Verification runs. Repairs allowed = maxVerifications - 1. Minimum 1. */
  maxVerifications?: number;
  testCommand?: string;
  /** Run once before the first verification, e.g. "npm install". */
  setupCommand?: string;
  testTimeoutMs?: number;
  setupTimeoutMs?: number;
  /** Absolute path inside the sandbox that all model paths resolve under. */
  workspaceRoot?: string;
  /** Glob-ish suffixes identifying the spec. */
  testFilePatterns?: RegExp[];
  maxTraceChars?: number;
  /** Ceiling on total wall-clock time for the whole task. */
  budgetMs?: number;
  /** Ceiling on total tokens across all turns. 0 disables. */
  budgetTokens?: number;
  /** Refused writes to the pinned spec tolerated before the task fails. */
  maxSpecWriteAttempts?: number;
  /** Append-only decision log path. null disables file output. */
  logPath?: string | null;
  systemPrompt?: string;
  onEvent?: (line: string) => void;
}

const DEFAULT_TEST_PATTERNS = [/\.test\.[cm]?[jt]sx?$/, /\.spec\.[cm]?[jt]sx?$/, /(^|\/)tests?\//];

const SYSTEM_PROMPT =
  'You are an expert test-driven developer working inside a sandbox.\n' +
  'Write a failing test suite first, then the implementation that satisfies it.\n' +
  'The test files you write are pinned at the end of your first turn and become ' +
  'read-only: attempts to modify them are refused and fail the task. When tests ' +
  'fail, change the implementation, never the assertions.';

export class TDDOrchestrator {
  constructor(
    private readonly sandboxService: SandboxService,
    /** Built once the guarded session exists, since the client executes tools against it. */
    private readonly makeClient: (session: GuardedSession) => LLMClient,
    private readonly options: OrchestratorOptions = {},
  ) {}

  async executeTDDTask(taskDescription: string): Promise<TaskOutcome> {
    const o = this.options;
    const runId = randomUUID();
    const startedAt = Date.now();
    const maxVerifications = Math.max(1, o.maxVerifications ?? 3);
    const testCommand = o.testCommand ?? 'npm test';
    const testTimeoutMs = o.testTimeoutMs ?? 120_000;
    const workspaceRoot = o.workspaceRoot ?? '/home/user/workspace';
    const patterns = o.testFilePatterns ?? DEFAULT_TEST_PATTERNS;
    const budgetMs = o.budgetMs ?? 900_000;
    const budgetTokens = o.budgetTokens ?? 0;
    const maxSpecWriteAttempts = o.maxSpecWriteAttempts ?? 2;
    const log = new DecisionLog(runId, o.logPath === undefined ? null : o.logPath);
    const emit = o.onEvent ?? (() => {});

    let tokensUsed = 0;
    let pinnedSpec: Record<string, string> = {};
    let filesWritten: string[] = [];
    let attempts = 0;
    let report: TestReport | undefined;

    const finish = (
      passed: boolean,
      reason?: FailureReason,
      detail?: string,
    ): TaskOutcome => {
      log.record('orchestrator', 'TASK_COMPLETE', passed ? 'PASSED' : `FAILED:${reason}`,
        detail ?? '', taskDescription);
      emit(passed ? 'PASSED' : `FAILED: ${reason}${detail ? ` -- ${detail}` : ''}`);
      return {
        passed,
        attempts,
        filesWritten,
        pinnedSpec,
        durationMs: Date.now() - startedAt,
        tokensUsed,
        logPath: o.logPath === undefined ? null : o.logPath,
        runId,
        ...(reason ? { reason } : {}),
        ...(detail ? { detail } : {}),
        ...(report ? { report } : {}),
      };
    };

    log.record('orchestrator', 'TASK_START', 'ACCEPTED',
      `maxVerifications=${maxVerifications} testCommand=${testCommand}`, taskDescription);

    let session: GuardedSession;
    try {
      const raw = await this.sandboxService.startSession();
      session = new GuardedSession(raw, { workspaceRoot });
      log.record('sandbox', 'SESSION_OPEN', 'OPENED', `driver=${this.sandboxService.driver}`, raw.sessionId);
      emit(`sandbox session ${raw.sessionId} (${this.sandboxService.driver})`);
    } catch (e) {
      return finish(false, 'sandbox_error', `startSession failed: ${err(e)}`);
    }

    try {
      const client = this.makeClient(session);
      const context: Message[] = [
        { role: 'system', content: o.systemPrompt ?? SYSTEM_PROMPT },
        {
          role: 'user',
          content:
            `Task: ${taskDescription}\n\n` +
            `Write the test suite and the implementation using the file tools. ` +
            `The harness runs \`${testCommand}\` to verify; you do not need to run it.`,
        },
      ];

      /** One model turn, with failures contained and the transcript kept valid. */
      const runModel = async (): Promise<string | null> => {
        try {
          const turn = await client.generateAndExecuteTools(context);
          context.push(...turn.messages);
          tokensUsed += turn.tokensUsed;
          filesWritten = [...session.written];
          log.record('model', 'MODEL_TURN', 'COMPLETED',
            `messages=${turn.messages.length} tokens=${turn.tokensUsed}`,
            turn.messages.map((m) => m.content).join('\n'));
          return null;
        } catch (e) {
          log.record('model', 'MODEL_TURN', 'FAILED', err(e), '');
          return err(e);
        }
      };

      const overBudget = (): FailureReason | null => {
        if (Date.now() - startedAt > budgetMs) return 'budget_exhausted';
        if (budgetTokens > 0 && tokensUsed > budgetTokens) return 'budget_exhausted';
        return null;
      };

      if (o.setupCommand) {
        const setup = await session.executeCommand({
          command: o.setupCommand,
          timeoutMs: o.setupTimeoutMs ?? 300_000,
        });
        log.record('sandbox', 'SETUP', setup.outcome === 'completed' ? `EXIT:${setup.exitCode}` : setup.outcome,
          o.setupCommand, setup.stdout);
        if (setup.outcome !== 'completed' || setup.exitCode !== 0) {
          return finish(false, setup.outcome === 'timeout' ? 'timeout' : 'sandbox_error',
            `setup command failed: ${o.setupCommand}`);
        }
      }

      const modelError = await runModel();
      if (modelError) return finish(false, 'model_error', modelError);

      // ---- Pin the spec -----------------------------------------------------
      // Everything downstream rests on this: the test files are frozen here, and
      // a green run is only meaningful relative to the exact bytes pinned.
      const digestSpec = async (): Promise<Record<string, string>> => {
        const all = await session.listFiles({ dirPath: '.', recursive: true });
        const specFiles = all.filter((f) => patterns.some((p) => p.test(f)));
        const out: Record<string, string> = {};
        for (const f of specFiles) {
          try { out[f] = sha256(await session.readFile({ filePath: f })); }
          catch { /* deleted between listing and read; caught by the comparison */ }
        }
        return out;
      };

      pinnedSpec = await digestSpec();
      const specPaths = Object.keys(pinnedSpec);

      if (specPaths.length === 0) {
        // An empty suite exits 0 under node:test, jest --passWithNoTests and
        // vitest --passWithNoTests. Accepting it would make "write no tests"
        // the cheapest way to satisfy this loop.
        return finish(false, 'no_tests_found',
          'the model wrote no test files; an exit code of 0 would prove nothing');
      }

      session.pinSpec(specPaths);
      log.record('orchestrator', 'SPEC_PINNED', `PINNED:${specPaths.length}`,
        specPaths.join(','), JSON.stringify(pinnedSpec));
      emit(`pinned ${specPaths.length} test file(s)`);

      let sawRed = false;
      let previousTrace: string | null = null;

      for (let attempt = 1; attempt <= maxVerifications; attempt++) {
        attempts = attempt;

        const budgetBreach = overBudget();
        if (budgetBreach) {
          return finish(false, budgetBreach,
            `budget exhausted after ${Date.now() - startedAt}ms / ${tokensUsed} tokens`);
        }

        // ---- Tamper check, before every run --------------------------------
        // The guard refuses tool writes to pinned files; this catches every
        // other route, including shell redirection through execute_command.
        const current = await digestSpec();
        for (const [file, digest] of Object.entries(pinnedSpec)) {
          if (current[file] !== digest) {
            log.record('orchestrator', 'SPEC_TAMPER', 'DETECTED', file, JSON.stringify(current));
            return finish(false, 'test_files_tampered',
              `${file} changed after the spec was pinned: the model altered the test ` +
              `instead of the implementation`);
          }
        }
        if (session.refusals.filter((r) => r.why === 'pinned_spec').length >= maxSpecWriteAttempts) {
          log.record('orchestrator', 'SPEC_TAMPER', 'REFUSED_REPEATEDLY',
            JSON.stringify(session.refusals), '');
          return finish(false, 'test_files_tampered',
            `the model attempted to rewrite the pinned spec ${session.refusals.length} times`);
        }

        // ---- Bounded verification ------------------------------------------
        const result = await session.executeCommand({ command: testCommand, timeoutMs: testTimeoutMs });

        if (result.outcome !== 'completed') {
          // An infrastructure fault is not a test verdict in either direction.
          log.record('sandbox', 'VERIFY', result.outcome.toUpperCase(), result.error, result.stdout);
          return finish(false, result.outcome === 'timeout' ? 'timeout' : 'sandbox_error', result.error);
        }

        const parsed = parseTestReport(result.stdout, result.stderr);
        if (parsed) report = parsed;

        if (result.exitCode === 0) {
          // A runner that reports zero tests has told us the suite is empty,
          // whatever the exit code says.
          if (parsed && parsed.total === 0) {
            log.record('orchestrator', 'VERIFY', 'EMPTY_SUITE', `parser=${parsed.parser}`, result.stdout);
            return finish(false, 'no_tests_found',
              `${parsed.parser} reported 0 tests; exit code 0 does not mean the code works`);
          }
          // Green on the first run, never having been red, means the suite has
          // not demonstrated it can fail -- so it constrains nothing.
          if (!sawRed) {
            log.record('orchestrator', 'VERIFY', 'NEVER_RED', `attempt=${attempt}`, result.stdout);
            return finish(false, 'tests_were_never_red',
              'the suite passed on its first run without ever failing, so it does not ' +
              'demonstrate that it tests the implementation');
          }
          log.record('orchestrator', 'VERIFY', 'GREEN',
            `attempt=${attempt} tests=${parsed?.total ?? 'unparsed'}`, result.stdout);
          emit(`attempt ${attempt}: GREEN (${parsed ? `${parsed.passed}/${parsed.total} passing` : 'suite passed'})`);
          return finish(true);
        }

        sawRed = true;
        log.record('orchestrator', 'VERIFY', `RED:exit=${result.exitCode}`,
          `attempt=${attempt} tests=${parsed?.total ?? 'unparsed'}`, result.stdout);
        emit(`attempt ${attempt}: RED (exit ${result.exitCode}${parsed ? `, ${parsed.failed} failing` : ''})`);

        // Never buy a repair that cannot be verified: the last attempt is a
        // verification, not a generation.
        if (attempt === maxVerifications) {
          return finish(false, 'tests_still_failing',
            `${maxVerifications} verification(s) exhausted; ${parsed?.failed ?? '?'} test(s) still failing`);
        }

        const stdout = dedupeTrace(windowTrace(result.stdout, { maxChars: o.maxTraceChars ?? 6_000 }), previousTrace);
        previousTrace = windowTrace(result.stdout, { maxChars: o.maxTraceChars ?? 6_000 });

        context.push({
          role: 'user',
          content:
            `The test run failed with exit code ${result.exitCode}.\n\n` +
            `STDOUT:\n${stdout}\n\n` +
            `STDERR:\n${windowTrace(result.stderr, { maxChars: o.maxTraceChars ?? 6_000 })}\n\n` +
            `Fix the IMPLEMENTATION so these tests pass. The test files are pinned ` +
            `and read-only; editing them fails the task.`,
        });

        const repairError = await runModel();
        if (repairError) return finish(false, 'model_error', repairError);
      }

      return finish(false, 'tests_still_failing', 'verification loop exhausted');
    } finally {
      // The microVM is released on every path, including a throw.
      try {
        await session.close();
        log.record('sandbox', 'SESSION_CLOSE', 'CLOSED', '', session.sessionId);
      } catch (e) {
        log.record('sandbox', 'SESSION_CLOSE', 'FAILED', err(e), session.sessionId);
      }
    }
  }
}

const err = (e: unknown): string => (e instanceof Error ? e.message : String(e));
