import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, appendFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseTestReport } from '../src/tdd/test-report.js';
import { windowTrace, dedupeTrace } from '../src/tdd/trace-window.js';
import { resolveInWorkspace, GuardedSession } from '../src/sandbox/guard.js';
import { WriteRefusedError, type SandboxSession } from '../src/sandbox/types.js';
import { DecisionLog, sha256 } from '../src/audit/decision-log.js';
import { LocalProcessSandbox } from '../src/sandbox/local-process.js';
import { executeToolCall } from '../src/mcp/executor.js';
import { HARNESS_TOOLS } from '../src/mcp/tools.js';

const ESC = String.fromCharCode(27);

describe('parseTestReport', () => {
  test('node:test summary', () => {
    const r = parseTestReport('# tests 5\n# suites 0\n# pass 3\n# fail 2\n');
    assert.deepEqual(r, { total: 5, passed: 3, failed: 2, parser: 'node-test' });
  });

  test('node:test with zero tests is reported as zero, not as absent', () => {
    // The defect this whole parser exists for: exit code 0 with an empty suite.
    const r = parseTestReport('# tests 0\n# pass 0\n# fail 0\n');
    assert.equal(r?.total, 0);
  });

  test('jest summary', () => {
    const r = parseTestReport('Tests:       1 failed, 2 passed, 3 total\nSnapshots:   0 total\n');
    assert.deepEqual(r, { total: 3, passed: 2, failed: 1, parser: 'jest' });
  });

  test('jest all-passing summary', () => {
    assert.deepEqual(parseTestReport('Tests:       7 passed, 7 total'),
      { total: 7, passed: 7, failed: 0, parser: 'jest' });
  });

  test('vitest summary with failures', () => {
    const r = parseTestReport(' Tests  1 failed | 2 passed (3)\n');
    assert.deepEqual(r, { total: 3, passed: 2, failed: 1, parser: 'vitest' });
  });

  test('vitest all-passing summary', () => {
    assert.deepEqual(parseTestReport(' Tests  4 passed (4)'),
      { total: 4, passed: 4, failed: 0, parser: 'vitest' });
  });

  test('vitest "no tests"', () => {
    assert.equal(parseTestReport(' Tests  no tests')?.total, 0);
  });

  test('mocha summary', () => {
    assert.deepEqual(parseTestReport('  3 passing (12ms)\n  1 failing\n'),
      { total: 4, passed: 3, failed: 1, parser: 'mocha' });
  });

  test('strips ANSI colour before matching', () => {
    const coloured = `${ESC}[32m# tests 2${ESC}[0m\n${ESC}[32m# pass 2${ESC}[0m\n# fail 0`;
    assert.equal(parseTestReport(coloured)?.total, 2);
  });

  test('reads stderr as well as stdout', () => {
    assert.equal(parseTestReport('', 'Tests:       1 passed, 1 total')?.total, 1);
  });

  test('unrecognised output returns null, never a fabricated pass', () => {
    assert.equal(parseTestReport('everything is fine, honest'), null);
    assert.equal(parseTestReport(''), null);
  });
});

