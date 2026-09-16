export interface Message { role: 'system' | 'user' | 'assistant' | 'tool'; content: string }

export interface LLMClient {
  /**
   * Runs one model turn and executes any tool calls it emits.
   * Returns the messages produced by that turn (the assistant reply and any
   * tool results) so the orchestrator can append them to the transcript.
   * The document's version returned nothing, which is why its transcript
   * degenerated into consecutive user turns.
   */
  generateAndExecuteTools(context: Message[]): Promise<Message[]>;
}
