# Validation report — AI Agent Code Generation Harness

**Method.** The design document's `sandbox-interfaces.ts`, `mcp-tools.ts` and
`tdd-loop.ts` were transcribed verbatim into `src/` and executed. Nothing was
read and reasoned about in the abstract: `TDDOrchestrator` was driven against a
real `SandboxService` implementation (`test/local-sandbox.ts`) backed by a temp
directory and real child processes, with a scripted model client standing in for
Qwen. Thirteen probes each assert one falsifiable claim.

**Control group.** Every scenario also runs against `src/hardened/`, a corrected
implementation of the same design. The control passes 13/13. That is what makes
the failures below defects in the design rather than assertions written to fail.

```
  PROBE DOCUMENT    HARDENED    TITLE
  P1    pass        pass        Happy path: red -> feedback -> green
  P2    FAIL        pass        Sandbox session lifecycle is managed
  P3    FAIL        pass        Conversation context is a valid chat transcript
  P4    FAIL        pass        Failure traces are bounded before entering context
  P5    FAIL        pass        Every repair the harness pays for is verified
  P6    FAIL        pass        Boundary: maxRetries = 0 still verifies
  P7    FAIL        pass        Model/infra failures are contained and the VM is released
  P8    FAIL        pass        An infrastructure fault is never reported as a green run
  P9    FAIL        pass        A green run implies tests actually existed and ran
  P10   FAIL        pass        The spec is pinned: tests cannot be edited to force green
  P11   FAIL        pass        Test execution is bounded by a deadline
  P12   FAIL        pass        MCP tool schemas match the TypeScript contracts
  P13   FAIL        pass        The sandbox contract can address concurrent sessions

  document: 12/13 probes failed        hardened: 0/13 probes failed
```

Reproduce with `npm install && npm run probe`.

---

## What holds up

The architecture is sound in outline, and P1 confirms the loop works: given a
cooperative model, the orchestrator writes a failing implementation, runs the
suite, feeds the trace back, and reaches green in two attempts. The layering
(orchestrator / cognitive engine / sandbox / state) is the right decomposition,
`SandboxService` is a clean seam that made this validation possible at all, and
execute-in-a-microVM is the correct answer to running model-authored code.

The defects are in the verification loop, which is the part the document calls
its core feature.

---

## Critical — the harness reports success it has not established

### C1. The success signal cannot distinguish "tests passed" from "no tests ran" (P9)

`exitCode === 0` is the only thing consulted. `node --test` with zero test files
exits 0 — verified independently, not assumed. `jest --passWithNoTests` and
`vitest --passWithNoTests` are the same.

Observed: the model wrote an implementation and no test file at all. The
orchestrator returned `true` on attempt 1.

For a harness whose stated purpose is TDD, the cheapest strategy available to the
model is to write no tests.

**Fix:** parse the runner's structured output (`--reporter=json`, `--json`);
require `numTotalTests > 0`. Require a RED run before accepting a green one — a
suite that has never failed has not demonstrated it constrains anything.

### C2. The model can edit the tests to force green (P10)

`write_file` accepts any path, with no allowlist, and the loop never compares the
test files against what it started with. The retry prompt asks for an
implementation fix but nothing enforces it.

Observed: turn 1 wrote a real test plus a broken `add()`; turn 2 overwrote the
*test file* with an empty one. Orchestrator returned `true`. The implementation
left in the sandbox was still `return a - b`, and `add(2,3) === 5` still fails.

This is the most likely failure mode of an autonomous TDD agent and it is
reported to the caller as a passing task.

**Fix:** SHA-256 every test file once written, re-verify the digests before each
run, and fail the task on divergence. Enforce the allowlist in the sandbox layer
too — schema descriptions are not a security boundary.

### C3. Infrastructure faults are laundered into green runs (P8)

`SandboxExecutionResult.error` is declared and never read. A result carrying
`exitCode: 0` alongside `error: "sandbox terminated: wall-clock limit exceeded
before test runner exited"` was reported as success.

`durationMs` is likewise collected and never used.

**Fix:** make the result a discriminated union on outcome
(`completed | timeout | sandbox_error`) so `exitCode` is only reachable when it
is meaningful. See `src/hardened/sandbox-interfaces.ts`.

---

## High — correctness and cost

### H1. The final generation is paid for and never verified (P5)

The loop's last iteration runs the tests, fails, appends the trace, calls the
model — then exits the `for` and returns `false` without re-running. The last
repair is applied to the sandbox and never checked.

Observed: the model fixed the code on its final turn. The orchestrator reported
`false`; re-running the suite against that same sandbox immediately afterwards
showed **PASSING**. Working code was reported as a failed task, and a full
generation was discarded.

**Fix:** verifications = repairs + 1. Don't request a repair you cannot check.

### H2. The conversation is not a valid chat transcript (P3)

Only `user` messages are ever appended. Observed final context roles:
`[system, user, user, user, user]` — zero assistant turns, zero tool results,
four consecutive user messages.

Two consequences. The model never sees its own prior replies or the results of
its own tool calls, so every retry re-reasons blind and tends to repeat fixes it
already tried. And consecutive user turns violate the strict alternation
Qwen2.5's chat template and most serving stacks assume.

**Fix:** `generateAndExecuteTools` must return the turn's messages so the
orchestrator can append assistant and tool-result turns.

### H3. Failure traces are pasted whole into a 32k window (P4)

No truncation, no windowing, no dedup. Measured with a realistic stack-heavy
trace: ~22,700 tokens added per failed attempt.

```
approx tokens per model turn: 46 -> 22735 -> 45423 -> 68112 -> 90800 -> 113489 -> 136177
```

