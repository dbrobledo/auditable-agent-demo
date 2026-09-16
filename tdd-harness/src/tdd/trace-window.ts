/**
 * Bounds a failure trace before it enters the model's context.
 *
 * A stack-heavy jest/vitest failure runs to tens of kilobytes. Appended
 * verbatim on every attempt, it overflows a 32k window (Qwen2.5-Coder's native
 * size) within two or three retries -- and the overflow arrives as a serving
 * error, not as a condition the loop can handle.
 *
 * The signal sits at the two ends: the assertion and the failing frame at the
 * top, the summary at the bottom. The middle is nearly always framework
 * internals. So: drop node_modules frames, then window head and tail.
 */

export interface WindowOptions {
  maxChars?: number;
  /** Drop stack frames pointing inside node_modules before windowing. */
  dropVendorFrames?: boolean;
}

const VENDOR_FRAME = /^\s*at\s.*[/\\]node_modules[/\\]/;

export function windowTrace(text: string, options: WindowOptions = {}): string {
  const maxChars = options.maxChars ?? 6_000;
  const dropVendor = options.dropVendorFrames ?? true;
  if (maxChars <= 0) return '';

  let working = text;

  if (dropVendor) {
    const kept: string[] = [];
    let dropped = 0;
    const flush = () => {
      if (dropped > 0) { kept.push(`    ... ${dropped} node_modules frame(s) elided`); dropped = 0; }
    };
    for (const line of working.split('\n')) {
      if (VENDOR_FRAME.test(line)) { dropped++; continue; }
      flush();
      kept.push(line);
    }
    flush();
    working = kept.join('\n');
  }

  if (working.length <= maxChars) return working;

  const marker = (n: number) => `\n\n... [${n} characters of trace elided] ...\n\n`;
  const budget = maxChars - marker(working.length).length;
  if (budget <= 0) return working.slice(0, maxChars);

  const head = Math.ceil(budget * 0.6);   // the assertion is at the top
  const tail = budget - head;             // the summary is at the bottom
  const elided = working.length - head - tail;
  return working.slice(0, head) + marker(elided) + working.slice(working.length - tail);
}

/**
 * Collapses a trace identical to the previous attempt's. Re-sending the same
 * 20k of text teaches the model nothing and costs the window twice.
 */
export function dedupeTrace(current: string, previous: string | null): string {
  return previous !== null && current === previous
    ? "(identical to the previous attempt's output, elided)"
    : current;
}
