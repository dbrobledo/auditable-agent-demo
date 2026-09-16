// tdd-loop.ts — VERBATIM from the design document under validation.
import { SandboxService } from './sandbox-interfaces';
import { LLMClient } from './llm-client'; // Abstraction for Qwen/Ollama

export class TDDOrchestrator {
  constructor(
    private sandbox: SandboxService,
    private llm: LLMClient
  ) {}

  async executeTDDTask(taskDescription: string, maxRetries = 3): Promise<boolean> {
    console.log(`Starting TDD Loop for task: ${taskDescription}`);

    // Step 1: LLM generates the initial test suite and empty implementation
    let conversationContext = [
      { role: "system", content: "You are an expert TDD developer." },
      { role: "user", content: `Write tests and implementation for: ${taskDescription}. Use tools to write files to the sandbox.` }
    ];

    await this.llm.generateAndExecuteTools(conversationContext);

    // Step 2: The iterative verification loop
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      console.log(`\n--- Verification Attempt ${attempt} ---`);

      const testResult = await this.sandbox.executeCommand({
        command: "npm run test"
      });

      if (testResult.exitCode === 0) {
        console.log("✅ Tests passed successfully!");
        return true;
      }

      console.log("❌ Tests failed. Feeding trace back to LLM...");

      // Step 3: Inject failure trace into context and prompt for a fix
      const failureTrace = `The test run failed with exit code ${testResult.exitCode}.\n\nSTDOUT:\n${testResult.stdout}\n\nSTDERR:\n${testResult.stderr}\n\nPlease fix the implementation code to pass the tests. Use the write_file tool to update the code.`;

      conversationContext.push({ role: "user", content: failureTrace });

      // The LLM processes the error and uses the write_file tool to apply fixes
      await this.llm.generateAndExecuteTools(conversationContext);
    }

    console.error("🚨 Maximum retries reached. TDD loop failed.");
    return false;
  }
}