Qwen2.5-Coder's native window is 32,768 tokens, so this overflows on attempt 2 —
before `maxRetries = 3` is reached. There is no branch handling that; it surfaces
as a raw serving error. The same trace also repeats verbatim each attempt while
only one line of it usually matters.

**Fix:** head+tail window each trace (~6k chars), drop frames inside
`node_modules`, and collapse a trace identical to the previous attempt's into a
one-line "unchanged". Hardened run: ~3,100 tokens per attempt, peak 15.6k.

### H4. No error containment, and the sandbox leaks on every path (P2, P7)

`startSession()` and `closeSession()` are declared and never called. Across a
complete successful task the orchestrator invoked only `writeFile` and
`executeCommand` — so commands are issued against a session it never opened, and
every task leaks a billable microVM.

There is no `try/finally` anywhere. Injecting `ECONNREFUSED: Ollama not
reachable on :11434` on turn 2, the exception escaped `executeTDDTask()`
entirely: the declared `Promise<boolean>` does not resolve `false`, it rejects.
`closeSession()` was called 0 times during the unwind.

**Fix:** acquire in a `try`, release in a `finally`, catch model and sandbox
errors into a typed failure result.

### H5. Nothing bounds wall-clock time or spend (P11)

`ExecuteCommandParams` declares `timeoutMs`; the loop never passes it. Observed
call: `{"command":"npm run test"}`. A 3-second hanging suite was absorbed in
full, uncapped.

An infinite loop in generated code is a common LLM defect. `maxRetries` bounds
iterations; nothing bounds time or cost. There is also no per-task token budget.

---

## Medium

### M1. `maxRetries = 0` reports failure without running anything (P6)

The loop body never executes; the harness returns `false` having never run the
tests, on code that was correct. No validation rejects or clamps the value.
`maxRetries` is also misnamed — it counts total verification attempts, not
retries.

### M2. Tool schemas have drifted from the types (P12)

`ExecuteCommandParams` is `[command, cwd, timeoutMs]`; the `execute_command`
schema exposes `[command, cwd]`. The model cannot set a timeout even if it wants
one. No `additionalProperties: false` on any schema. No `list_files` tool, so the
model must guess paths or read blind. `write_file`'s "Absolute or relative path"
actively invites the traversal that C2 exploits.

### M3. The sandbox contract cannot express concurrency (P13)

`startSession()` returns `Promise<string>` and no other method accepts that id —
session state is implicit per-instance. The architecture queues tasks over Kafka
for "asynchronous multi-agent communication", but one `SandboxService` cannot
address two sandboxes. Either the id is dead weight or the contract needs to be
handle-based.

### M4. `Promise<boolean>` discards every diagnostic

The caller learns `false` and nothing else — not whether it was a test failure,
a model outage, a timeout, or tampering. Those need different responses:
requeue, alert, extend budget, reject. A typed result carries them.

### M5. The document's code does not compile under its own module system

```
src/tdd-loop.ts(2,32): error TS2835: Relative import paths need explicit file
  extensions in ECMAScript imports when '--moduleResolution' is 'node16' or 'nodenext'
src/tdd-loop.ts(3,27): error TS2835: ...
```

`mcp-tools.ts` imports `@modelcontextprotocol/sdk/types.js` in ESM style while
`tdd-loop.ts` uses extensionless relative imports. The MCP SDK is
`"type": "module"`. Under `moduleResolution: NodeNext` — the correct setting for
Node 22 ESM — this fails. It does compile under legacy `moduleResolution: node`
(`tsconfig.classic.json`), so it is a portability bug, not a blocker. Also:
`let conversationContext` is never reassigned, and its inferred `role: string`
should be a union.

---

## Architecture-level observations

**Kafka and Aurora are load-bearing for a system described as locally hosted.**
Both are introduced without a stated requirement that needs them. For a
single-operator harness, SQLite or local Postgres plus an in-process queue covers
the same ground, and the failure modes you actually hit — context overflow,
reward hacking, VM leaks — are none of them distribution problems. Kafka's
at-least-once delivery also means a task can be re-consumed and re-run; nothing
in the design is idempotent, so a redelivered task re-enters the loop and spends
again.

**Nothing observes the loop.** `console.log` is the entire instrumentation.
Given that this repo is a demonstration of auditable agents, the gap is worth
naming: the harness should be writing an append-only decision record —
`{ts, actor, event, input_hash, decision, basis}` — exactly as `agent.py` does.
Each verification attempt should log the test-file digests it checked, the exit
code, the trace hash, and the decision made. That record is what turns "the agent
said it passed" into something checkable after the fact, and it would have made
C1, C2 and C3 visible in production rather than only under a probe.

**TDD is asserted, not enforced.** The document frames the loop as TDD, but the
first model turn is asked for tests *and* implementation together, and nothing
checks that the tests were red before they were green. Without a RED gate plus
pinned test digests, "autonomous TDD" is a prompt, not a mechanism.

---

## Recommended order

1. **C2, C1** — pin test digests, require a RED phase and a non-zero test count.
   Until these land, a green result from this harness means nothing.
2. **C3, H4** — discriminated execution outcomes; `try/finally` and typed failures.
3. **H1, H5** — verify the last repair; pass `timeoutMs`; add a token budget.
4. **H2, H3** — real transcript with assistant/tool turns; window the traces.
5. **M1–M5** — schema/type alignment, handle-based sessions, typed results.
6. Add the append-only decision log before anything runs unattended.

`src/hardened/` implements 1–5 and is the executable form of these
recommendations.
