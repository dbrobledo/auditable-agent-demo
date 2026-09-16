/**
 * LLM contracts.
 *
 * `generateAndExecuteTools` RETURNS the messages the turn produced. That return
 * is not cosmetic: without it the orchestrator can only ever append its own
 * user turns, and the transcript degenerates into consecutive user messages
 * with no assistant or tool-result turns in it. The model then re-reasons blind
 * on every retry, and the strict alternation most chat templates assume is
 * broken.
 */

export type Role = 'system' | 'user' | 'assistant' | 'tool';

export interface Message {
  role: Role;
  content: string;
  /** Populated on assistant turns that requested tools. */
  toolCalls?: ToolCall[];
  /** Populated on tool turns, matching the originating call. */
  toolCallId?: string;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface TurnResult {
  /** Messages to append to the transcript: the assistant turn and any tool results. */
  messages: Message[];
  /** Total tokens billed for this turn, when the provider reports them. */
  tokensUsed: number;
}

export interface LLMClient {
  readonly model: string;
  generateAndExecuteTools(context: readonly Message[]): Promise<TurnResult>;
}
