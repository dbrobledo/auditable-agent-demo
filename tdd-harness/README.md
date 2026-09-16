# auditable-tdd-harness

An AI coding agent harness whose green runs mean something.

A `passed: true` from this harness is a specific claim: **a non-empty test suite,
pinned byte-for-byte since the moment it was written, was observed failing and
then observed passing, inside a bounded execution, with every step recorded in an
append-only log.** Anything weaker is returned as a typed failure, never as a pass.

That is a narrower claim than most TDD loops make, and it is the point. The usual
loop trusts an exit code, and an exit code cannot tell "every test passed" from
"there were no tests" — so the cheapest way for a model to satisfy it is to write
no tests, or to rewrite the ones that fail.

```bash
npm install
npm run demo        # no model server or cloud account needed
```

```
1. An honest model: red, feedback, green
  pinned 1 test file(s)
  attempt 1: RED (exit 1, 2 failing)
  attempt 2: GREEN (3/3 passing)
  verdict: PASSED

2. A model that rewrites the test instead of the code
  verdict: FAILED (test_files_tampered)

3. A model that writes no tests at all
  verdict: FAILED (no_tests_found)
```

## What it refuses

| Behaviour | Outcome |
| --- | --- |
| Writes no test files | `no_tests_found` |
| Runner reports zero tests | `no_tests_found` |
| Suite passes on its first run, never red | `tests_were_never_red` |
| Edits a pinned test via `write_file` | refused by the guard → `test_files_tampered` |
| Edits or deletes a pinned test via the shell | caught by digest check → `test_files_tampered` |
| Writes outside the workspace | refused by the guard |
| Test run hangs | `timeout` |
| Sandbox fault with exit code 0 | `sandbox_error` |
| Model or transport fails | `model_error` |
| Wall-clock or token ceiling hit | `budget_exhausted` |
| Tests genuinely still failing | `tests_still_failing` |

Two independent nets cover spec tampering. The **guard** refuses tool writes to
pinned files before they reach the sandbox. The **digest check** re-hashes every
pinned file before each verification, so a change made any other way — shell
redirection, `rm`, a script the model wrote — is caught too. The guard is
prevention; the digest is detection; neither is a prompt.

## Usage

### CLI

```bash
tdd-harness --task "implement a CSV parser with quoted-field support" \
            --workspace ./work \
            --driver local \
            --model qwen2.5-coder:7b \
            --base-url http://localhost:11434/v1 \
            --setup-command "npm install" \
            --attempts 3
```

Exit codes: `0` passed, `1` did not pass, `2` bad arguments.
`--verify-log <path>` re-checks a decision log and exits non-zero if it is
malformed.

### Library

```ts
import {
  TDDOrchestrator, E2BSandboxService, OpenAICompatibleClient,
} from 'auditable-tdd-harness';

const outcome = await new TDDOrchestrator(
  new E2BSandboxService({ apiKey: process.env.E2B_API_KEY }),
  (session) => new OpenAICompatibleClient(session, {
    baseUrl: 'http://localhost:8000/v1',   // vLLM
    model: 'Qwen/Qwen2.5-Coder-7B-Instruct',
  }),
  {
    maxVerifications: 3,
    testCommand: 'npm test',
    setupCommand: 'npm install',
    testTimeoutMs: 120_000,
    budgetMs: 900_000,
    budgetTokens: 200_000,
    logPath: '.harness/decisions.jsonl',
  },
).executeTDDTask('implement a CSV parser with quoted-field support');

if (!outcome.passed) console.error(outcome.reason, outcome.detail);
```

`TaskOutcome` carries the reason, the attempt count, the parsed test report, the
files written, the **pinned spec digests** (so a caller can prove which tests
passed), duration, tokens, and the log path.

## The decision log

Every gate writes one JSONL line before it acts — including the gates that fail:

```
orchestrator TASK_START     ACCEPTED                     f20eff85ee34...
sandbox      SESSION_OPEN   OPENED                       789367b57ea7...
model        MODEL_TURN     COMPLETED                    8eb399b8624f...
orchestrator SPEC_PINNED    PINNED:1                     61d2291a1b55...
orchestrator VERIFY         RED:exit=1                   526f3013b922...
model        MODEL_TURN     COMPLETED                    b7999b416ae9...
orchestrator VERIFY         GREEN                        e5f248df1bd3...
orchestrator TASK_COMPLETE  PASSED                       f20eff85ee34...
sandbox      SESSION_CLOSE  CLOSED                       789367b57ea7...
```

