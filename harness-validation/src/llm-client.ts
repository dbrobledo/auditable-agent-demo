// llm-client.ts — NOT PROVIDED IN THE DESIGN DOC.
// tdd-loop.ts imports { LLMClient } from './llm-client' but no definition exists.
// Minimal stub inferred from the single call site so the document's code can compile.

export interface LLMClient {
  generateAndExecuteTools(context: unknown): Promise<unknown>;
}
