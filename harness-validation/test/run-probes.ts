// Executable validation of the AI Agent Code Generation Harness design document.
//
// Each probe states a falsifiable claim, then exercises a real orchestrator
// against a real sandbox (temp dir + real child processes + the real Node test
// runner) to see whether the claim holds.
//
// Every scenario runs twice: once against the document's code as written, and
// once against a hardened implementation of the same design. The hardened run
// is a CONTROL GROUP -- it is what makes the suite a fair test rather than a
// set of assertions rigged to fail.

import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join } from 'node:path';
import { LocalSandbox } from './local-sandbox.js';
import { ScriptedLLM, approxTokens, contextBytes, longestSameRoleRun, type Message } from './scripted-llm.js';
import { documentSUT, hardenedSUT, type SUT } from './sut.js';

type Status = 'OK' | 'DEFECT';
interface Result { id: string; title: string; status: Status; evidence: string[] }

let CURRENT: Result[] = [];
const silence = () => { const l = console.log, e = console.error, w = console.warn;
  console.log = () => {}; console.error = () => {}; console.warn = () => {};
  return () => { console.log = l; console.error = e; console.warn = w; }; };

function record(id: string, title: string, status: Status, evidence: string[]) {
  CURRENT.push({ id, title, status, evidence });
  const tag = status === 'OK' ? '✅ OK    ' : '❌ DEFECT';
  console.log(`\n${tag}  ${id}  ${title}`);
  for (const line of evidence) console.log(`          ${line}`);
}

const FAILING_IMPL = 'export function add(a, b) { return a - b; }\n';
const FIXED_IMPL = 'export function add(a, b) { return a + b; }\n';
const REAL_TEST = `import { test } from 'node:test';
import assert from 'node:assert';
import { add } from './impl.mjs';
test('adds', () => { assert.strictEqual(add(2, 3), 5); });
test('adds negatives', () => { assert.strictEqual(add(-1, -1), -2); });
`;
const isTestRun = (c: { method: string; args?: unknown }) =>
  c.method === 'executeCommand' && String((c.args as { command?: string })?.command ?? '').includes('npm run test');
const testRuns = (sb: LocalSandbox) => sb.calls.filter(isTestRun).length;
const why = (sut: SUT) => sut.lastReason() ? ` (reason: ${sut.lastReason()})` : '';

// --- P1 ---------------------------------------------------------------------
async function p1(sut: SUT) {
  const sb = new LocalSandbox(); sb.seedProject();
  const llm = new ScriptedLLM(sb, [
    async (_c, s) => { await s.writeFile({ filePath: 'impl.mjs', content: FAILING_IMPL });
                       await s.writeFile({ filePath: 'impl.test.mjs', content: REAL_TEST }); },
    async (_c, s) => { await s.writeFile({ filePath: 'impl.mjs', content: FIXED_IMPL }); },
  ]);
  const r = silence(); const ok = await sut.run(sb, llm, 'add two numbers', 3); r();
  record('P1', 'Happy path: red -> feedback -> green', ok ? 'OK' : 'DEFECT', [
    `returned: ${ok}${why(sut)}`,
    `test runs: ${testRuns(sb)}, model turns: ${llm.turnsTaken}`,
    `the core loop does work when the model cooperates -- this is the baseline`,
  ]);
  sb.destroy();
}

// --- P2 ---------------------------------------------------------------------
async function p2(sut: SUT) {
  const sb = new LocalSandbox(); sb.seedProject();
  const llm = new ScriptedLLM(sb, [
    async (_c, s) => { await s.writeFile({ filePath: 'impl.mjs', content: FAILING_IMPL });
                       await s.writeFile({ filePath: 'impl.test.mjs', content: REAL_TEST }); },
    async (_c, s) => { await s.writeFile({ filePath: 'impl.mjs', content: FIXED_IMPL }); },
  ]);
  const r = silence(); await sut.run(sb, llm, 'add two numbers', 3); r();
  const started = sb.countOf('startSession'), closed = sb.countOf('closeSession');
  record('P2', 'Sandbox session lifecycle is managed', (started === 1 && closed === 1) ? 'OK' : 'DEFECT', [
    `startSession(): ${started} (expected 1)   closeSession(): ${closed} (expected 1)`,
    `methods invoked: ${[...new Set(sb.calls.map(c => c.method))].join(', ')}`,
    `impact: every completed task leaks a billable E2B microVM, and executeCommand`,
    `        is issued against a session the orchestrator never opened`,
  ]);
  sb.destroy();
}

