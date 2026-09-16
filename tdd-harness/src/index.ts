/** Public API. */

export { TDDOrchestrator, type OrchestratorOptions } from './tdd/orchestrator.js';
export { parseTestReport } from './tdd/test-report.js';
export { windowTrace, dedupeTrace, type WindowOptions } from './tdd/trace-window.js';

export { DecisionLog, sha256, type DecisionRecord, type Actor } from './audit/decision-log.js';

export { LocalProcessSandbox, type LocalProcessOptions } from './sandbox/local-process.js';
export { E2BSandboxService, type E2BOptions } from './sandbox/e2b.js';
export { GuardedSession, resolveInWorkspace, type GuardOptions } from './sandbox/guard.js';
export {
  WriteRefusedError,
  type SandboxService, type SandboxSession, type SandboxExecutionResult,
  type ExecuteCommandParams, type WriteFileParams, type ReadFileParams, type ListFilesParams,
} from './sandbox/types.js';

export { OpenAICompatibleClient, type OpenAICompatibleOptions } from './llm/openai-compatible.js';
export { ScriptedClient, type ScriptedTurn } from './llm/scripted.js';
export type { LLMClient, Message, Role, ToolCall, TurnResult } from './llm/types.js';

export { HARNESS_TOOLS, toOpenAITools, type ToolSchema } from './mcp/tools.js';
export { executeToolCall, type ToolExecution } from './mcp/executor.js';

export { HarnessError, type TaskOutcome, type TestReport, type FailureReason } from './types.js';
