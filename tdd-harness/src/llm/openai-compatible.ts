/**
 * Client for any OpenAI-compatible chat-completions endpoint.
 *
 * Covers Ollama (http://localhost:11434/v1) and vLLM (http://localhost:8000/v1),
 * which is how Qwen2.5-Coder is typically served locally. No SDK dependency:
 * this is one fetch call and a tool-call loop.
 */

import { executeToolCall } from '../mcp/executor.js';
import { toOpenAITools, type ToolSchema } from '../mcp/tools.js';
import type { GuardedSession } from '../sandbox/guard.js';
import type { LLMClient, Message, ToolCall, TurnResult } from './types.js';

export interface OpenAICompatibleOptions {
  baseUrl?: string;
  model?: string;
  apiKey?: string;
  temperature?: number;
  /** Tool-call rounds permitted inside a single turn before it is cut off. */
  maxToolRounds?: number;
  requestTimeoutMs?: number;
  tools?: ToolSchema[];
}

interface ChatChoice {
  message?: {
    content?: string | null;
    tool_calls?: { id?: string; function?: { name?: string; arguments?: string } }[];
  };
}
interface ChatResponse { choices?: ChatChoice[]; usage?: { total_tokens?: number } }

const wire = (m: Message): Record<string, unknown> => {
  if (m.role === 'tool') {
    return { role: 'tool', content: m.content, tool_call_id: m.toolCallId ?? 'unknown' };
  }
  if (m.role === 'assistant' && m.toolCalls?.length) {
    return {
      role: 'assistant',
      content: m.content || null,
      tool_calls: m.toolCalls.map((c) => ({
        id: c.id, type: 'function',
        function: { name: c.name, arguments: JSON.stringify(c.arguments) },
      })),
    };
  }
  return { role: m.role, content: m.content };
};

export class OpenAICompatibleClient implements LLMClient {
  readonly model: string;
  private readonly baseUrl: string;

  constructor(private readonly session: GuardedSession, private readonly options: OpenAICompatibleOptions = {}) {
    this.model = options.model ?? process.env['HARNESS_MODEL'] ?? 'qwen2.5-coder:7b';
    this.baseUrl = (options.baseUrl ?? process.env['HARNESS_BASE_URL'] ?? 'http://localhost:11434/v1')
      .replace(/\/+$/, '');
  }

  private async post(messages: Record<string, unknown>[]): Promise<ChatResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.requestTimeoutMs ?? 180_000);
    try {
      const res = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'content-type': 'application/json',
          ...(this.options.apiKey ? { authorization: `Bearer ${this.options.apiKey}` } : {}),
        },
        body: JSON.stringify({
          model: this.model,
          messages,
          tools: toOpenAITools(this.options.tools),
          temperature: this.options.temperature ?? 0.1,
        }),
      });
      if (!res.ok) {
        throw new Error(`${this.baseUrl} returned ${res.status}: ${(await res.text()).slice(0, 500)}`);
      }
      return (await res.json()) as ChatResponse;
    } finally {
      clearTimeout(timer);
    }
  }

  async generateAndExecuteTools(context: readonly Message[]): Promise<TurnResult> {
    const maxRounds = this.options.maxToolRounds ?? 8;
    const produced: Message[] = [];
    let tokensUsed = 0;

    for (let round = 0; round < maxRounds; round++) {
      const wireMessages = [...context, ...produced].map(wire);
      const response = await this.post(wireMessages);
      tokensUsed += response.usage?.total_tokens ?? 0;

      const choice = response.choices?.[0]?.message;
      const rawCalls = choice?.tool_calls ?? [];
      const toolCalls: ToolCall[] = rawCalls.map((c, i) => {
        let parsed: Record<string, unknown> = {};
        try { parsed = JSON.parse(c.function?.arguments || '{}') as Record<string, unknown>; }
        catch { parsed = { __unparseable: c.function?.arguments ?? '' }; }
        return { id: c.id ?? `call_${round}_${i}`, name: c.function?.name ?? 'unknown', arguments: parsed };
      });

      produced.push({
        role: 'assistant',
        content: choice?.content ?? '',
        ...(toolCalls.length ? { toolCalls } : {}),
      });

      if (toolCalls.length === 0) return { messages: produced, tokensUsed };

      for (const call of toolCalls) {
        const execution = await executeToolCall(this.session, call);
        produced.push({ role: 'tool', content: execution.result, toolCallId: call.id });
      }
    }

    produced.push({
      role: 'user',
      content: `You have used all ${maxRounds} tool rounds for this turn. Stop calling tools and summarise what you changed.`,
    });
    return { messages: produced, tokensUsed };
  }
}