// --- P3 ---------------------------------------------------------------------
async function p3(sut: SUT) {
  const sb = new LocalSandbox(); sb.seedProject();
  const llm = new ScriptedLLM(sb, [async (_c, s) => {
    await s.writeFile({ filePath: 'impl.mjs', content: FAILING_IMPL });
    await s.writeFile({ filePath: 'impl.test.mjs', content: REAL_TEST }); }]);
  const r = silence(); await sut.run(sb, llm, 'add two numbers', 3); r();
  const last = (llm.seenContexts[llm.seenContexts.length - 1] ?? []) as Message[];
  const roles = last.map(m => m.role);
  const assistants = roles.filter(x => x === 'assistant').length;
  const run = longestSameRoleRun(last, 'user');
  record('P3', 'Conversation context is a valid chat transcript', (assistants > 0 && run <= 1) ? 'OK' : 'DEFECT', [
    `final context roles: [${roles.join(', ')}]`,
    `assistant turns: ${assistants}   longest consecutive 'user' run: ${run}`,
    `impact: the model never sees its own prior replies or its own tool results,`,
    `        so each retry re-reasons blind and repeats fixes it already tried.`,
    `        Consecutive user turns also break the strict alternation Qwen2.5's`,
    `        chat template and most serving stacks assume.`,
  ]);
  sb.destroy();
}

// --- P4 ---------------------------------------------------------------------
async function p4(sut: SUT) {
  const sb = new LocalSandbox(); sb.seedProject();
  await sb.writeFile({ filePath: 'impl.test.mjs', content: REAL_TEST });
  await sb.writeFile({ filePath: 'impl.mjs', content: FAILING_IMPL });
  sb.calls.length = 0;
  const big = ('FAIL  src/thing.test.ts > suite > case\nAssertionError: expected 5 to be 6\n' +
    Array.from({ length: 220 }, (_, i) => `    at Object.<anonymous> (/home/user/src/module${i}.ts:${i + 12}:9)`).join('\n') +
    '\n').repeat(6);
  sb.stub = (p) => p.command.includes('npm run test')
    ? { stdout: big, stderr: big.slice(0, 8000), exitCode: 1, durationMs: 4200 } : null;
  const llm = new ScriptedLLM(sb, []);
  const r = silence(); await sut.run(sb, llm, 'build a parser', 6); r();
  const sizes = llm.seenContexts.map(approxTokens);
  const delta = llm.seenContexts.length > 1
    ? Math.round((contextBytes(llm.seenContexts[1] as Message[]) - contextBytes(llm.seenContexts[0] as Message[])) / 4) : 0;
  const QWEN = 32768;
  const peak = Math.max(...sizes);
  record('P4', 'Failure traces are bounded before entering context', peak < QWEN ? 'OK' : 'DEFECT', [
    `approx tokens per model turn: ${sizes.join(' -> ')}`,
    `growth per failed attempt: ~${delta} tokens`,
    `Qwen2.5-Coder native window = ${QWEN}; peak observed = ${peak}`,
    `impact: no truncation, no head/tail window, no dedup of repeated traces.`,
    `        A verbose suite overflows the window before maxRetries is reached,`,
    `        and there is no branch handling that -- it surfaces as a raw 400.`,
  ]);
  sb.destroy();
}

// --- P5 ---------------------------------------------------------------------
async function p5(sut: SUT) {
  const sb = new LocalSandbox(); sb.seedProject();
  const llm = new ScriptedLLM(sb, [
    async (_c, s) => { await s.writeFile({ filePath: 'impl.mjs', content: FAILING_IMPL });
                       await s.writeFile({ filePath: 'impl.test.mjs', content: REAL_TEST }); },
    async () => {}, async () => {},
    async (_c, s) => { await s.writeFile({ filePath: 'impl.mjs', content: FIXED_IMPL }); },
  ]);
  const r = silence(); const reported = await sut.run(sb, llm, 'add two numbers', 3); r();
  let truth = 1;
  try { execSync('npm run test', { cwd: sb.root, stdio: 'pipe' }); truth = 0; } catch { truth = 1; }
  record('P5', 'Every repair the harness pays for is verified', (reported === (truth === 0)) ? 'OK' : 'DEFECT', [
    `orchestrator reported: ${reported}${why(sut)}`,
    `ground truth, tests re-run against the sandbox afterwards: ${truth === 0 ? 'PASSING' : 'failing'}`,
    `model turns consumed: ${llm.turnsTaken}, test runs: ${testRuns(sb)}`,
    `impact: the loop invokes the model once more AFTER its final verification,`,
    `        then returns false without re-running. The last (paid) generation is`,
    `        never checked, and code that now passes is reported as a failed task.`,
  ]);
  sb.destroy();
}