`input_hash` is the SHA-256 of the exact record the decision was made on, so any
line can be re-verified against its input afterwards. `DecisionLog.verify(path)`
and `--verify-log` check the log is well-formed.

This is what separates "the agent said the tests passed" from a claim you can
check. The log records the RED phase, the GREEN phase, and every refusal, so a
run that was stopped for tampering says so on the record.

## Drivers

| Driver | Isolation | Use for |
| --- | --- | --- |
| `LocalProcessSandbox` | **None** — child processes on your machine | development, CI, debugging |
| `E2BSandboxService` | ephemeral microVM | anything executing model-written code |

`e2b` is an optional peer dependency, imported dynamically, so the package
installs and runs without cloud credentials:

```bash
npm install e2b
export E2B_API_KEY=...
tdd-harness --driver e2b --task "..."
```

The local driver is not an isolation boundary. It constrains paths, not
syscalls — a model can still run arbitrary commands as your user. Use it for
development, and E2B for anything else.

## Configuration

| Option | Default | |
| --- | --- | --- |
| `maxVerifications` | `3` | Verification runs. Repairs = this − 1, so the last repair is always checked. |
| `testCommand` | `npm test` | |
| `setupCommand` | — | Run once before the first verification. |
| `testTimeoutMs` | `120000` | Hard kill deadline per run. |
| `workspaceRoot` | `/home/user/workspace` | All model paths resolve under this. |
| `testFilePatterns` | `*.test.*`, `*.spec.*`, `test/`, `tests/` | What gets pinned. |
| `maxTraceChars` | `6000` | Head+tail window per trace. |
| `budgetMs` | `900000` | Whole-task wall clock. |
| `budgetTokens` | unlimited | Whole-task token ceiling. |
| `maxSpecWriteAttempts` | `2` | Refused spec writes tolerated before failing. |
| `logPath` | — | `null` disables the log. |

Supported runner formats: `node --test`, jest, vitest, mocha. An unrecognised
format is reported as **unknown**, never as a pass — the harness falls back to
the spec pin and the RED gate.

## Verification status

```
npm run typecheck   # strict, NodeNext, noUncheckedIndexedAccess,
                    # exactOptionalPropertyTypes -- clean
npm test            # 65 tests: unit + defect regression
npm run stress      # 11 tests: adversarial input, scale, concurrency
npm run demo        # end-to-end, three model behaviours
```

All of the above were run against real child processes and the real Node test
runner, not mocks. The concurrency test drives six sandboxes in parallel with a
mix of honest and cheating models and checks each verdict independently.

**The E2B driver is the one part not exercised end to end here**, because the
build environment had no `E2B_API_KEY`. It is structurally identical to the
local driver and typechecks against a minimal structural view of the e2b v1 SDK
surface (`Sandbox.create` / `files.*` / `commands.run` / `kill`), but it has not
been run against live E2B infrastructure. Verify it against your account before
relying on it.

### One bug worth naming

An early regression run had the harness reporting a failing suite as green. The
cause was environment inheritance: when the harness itself runs under
`node --test`, `NODE_TEST_CONTEXT` leaks into the sandboxed child, which puts
the child's `node --test` into child-reporter mode, where it **exits 0 even when
tests fail**. A false green produced purely by a leaked variable — exactly the
class of failure this package exists to prevent, found in the package itself.

`LocalProcessSandbox` now scrubs `NODE_TEST_CONTEXT`, `NODE_OPTIONS`,
`NODE_V8_COVERAGE` and inherited `npm_*` variables, and two regression tests
pin the behaviour. The sandbox owes the command a clean environment, not the
harness's own.

## Layout

```
src/
  tdd/orchestrator.ts     the verification loop and its gates
  tdd/test-report.ts      runner output -> {total, passed, failed}
  tdd/trace-window.ts     bounds failure traces before they hit the context
  sandbox/guard.ts        workspace + pinned-spec enforcement
  sandbox/local-process.ts / e2b.ts
  llm/openai-compatible.ts   Ollama / vLLM
  llm/scripted.ts            deterministic client for tests
  mcp/tools.ts / executor.ts
  audit/decision-log.ts   append-only JSONL
test/
  unit.test.ts            parsers, guard, log, sandbox
  defect-regression.test.ts  every refusal, end to end
  stress.test.ts          adversarial input, scale, concurrency
examples/demo.ts
```

Requires Node ≥ 20.11. MIT.
