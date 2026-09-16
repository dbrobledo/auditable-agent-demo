// A scripted stand-in for the Qwen/Ollama LLMClient.
//
// Each "turn" is a function that receives the exact conversation context the
// orchestrator handed over, plus the sandbox, and performs tool calls -- the
// same thing a real model does after emitting tool_use blocks. Turns are
// consumed in order, one per generateAndExecuteTools() call.
//
// Every context the orchestrator passes is deep-copied at call time, so probes
// can inspect the message sequence the model would actually have been served.

import type { LLMClient } from '../src/llm-client.js';
import type { LocalSandbox } from './local-sandbox.js';

export interface Message { role: string; content: string }
export type Turn = (ctx: Message[], sandbox: LocalSandbox, turnIndex: number) => Promise<void> | void;

export class ScriptedLLM implements LLMClient {
  /** Deep snapshot of the context handed to each generateAndExecuteTools call. */
  readonly seenContexts: Message[][] = [];
  turnsTaken = 0;

  constructor(
    private sandbox: LocalSandbox,
    private turns: Turn[],
    /** Turn used once `turns` is exhausted. Default: no-op (model gives up). */
    private fallback: Turn = () => {},
  ) {}

  async generateAndExecuteTools(context: unknown): Promise<Message[]> {
    const ctx = context as Message[];
    this.seenContexts.push(JSON.parse(JSON.stringify(ctx)) as Message[]);
    const turn = this.turns[this.turnsTaken] ?? this.fallback;
    const index = this.turnsTaken;
    this.turnsTaken += 1;
    const before = this.sandbox.calls.length;
    await turn(ctx, this.sandbox, index);
    const toolCalls = this.sandbox.calls.slice(before);
    // What a real client returns after a turn: the assistant reply plus the
    // results of the tool calls it made. The document's orchestrator discards
    // this; the hardened one appends it.
    return [
      { role: 'assistant', content: `[turn ${index}] issued ${toolCalls.length} tool call(s)` },
      { role: 'tool', content: toolCalls.map(c => `${c.method} ok`).join('\n') || 'no tool calls' },
    ];
  }
}

/** Serialized byte size of a conversation context, as sent on the wire. */
export function contextBytes(ctx: Message[]): number {
  return Buffer.byteLength(JSON.stringify(ctx), 'utf8');
}

/** Rough token estimate: ~4 chars/token is the standard English/code heuristic. */
export function approxTokens(ctx: Message[]): number {
  return Math.round(contextBytes(ctx) / 4);
}

/** Longest run of consecutive same-role messages in a context. */
export function longestSameRoleRun(ctx: Message[], role: string): number {
  let best = 0;
  let run = 0;
  for (const m of ctx) {
    run = m.role === role ? run + 1 : 0;
    if (run > best) best = run;
  }
  return best;
}
