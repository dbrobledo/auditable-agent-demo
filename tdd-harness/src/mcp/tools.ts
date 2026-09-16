/**
 * MCP tool definitions exposed to the model.
 *
 * Schemas are kept in lockstep with the TypeScript params they mirror -- a
 * field present in the type but absent from the schema is a capability the
 * model cannot reach, and `execute_command`'s timeout is exactly that field.
 *
 * The descriptions state the write rules, but the rules are ENFORCED in
 * `sandbox/guard.ts`. A description is documentation; the guard is the control.
 */

export interface ToolSchema {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
    required: string[];
    additionalProperties: false;
  };
}

const PATH_RULE =
  'Path relative to the workspace root. Traversal outside the workspace is ' +
  'rejected by the sandbox. Test files pinned at task start are read-only.';

export const HARNESS_TOOLS: ToolSchema[] = [
  {
    name: 'write_file',
    description:
      'Write code or configuration to a path in the execution sandbox. ' +
      'Test files pinned at task start are immutable: writing to one is refused ' +
      'and fails the task.',
    inputSchema: {
      type: 'object',
      properties: {
        filePath: { type: 'string', description: PATH_RULE },
        content: { type: 'string', description: 'Complete file content to write.' },
      },
      required: ['filePath', 'content'],
      additionalProperties: false,
    },
  },
  {
    name: 'read_file',
    description: 'Read the contents of a specific file from the execution sandbox.',
    inputSchema: {
      type: 'object',
      properties: { filePath: { type: 'string', description: PATH_RULE } },
      required: ['filePath'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_files',
    description: 'List files in a workspace directory, so paths need not be guessed.',
    inputSchema: {
      type: 'object',
      properties: {
        dirPath: { type: 'string', description: PATH_RULE },
        recursive: { type: 'string', description: 'Pass "true" to recurse. Defaults to false.' },
      },
      required: ['dirPath'],
      additionalProperties: false,
    },
  },
  {
    name: 'execute_command',
    description:
      'Execute a shell command inside the sandbox (e.g. "npm install"). ' +
      'The harness runs the test command itself; you do not need to.',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The shell command to execute.' },
        cwd: { type: 'string', description: 'Working directory. Defaults to the workspace root.' },
        timeoutMs: {
          type: 'number',
          description: 'Hard kill deadline in milliseconds. Defaults to 120000; the sandbox caps it.',
        },
      },
      required: ['command'],
      additionalProperties: false,
    },
  },
];

/** OpenAI / Ollama / vLLM function-calling shape. */
export const toOpenAITools = (tools: ToolSchema[] = HARNESS_TOOLS) =>
  tools.map((t) => ({
    type: 'function' as const,
    function: { name: t.name, description: t.description, parameters: t.inputSchema },
  }));
