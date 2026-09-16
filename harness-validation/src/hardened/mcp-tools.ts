// Hardened MCP tool schemas. Differences from the design document:
//   - execute_command exposes timeoutMs (the document's type had it, the schema did not)
//   - filePath descriptions state the sandbox-enforced allowlist instead of
//     inviting "Absolute or relative path"
//   - list_files added: the model could not previously discover the tree it edits
import { Tool } from '@modelcontextprotocol/sdk/types.js';

const WORKSPACE_RULE =
  "Path relative to the workspace root (/home/user/workspace). Traversal outside " +
  "the workspace is rejected. Paths matching the pinned test files are read-only.";

export const E2B_TOOLS_HARDENED: Tool[] = [
  {
    name: "write_file",
    description: "Write code or configuration to a path in the execution sandbox. Test files pinned at task start are immutable; writing to one fails the task.",
    inputSchema: {
      type: "object",
      properties: {
        filePath: { type: "string", description: WORKSPACE_RULE },
        content: { type: "string", description: "Complete file content to write." }
      },
      required: ["filePath", "content"],
      additionalProperties: false
    }
  },
  {
    name: "read_file",
    description: "Read the contents of a specific file from the execution sandbox.",
    inputSchema: {
      type: "object",
      properties: { filePath: { type: "string", description: WORKSPACE_RULE } },
      required: ["filePath"],
      additionalProperties: false
    }
  },
  {
    name: "list_files",
    description: "List files in a workspace directory so paths need not be guessed.",
    inputSchema: {
      type: "object",
      properties: {
        dirPath: { type: "string", description: WORKSPACE_RULE },
        recursive: { type: "boolean", description: "Recurse into subdirectories. Defaults to false." }
      },
      required: ["dirPath"],
      additionalProperties: false
    }
  },
  {
    name: "execute_command",
    description: "Execute a shell command inside the sandbox (e.g., 'npm run test').",
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string", description: "The shell command to execute." },
        cwd: { type: "string", description: "Working directory. Defaults to the workspace root." },
        timeoutMs: { type: "number", description: "Hard kill deadline in milliseconds. Defaults to 120000; the sandbox caps it at 600000." }
      },
      required: ["command"],
      additionalProperties: false
    }
  }
];
