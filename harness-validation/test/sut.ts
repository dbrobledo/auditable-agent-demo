// The two systems under test, behind one interface, so every probe scenario
// runs byte-identically against both. Without the hardened control group the
// probe suite would only prove that assertions can be written to fail.

import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { TDDOrchestrator } from '../src/tdd-loop.js';
import { E2B_TOOLS } from '../src/mcp-tools.js';
import { HardenedTDDOrchestrator } from '../src/hardened/tdd-loop.js';
import { E2B_TOOLS_HARDENED } from '../src/hardened/mcp-tools.js';
import { HardenedLocalSandbox } from './hardened-adapter.js';
import type { LocalSandbox } from './local-sandbox.js';
import type { ScriptedLLM } from './scripted-llm.js';

export interface SUT {
  label: string;
  /** Resolves to the pass/fail verdict the harness reports to its caller. */
  run(sb: LocalSandbox, llm: ScriptedLLM, task: string, maxAttempts: number): Promise<boolean>;
  /** Why it said no, when it says no (the document's version cannot say). */
  lastReason(): string | null;
  interfaceSource: URL;
  tools: Tool[];
}

export function documentSUT(): SUT {
  return {
    label: 'DOCUMENT (as written)',
    async run(sb, llm, task, maxAttempts) {
      return await new TDDOrchestrator(sb, llm as never).executeTDDTask(task, maxAttempts);
    },
    lastReason: () => null,
    interfaceSource: new URL('../src/sandbox-interfaces.ts', import.meta.url),
    tools: E2B_TOOLS,
  };
}

export function hardenedSUT(): SUT {
  let reason: string | null = null;
  return {
    label: 'HARDENED (control)',
    async run(sb, llm, task, maxAttempts) {
      const res = await new HardenedTDDOrchestrator(new HardenedLocalSandbox(sb), llm as never)
        .executeTDDTask(task, {
          maxVerifications: maxAttempts,
          testTimeoutMs: 2_000,                     // probe 11 uses a 3s hang
          listTestsCommand: `find . -name '*.test.*' -o -name '*.spec.*'`,
        });
      reason = res.reason ?? null;
      return res.passed;
    },
    lastReason: () => reason,
    interfaceSource: new URL('../src/hardened/sandbox-interfaces.ts', import.meta.url),
    tools: E2B_TOOLS_HARDENED,
  };
}