// --- P6 ---------------------------------------------------------------------
async function p6(sut: SUT) {
  const sb = new LocalSandbox(); sb.seedProject();
  const llm = new ScriptedLLM(sb, [async (_c, s) => {
    await s.writeFile({ filePath: 'impl.mjs', content: FIXED_IMPL });
    await s.writeFile({ filePath: 'impl.test.mjs', content: REAL_TEST }); }]);
  const r = silence(); const ok = await sut.run(sb, llm, 'add two numbers', 0); r();
  record('P6', 'Boundary: maxRetries = 0 still verifies', testRuns(sb) > 0 ? 'OK' : 'DEFECT', [
    `returned: ${ok}${why(sut)}   test runs: ${testRuns(sb)}`,
    `impact: with maxRetries <= 0 the loop body never executes, so the harness`,
    `        reports failure having never run the tests -- on code that is correct.`,
    `        No validation rejects or clamps the value.`,
  ]);
  sb.destroy();
}

// --- P7 ---------------------------------------------------------------------
async function p7(sut: SUT) {
  const sb = new LocalSandbox(); sb.seedProject();
  const llm = new ScriptedLLM(sb, [
    async (_c, s) => { await s.writeFile({ filePath: 'impl.mjs', content: FAILING_IMPL });
                       await s.writeFile({ filePath: 'impl.test.mjs', content: REAL_TEST }); },
    async () => { throw new Error('ECONNREFUSED: Ollama not reachable on :11434'); },
  ]);
  let escaped: string | null = null;
  const r = silence();
  try { await sut.run(sb, llm, 'add two numbers', 3); } catch (e) { escaped = (e as Error).message; }
  r();
  record('P7', 'Model/infra failures are contained and the VM is released', escaped === null ? 'OK' : 'DEFECT', [
    `exception escaped executeTDDTask(): ${escaped ?? 'none'}${escaped ? '' : why(sut)}`,
    `closeSession() called during unwind: ${sb.countOf('closeSession')}`,
    `impact: there is no try/finally anywhere. A model timeout, a 503 from vLLM or`,
    `        an E2B blip rejects the returned promise and strands the microVM.`,
    `        The declared Promise<boolean> does not resolve false -- it throws.`,
  ]);
  sb.destroy();
}

// --- P8 ---------------------------------------------------------------------
async function p8(sut: SUT) {
  const sb = new LocalSandbox(); sb.seedProject();
  await sb.writeFile({ filePath: 'impl.test.mjs', content: REAL_TEST });
  sb.calls.length = 0;
  sb.stub = (p) => p.command.includes('npm run test')
    ? { stdout: '', stderr: '', exitCode: 0, durationMs: 120_000,
        error: 'sandbox terminated: wall-clock limit exceeded before test runner exited' } : null;
  const llm = new ScriptedLLM(sb, [async () => {}]);
  const r = silence(); const ok = await sut.run(sb, llm, 'add two numbers', 3); r();
  record('P8', 'An infrastructure fault is never reported as a green run', ok ? 'DEFECT' : 'OK', [
    `sandbox returned exitCode=0 AND error="sandbox terminated: wall-clock limit exceeded..."`,
    `orchestrator reported success: ${ok}${why(sut)}`,
    `impact: the interface declares an 'error' field the loop never reads. Any`,
    `        infra fault surfacing exitCode 0 becomes a passing TDD run.`,
    `        'durationMs' is likewise collected and never used.`,
  ]);
  sb.destroy();
}