describe('windowTrace', () => {
  test('leaves a short trace untouched', () => {
    assert.equal(windowTrace('boom', { maxChars: 100 }), 'boom');
  });

  test('bounds a long trace to the budget', () => {
    const out = windowTrace('x'.repeat(50_000), { maxChars: 1_000 });
    assert.ok(out.length <= 1_000, `expected <= 1000, got ${out.length}`);
    assert.match(out, /characters of trace elided/);
  });

  test('keeps both the head and the tail', () => {
    const text = `ASSERTION_AT_TOP\n${'filler\n'.repeat(5_000)}SUMMARY_AT_BOTTOM`;
    const out = windowTrace(text, { maxChars: 500, dropVendorFrames: false });
    assert.match(out, /ASSERTION_AT_TOP/);
    assert.match(out, /SUMMARY_AT_BOTTOM/);
  });

  test('elides node_modules frames', () => {
    const text = [
      'AssertionError: expected 5 to be 6',
      '    at Object.<anonymous> (/app/src/thing.ts:12:9)',
      '    at run (/app/node_modules/vitest/dist/chunk.js:1:1)',
      '    at go (/app/node_modules/tinypool/dist/index.js:2:2)',
      '    at final (/app/src/other.ts:3:3)',
    ].join('\n');
    const out = windowTrace(text, { maxChars: 10_000 });
    // No vendor FRAME survives; the elision marker naming them is expected.
    assert.doesNotMatch(out, /at .*node_modules\//);
    assert.match(out, /2 node_modules frame\(s\) elided/);
    assert.match(out, /thing\.ts:12:9/);
    assert.match(out, /other\.ts:3:3/);
  });

  test('degenerate budgets do not throw', () => {
    assert.equal(windowTrace('abc', { maxChars: 0 }), '');
    assert.equal(windowTrace('abcdefghij', { maxChars: 3 }).length, 3);
    assert.equal(windowTrace('', { maxChars: 100 }), '');
  });

  test('dedupeTrace collapses a repeat and keeps a change', () => {
    assert.match(dedupeTrace('same', 'same'), /identical to the previous/);
    assert.equal(dedupeTrace('new', 'old'), 'new');
    assert.equal(dedupeTrace('first', null), 'first');
  });
});

describe('resolveInWorkspace', () => {
  const root = '/home/user/workspace';

  test('accepts ordinary relative paths', () => {
    assert.equal(resolveInWorkspace(root, 'src/a.ts'), '/home/user/workspace/src/a.ts');
    assert.equal(resolveInWorkspace(root, './src/a.ts'), '/home/user/workspace/src/a.ts');
  });

  test('accepts an absolute path already inside the workspace', () => {
    assert.equal(resolveInWorkspace(root, '/home/user/workspace/x'), '/home/user/workspace/x');
  });

  test('rejects traversal', () => {
    for (const bad of ['../etc/passwd', 'src/../../../etc/passwd', '../../..']) {
      assert.throws(() => resolveInWorkspace(root, bad), WriteRefusedError, `should reject ${bad}`);
    }
  });

  test('rejects an absolute path outside the workspace', () => {
    assert.throws(() => resolveInWorkspace(root, '/etc/passwd'), WriteRefusedError);
  });

  test('rejects a sibling directory sharing the root prefix', () => {
    // /home/user/workspace-evil must not pass a naive startsWith check.
    assert.throws(() => resolveInWorkspace(root, '/home/user/workspace-evil/x'), WriteRefusedError);
  });

  test('tolerates a trailing slash on the root', () => {
    assert.equal(resolveInWorkspace('/home/user/workspace/', 'a.ts'), '/home/user/workspace/a.ts');
  });
});

describe('GuardedSession', () => {
  const fake = (): SandboxSession & { writes: string[] } => {
    const writes: string[] = [];
    return {
      sessionId: 'fake', writes,
      async executeCommand() { return { outcome: 'completed', exitCode: 0, stdout: '', stderr: '', durationMs: 1 }; },
      async writeFile(p) { writes.push(p.filePath); },
      async readFile() { return ''; },
      async listFiles() { return []; },
      async close() {},
    };
  };

  test('refuses writes to a pinned spec file and records the refusal', async () => {
    const inner = fake();
    const g = new GuardedSession(inner, { workspaceRoot: '/ws' });
    g.pinSpec(['/ws/a.test.ts']);
    await assert.rejects(() => g.writeFile({ filePath: 'a.test.ts', content: 'cheat' }), WriteRefusedError);
    assert.equal(inner.writes.length, 0, 'the refused write must not reach the sandbox');
    assert.equal(g.refusals[0]?.why, 'pinned_spec');
  });

  test('a pinned file cannot be reached by traversing back to it', async () => {
    const g = new GuardedSession(fake(), { workspaceRoot: '/ws' });
    g.pinSpec(['/ws/a.test.ts']);
    await assert.rejects(() => g.writeFile({ filePath: 'sub/../a.test.ts', content: 'cheat' }), WriteRefusedError);
  });

  test('allows writes to implementation files', async () => {
    const inner = fake();
    const g = new GuardedSession(inner, { workspaceRoot: '/ws' });
    g.pinSpec(['/ws/a.test.ts']);
    await g.writeFile({ filePath: 'a.ts', content: 'ok' });
    assert.deepEqual(inner.writes, ['/ws/a.ts']);
    assert.deepEqual(g.written, ['/ws/a.ts']);
  });

  test('defaults executeCommand cwd to the workspace root', async () => {
    let seen: string | undefined;
    const inner = fake();
    inner.executeCommand = async (p) => { seen = p.cwd; return { outcome: 'completed', exitCode: 0, stdout: '', stderr: '', durationMs: 1 }; };
    const g = new GuardedSession(inner, { workspaceRoot: '/ws' });
    await g.executeCommand({ command: 'ls', timeoutMs: 1000 });
    assert.equal(seen, '/ws');
  });
});

describe('DecisionLog', () => {
  test('writes verifiable append-only JSONL', () => {
    const dir = mkdtempSync(join(tmpdir(), 'log-'));
    const path = join(dir, 'decisions.jsonl');
    const log = new DecisionLog('run-1', path);
    log.record('orchestrator', 'TASK_START', 'ACCEPTED', 'basis', 'the input');
    log.record('sandbox', 'VERIFY', 'RED:exit=1', 'attempt=1', 'output');

    const verified = DecisionLog.verify(path);
    assert.equal(verified.ok, true, verified.error);
    assert.equal(verified.lines, 2);

    const lines = readFileSync(path, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(lines[0].input_hash, sha256('the input'));
    assert.equal(lines[0].run_id, 'run-1');
    assert.equal(lines[1].decision, 'RED:exit=1');
    rmSync(dir, { recursive: true, force: true });
  });

  test('flags a corrupted log', () => {
    const dir = mkdtempSync(join(tmpdir(), 'log-'));
    const path = join(dir, 'decisions.jsonl');
    const log = new DecisionLog('run-2', path);
    log.record('orchestrator', 'E', 'D', 'B', 'i');
    appendFileSync(path, '{"ts":"x"}\n');
    const verified = DecisionLog.verify(path);
    assert.equal(verified.ok, false);
    assert.match(verified.error ?? '', /line 2/);
    rmSync(dir, { recursive: true, force: true });
  });

  test('verifying a missing log fails rather than passing vacuously', () => {
    assert.equal(DecisionLog.verify('/nonexistent/decisions.jsonl').ok, false);
  });
});

describe('LocalProcessSandbox', () => {
  test('runs a command and reports completion', async () => {
    const svc = new LocalProcessSandbox();
    const s = await svc.startSession();
    const r = await s.executeCommand({ command: 'echo hello', timeoutMs: 5_000 });
    assert.equal(r.outcome, 'completed');
    assert.equal(r.outcome === 'completed' && r.exitCode, 0);
    assert.match(r.stdout, /hello/);
    await s.close();
  });

  test('a timeout is reported as timeout, never as an exit code', async () => {
    const svc = new LocalProcessSandbox();
    const s = await svc.startSession();
    const r = await s.executeCommand({ command: 'sleep 5', timeoutMs: 400 });
    assert.equal(r.outcome, 'timeout');
    assert.ok(!('exitCode' in r), 'a timed-out run must not expose an exit code');
    await s.close();
  });

  test('a command that cannot spawn is a sandbox_error, not a failing test run', async () => {
    const svc = new LocalProcessSandbox();
    const s = await svc.startSession();
    const r = await s.executeCommand({ command: 'this-binary-does-not-exist', timeoutMs: 5_000 });
    // The shell reports 127; what matters is that it is not silently a pass.
    assert.notEqual(r.outcome === 'completed' ? r.exitCode : 1, 0);
    await s.close();
  });

  test('round-trips files and refuses to escape the workspace', async () => {
    const svc = new LocalProcessSandbox();
    const s = await svc.startSession();
    await s.writeFile({ filePath: 'nested/dir/a.txt', content: 'content' });
    assert.equal(await s.readFile({ filePath: 'nested/dir/a.txt' }), 'content');
    assert.ok((await s.listFiles({ dirPath: '.', recursive: true })).some((f) => f.endsWith('a.txt')));
    await assert.rejects(() => s.writeFile({ filePath: '../escape.txt', content: 'x' }));
    await s.close();
  });

  test('scrubs environment variables that would corrupt the child run', async () => {
    // Regression: NODE_TEST_CONTEXT leaking from a parent `node --test` puts a
    // child `node --test` into child-reporter mode, where it EXITS 0 EVEN WHEN
    // TESTS FAIL. Inheriting the parent environment wholesale manufactures a
    // false green. This suite runs under node --test, so the variable is
    // genuinely present in process.env here.
    const svc = new LocalProcessSandbox();
    const s = await svc.startSession();
    const r = await s.executeCommand({
      command: 'node -e "console.log(JSON.stringify({t:process.env.NODE_TEST_CONTEXT??null,o:process.env.NODE_OPTIONS??null,n:Object.keys(process.env).filter(k=>k.startsWith(\'npm_\')).length}))"',
      timeoutMs: 10_000,
    });
    assert.equal(r.outcome, 'completed');
    const seen = JSON.parse(r.stdout.trim()) as { t: string | null; o: string | null; n: number };
    assert.equal(seen.t, null, 'NODE_TEST_CONTEXT reached the sandboxed command');
    assert.equal(seen.o, null, 'NODE_OPTIONS reached the sandboxed command');
    assert.equal(seen.n, 0, 'inherited npm_* variables reached the sandboxed command');
    await s.close();
  });

  test('a failing child test suite really does report a non-zero exit', async () => {
    // The end-to-end form of the same regression.
    const svc = new LocalProcessSandbox();
    const s = await svc.startSession();
    await s.writeFile({ filePath: 'package.json', content: JSON.stringify({ name: 'x', type: 'module', scripts: { test: 'node --test' } }) });
    await s.writeFile({
      filePath: 'a.test.mjs',
      content: "import { test } from 'node:test';\nimport assert from 'node:assert';\ntest('fails', () => { assert.equal(1, 2); });\n",
    });
    const r = await s.executeCommand({ command: 'npm test', timeoutMs: 30_000 });
    assert.equal(r.outcome, 'completed');
    assert.notEqual(r.outcome === 'completed' && r.exitCode, 0, 'a failing suite reported success');
    await s.close();
  });

  test('close cleans up a temp workspace', async () => {
    const svc = new LocalProcessSandbox();
    const s = await svc.startSession();
    const root = (s as unknown as { root: string }).root;
    await s.close();
    assert.equal(existsSync(root), false);
  });
});

describe('tool schemas and executor', () => {
  test('every schema is closed and self-describing', () => {
    for (const tool of HARNESS_TOOLS) {
      assert.equal(tool.inputSchema.additionalProperties, false, `${tool.name} accepts stray properties`);
      assert.ok(tool.description.length > 20, `${tool.name} has a thin description`);
      for (const req of tool.inputSchema.required) {
        assert.ok(tool.inputSchema.properties[req], `${tool.name} requires undeclared "${req}"`);
      }
    }
  });

  test('execute_command exposes timeoutMs, matching ExecuteCommandParams', () => {
    const tool = HARNESS_TOOLS.find((t) => t.name === 'execute_command');
    assert.ok(tool?.inputSchema.properties['timeoutMs'], 'the model cannot set a deadline it cannot see');
  });

  test('a refused write comes back as a tool result with guidance, not an exception', async () => {
    const svc = new LocalProcessSandbox();
    const raw = await svc.startSession();
    const root = (raw as unknown as { root: string }).root;
    const g = new GuardedSession(raw, { workspaceRoot: root });
    g.pinSpec([`${root}/a.test.mjs`]);

    const r = await executeToolCall(g, {
      id: '1', name: 'write_file', arguments: { filePath: 'a.test.mjs', content: 'cheat' },
    });
    assert.equal(r.ok, false);
    assert.equal(r.refused, 'pinned_spec');
    assert.match(r.result, /Change the implementation/);
    await raw.close();
  });

  test('unknown tools and missing arguments fail closed', async () => {
    const svc = new LocalProcessSandbox();
    const raw = await svc.startSession();
    const g = new GuardedSession(raw, { workspaceRoot: (raw as unknown as { root: string }).root });
    assert.match((await executeToolCall(g, { id: '1', name: 'nope', arguments: {} })).result, /unknown tool/);
    assert.match((await executeToolCall(g, { id: '2', name: 'write_file', arguments: {} })).result, /required/);
    assert.match((await executeToolCall(g, { id: '3', name: 'execute_command', arguments: {} })).result, /required/);
    await raw.close();
  });
});
