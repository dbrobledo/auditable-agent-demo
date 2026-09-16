/**
 * Parses a test runner's summary into a structured report.
 *
 * Why this exists: an exit code cannot distinguish "every test passed" from
 * "there were no tests". `node --test` with zero test files exits 0, and so do
 * `jest --passWithNoTests` and `vitest --passWithNoTests`. A harness that trusts
 * the exit code alone can be satisfied by writing no tests at all, which is the
 * cheapest strategy available to the model.
 *
 * Every parser here must report a TOTAL, because the total is the thing the
 * exit code hides.
 */

import type { TestReport } from '../types.js';

/** Strip ANSI SGR sequences so colourised CI output still parses. */
const ANSI = new RegExp(String.fromCharCode(27) + '\\[[0-9;]*m', 'g');
const stripAnsi = (s: string): string => s.replace(ANSI, '');

type Parser = (text: string) => TestReport | null;

/** node:test TAP/spec summary: "# tests 5" / "# pass 3" / "# fail 2". */
const nodeTest: Parser = (text) => {
  const total = /^# tests (\d+)$/m.exec(text);
  if (!total) return null;
  const pass = /^# pass (\d+)$/m.exec(text);
  const fail = /^# fail (\d+)$/m.exec(text);
  return {
    total: Number(total[1]),
    passed: pass ? Number(pass[1]) : 0,
    failed: fail ? Number(fail[1]) : 0,
    parser: 'node-test',
  };
};

/** jest: "Tests:  1 failed, 2 passed, 3 total". */
const jest: Parser = (text) => {
  const line = /^Tests:\s+(.+)$/m.exec(text);
  if (!line) return null;
  const body = line[1] as string;
  if (!/\btotal\b/.test(body)) return null;
  const num = (label: string): number => {
    const m = new RegExp(`(\\d+) ${label}`).exec(body);
    return m ? Number(m[1]) : 0;
  };
  return { total: num('total'), passed: num('passed'), failed: num('failed'), parser: 'jest' };
};

/** vitest: "Tests  1 failed | 2 passed (3)" or "Tests  3 passed (3)". */
const vitest: Parser = (text) => {
  const line = /^\s*Tests\s{2,}(.+)$/m.exec(text);
  if (!line) return null;
  const body = line[1] as string;
  if (/no tests/i.test(body)) return { total: 0, passed: 0, failed: 0, parser: 'vitest' };
  const totalMatch = /\((\d+)\)\s*$/.exec(body);
  if (!totalMatch) return null;
  const num = (label: string): number => {
    const m = new RegExp(`(\\d+) ${label}`).exec(body);
    return m ? Number(m[1]) : 0;
  };
  return {
    total: Number(totalMatch[1]),
    passed: num('passed'),
    failed: num('failed'),
    parser: 'vitest',
  };
};

/** mocha: "5 passing (12ms)" / "2 failing". */
const mocha: Parser = (text) => {
  const pass = /^\s*(\d+) passing/m.exec(text);
  const fail = /^\s*(\d+) failing/m.exec(text);
  if (!pass && !fail) return null;
  const passed = pass ? Number(pass[1]) : 0;
  const failed = fail ? Number(fail[1]) : 0;
  return { total: passed + failed, passed, failed, parser: 'mocha' };
};

// jest before vitest: jest's "Tests:" is the more specific pattern.
const PARSERS: Parser[] = [nodeTest, jest, vitest, mocha];

/**
 * @returns a structured report, or null when no known runner format was found.
 *          Null means UNKNOWN, never "zero tests" and never "passed" -- the
 *          caller must fall back to the spec pin rather than trusting it.
 */
export function parseTestReport(stdout: string, stderr = ''): TestReport | null {
  const text = stripAnsi(`${stdout}\n${stderr}`);
  for (const parse of PARSERS) {
    const report = parse(text);
    if (report) return report;
  }
  return null;
}