// --- P9 ---------------------------------------------------------------------
async function p9(sut: SUT) {
  const sb = new LocalSandbox(); sb.seedProject();          // test script: node --test
  const llm = new ScriptedLLM(sb, [async (_c, s) => {
    await s.writeFile({ filePath: 'impl.mjs', content: FAILING_IMPL }); }]);   // no tests at all
  const r = silence(); const ok = await sut.run(sb, llm, 'add two numbers', 3); r();
  const wroteTest = sb.calls.some(c => c.method === 'writeFile' &&
    /test|spec/.test(String((c.args as { filePath?: string })?.filePath ?? '')));
  record('P9', 'A green run implies tests actually existed and ran', (ok && !wroteTest) ? 'DEFECT' : 'OK', [
    `test files written by the model: ${wroteTest ? 'yes' : 'NONE'}`,
    `orchestrator reported success: ${ok}${why(sut)}`,
    `root cause: 'node --test' with zero test files exits 0 (verified independently);`,
    `        jest/vitest --passWithNoTests behave identically.`,
    `impact: exitCode===0 is the ONLY success signal, so the harness cannot`,
    `        distinguish "all tests passed" from "there were no tests". The`,
    `        cheapest way for the model to satisfy the loop is to write none.`,
  ]);
  sb.destroy();
}

// --- P10 --------------------------------------------------------------------
async function p10(sut: SUT) {
  const sb = new LocalSandbox(); sb.seedProject();
  const llm = new ScriptedLLM(sb, [
    async (_c, s) => { await s.writeFile({ filePath: 'impl.mjs', content: FAILING_IMPL });
                       await s.writeFile({ filePath: 'impl.test.mjs', content: REAL_TEST }); },
    // The cheap way out: rewrite the TEST, not the implementation.
    async (_c, s) => { await s.writeFile({ filePath: 'impl.test.mjs',
      content: `import { test } from 'node:test';\ntest('adds', () => {});\n` }); },
  ]);
  const r = silence(); const ok = await sut.run(sb, llm, 'add two numbers', 3); r();
  const impl = readFileSync(join(sb.root, 'impl.mjs'), 'utf8').trim();
  const stillBroken = impl.includes('a - b');
  record('P10', 'The spec is pinned: tests cannot be edited to force green', (ok && stillBroken) ? 'DEFECT' : 'OK', [
    `orchestrator reported success: ${ok}${why(sut)}`,
    `implementation after the run: ${impl}`,
    `original assertion add(2,3)===5 still fails: ${stillBroken}`,
    `root cause: write_file takes ANY path with no allowlist, and the loop never`,
    `        compares the test files against what was green-lit. Nothing pins the spec.`,
    `impact: the single most likely failure mode of an autonomous TDD agent,`,
    `        reported to the caller as a passing task.`,
  ]);
  sb.destroy();
}

// --- P11 --------------------------------------------------------------------
async function p11(sut: SUT) {
  const sb = new LocalSandbox();
  sb.seedProject('node -e "setTimeout(()=>process.exit(1), 3000)"');   // a hanging suite
  await sb.writeFile({ filePath: 'impl.test.mjs', content: REAL_TEST });
  sb.calls.length = 0;
  const llm = new ScriptedLLM(sb, [async () => {}]);
  const t0 = Date.now();
  const r = silence(); await sut.run(sb, llm, 'slow suite', 1); r();
  const elapsed = Date.now() - t0;
  const params = sb.calls.find(isTestRun)?.args as Record<string, unknown> | undefined;
  const bounded = params !== undefined && 'timeoutMs' in params;
  record('P11', 'Test execution is bounded by a deadline', bounded ? 'OK' : 'DEFECT', [
    `executeCommand called with: ${JSON.stringify(params)}`,
    `ExecuteCommandParams declares timeoutMs; the document's loop never sets it`,
    `a 3s hanging suite: ${elapsed}ms wall clock${bounded ? ' (killed at the deadline)' : ' absorbed in full, uncapped'}`,
    `impact: an infinite loop in generated code -- a very common LLM defect --`,
    `        pins the sandbox until E2B's own ceiling. maxRetries bounds iterations;`,
    `        nothing bounds wall-clock time or spend.`,
  ]);
  sb.destroy();
}

