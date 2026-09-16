/**
 * Append-only decision log.
 *
 * One JSONL line per decision: {ts, actor, event, input_hash, decision, basis}.
 * input_hash is the SHA-256 of the exact record the decision was made on, so
 * any line can be re-verified against its input after the fact.
 *
 * This is the difference between "the agent said the tests passed" and a claim
 * that can be checked. Every gate in the orchestrator writes here before it
 * acts, including the gates that fail.
 */

import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';

export type Actor = 'orchestrator' | 'model' | 'sandbox' | 'human';

export interface DecisionRecord {
  ts: string;
  run_id: string;
  actor: Actor;
  event: string;
  input_hash: string;
  decision: string;
  basis: string;
}

export const sha256 = (input: string): string =>
  createHash('sha256').update(input, 'utf8').digest('hex');

export class DecisionLog {
  private readonly entries: DecisionRecord[] = [];

  constructor(readonly runId: string, readonly path: string | null) {
    if (path) mkdirSync(dirname(path), { recursive: true });
  }

  /**
   * @param input the exact material the decision was made on; its SHA-256 is
   *              recorded so the decision can be re-verified later.
   */
  record(actor: Actor, event: string, decision: string, basis: string, input = ''): DecisionRecord {
    const entry: DecisionRecord = {
      ts: new Date().toISOString(),
      run_id: this.runId,
      actor,
      event,
      input_hash: sha256(input),
      decision,
      basis,
    };
    this.entries.push(entry);
    // Written immediately, never buffered: a crash must not erase the reason.
    if (this.path) appendFileSync(this.path, JSON.stringify(entry) + '\n', 'utf8');
    return entry;
  }

  all(): readonly DecisionRecord[] {
    return this.entries;
  }

  /** Re-read the log from disk and confirm it is well-formed and complete. */
  static verify(path: string): { ok: boolean; lines: number; error?: string } {
    if (!existsSync(path)) return { ok: false, lines: 0, error: 'log does not exist' };
    const raw = readFileSync(path, 'utf8').split('\n').filter(Boolean);
    for (const [i, line] of raw.entries()) {
      try {
        const parsed = JSON.parse(line) as Partial<DecisionRecord>;
        for (const k of ['ts', 'run_id', 'actor', 'event', 'input_hash', 'decision', 'basis'] as const) {
          if (typeof parsed[k] !== 'string') {
            return { ok: false, lines: raw.length, error: `line ${i + 1}: missing field "${k}"` };
          }
        }
        if (!/^[0-9a-f]{64}$/.test(parsed.input_hash as string)) {
          return { ok: false, lines: raw.length, error: `line ${i + 1}: malformed input_hash` };
        }
      } catch {
        return { ok: false, lines: raw.length, error: `line ${i + 1}: not valid JSON` };
      }
    }
    return { ok: true, lines: raw.length };
  }
}
