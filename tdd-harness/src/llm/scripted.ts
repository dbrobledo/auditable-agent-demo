/**
 * A deterministic LLMClient driven by a script of tool calls.
 *
 * Its tool calls go through the same executor and the same guard as a live
 * model's, so tests exercise the real enforcement path rather than a mock of
 * it. Used by the regression suite to replay the exact behaviours -- writing no
 * tests, editing the spec, timing out -- that a harness must refuse.
 */

import { executeToolCall } from '../mcp/executor.js';
import type { GuardedSession } from '../sandbox/guard.js';
import type { LLMClient, Message, ToolCall, TurnResult } from './types.js';

export interface ScriptedTurn {
  /** Assistant prose for this turn. */
  say?: string;
  /** Tool calls to issue, in order. */
  calls?: Omit<ToolCall, 'id'>[];
  /** Throw instead of responding, to simulate a transport failure. */
  throws?: string;
}

export class ScriptedClient implements LLMClient {
  readonly model = 'scripted';
  /** Deep snapshot of the context handed to each turn, for assertions. */
  readonly seenContexts: Message[][] = [];
  turnsTaken = 0;

  constructor(
    private readonly session: GuardedSession,
    private readonly turns: ScriptedTurn[],
    /** Used once the script is exhausted. Default: the model gives up quietly. */
    private readonly fallback: ScriptedTurn = { say: 'I have no further changes to make.' },
  ) {}

  async generateAndExecuteTools(context: readonly Message[]): Promise<TurnResult> {
    this.seenContexts.push(JSON.parse(JSON.stringify(context)) as Message[]);
    const turn = this.turns[this.turnsTaken] ?? this.fallback;
    const index = this.turnsTaken;
    this.turnsTaken += 1;

    if (turn.throws) throw new Error(turn.throws);

    const toolCalls: ToolCall[] = (turn.calls ?? []).map((c, i) => ({ ...c, id: `scripted_${index}_${i}` }));
    const produced: Message[] = [{
      role: 'assistant',
      content: turn.say ?? '',
      ...(toolCalls.length ? { toolCalls } : {}),
    }];

    for (const call of toolCalls) {
      const execution = await executeToolCall(this.session, call);
      produced.push({ role: 'tool', content: execution.result, toolCallId: call.id });
    }

    // A crude but honest token estimate: 4 chars per token.
    const tokensUsed = Math.round(
      [...context, ...produced].reduce((n, m) => n + m.content.length, 0) / 4,
    );
    return { messages: produced, tokensUsed };
  }
}