// --- P12 --------------------------------------------------------------------
function p12(sut: SUT) {
  const src = readFileSync(sut.interfaceSource, 'utf8');
  const block = /export interface ExecuteCommandParams \{([^}]*)\}/.exec(src)?.[1] ?? '';
  const ifaceKeys = [...block.matchAll(/^\s*(\w+)\??:/gm)].map(m => m[1] as string);
  const tool = sut.tools.find(t => t.name === 'execute_command');
  const schemaKeys = Object.keys((tool?.inputSchema as { properties?: object })?.properties ?? {});
  const missing = ifaceKeys.filter(k => !schemaKeys.includes(k));
  const w = sut.tools.find(t => t.name === 'write_file');
  const pathDesc = String(((w?.inputSchema as { properties?: Record<string, { description?: string }> })
    ?.properties?.['filePath']?.description) ?? '');
  const hasList = sut.tools.some(t => t.name === 'list_files');
  record('P12', 'MCP tool schemas match the TypeScript contracts', missing.length === 0 ? 'OK' : 'DEFECT', [
    `ExecuteCommandParams fields: [${ifaceKeys.join(', ')}]`,
    `execute_command schema properties: [${schemaKeys.join(', ')}]`,
    `in the type but NOT in the schema: [${missing.join(', ') || 'none'}]`,
    `write_file.filePath says: "${pathDesc}"`,
    `directory listing tool present: ${hasList ? 'yes' : 'NO -- the model must guess paths'}`,
  ]);
}

// --- P13 --------------------------------------------------------------------
function p13(sut: SUT) {
  const src = readFileSync(sut.interfaceSource, 'utf8');
  const ret = /startSession\(\):\s*Promise<([^>]+)>/.exec(src)?.[1]?.trim() ?? '(not found)';
  const handleBased = ret !== 'string';
  record('P13', 'The sandbox contract can address concurrent sessions', handleBased ? 'OK' : 'DEFECT', [
    `startSession() returns Promise<${ret}>`,
    `per-session operations are ${handleBased ? 'scoped to the returned handle' : 'flat on the service, with no session parameter'}`,
    `impact: the returned id is unusable -- session state is implicit per-instance.`,
    `        The architecture queues tasks over Kafka for "asynchronous multi-agent`,
    `        communication", but one SandboxService cannot address two sandboxes.`,
  ]);
}

// --- runner -----------------------------------------------------------------
async function suite(sut: SUT): Promise<Result[]> {
  CURRENT = [];
  console.log('\n' + '='.repeat(78));
  console.log(`  SUBJECT: ${sut.label}`);
  console.log('='.repeat(78));
  await p1(sut); await p2(sut); await p3(sut); await p4(sut); await p5(sut);
  await p6(sut); await p7(sut); await p8(sut); await p9(sut); await p10(sut);
  await p11(sut); p12(sut); p13(sut);
  return CURRENT;
}

async function main() {
  console.log('='.repeat(78));
  console.log('  VALIDATION PROBES - AI Agent Code Generation Harness');
  console.log('  Document code executed verbatim; real sandbox, real child processes.');
  console.log('='.repeat(78));

  const doc = await suite(documentSUT());
  const hard = await suite(hardenedSUT());

  console.log('\n' + '='.repeat(78));
  console.log('  COMPARISON');
  console.log('='.repeat(78));
  console.log(`  ${'PROBE'.padEnd(6)}${'DOCUMENT'.padEnd(12)}${'HARDENED'.padEnd(12)}TITLE`);
  for (let i = 0; i < doc.length; i++) {
    const d = doc[i] as Result, h = hard[i] as Result;
    console.log(`  ${d.id.padEnd(6)}${(d.status === 'OK' ? 'pass' : 'FAIL').padEnd(12)}` +
                `${(h.status === 'OK' ? 'pass' : 'FAIL').padEnd(12)}${d.title}`);
  }
  const dFail = doc.filter(r => r.status === 'DEFECT').length;
  const hFail = hard.filter(r => r.status === 'DEFECT').length;
  console.log(`\n  document: ${dFail}/${doc.length} probes failed`);
  console.log(`  hardened: ${hFail}/${hard.length} probes failed`);
  console.log(hFail === 0
    ? '\n  The control group passes every probe, so each failure above is a defect\n  in the design, not an unsatisfiable assertion.\n'
    : `\n  WARNING: the control group also fails ${hFail} probe(s) -- those probes are\n  not yet fair tests and their findings are NOT established.\n`);
}

main().catch((e) => { console.error('probe harness crashed:', e); process.exit(1); });
