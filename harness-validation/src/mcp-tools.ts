// mcp-tools.ts — VERBATIM from the design document under validation.
// NOTE: the doc imports { Tool } from '@modelcontextprotocol/sdk/types.js'.
// Left as-is; the real package is installed so the import resolves.
import { Tool } from '@modelcontextprotocol/sdk/types.js';

export const E2B_TOOLS: Tool[] = [
  {
    name: "write_file",
    description: "Write code or configuration to a specific path in the execution sandbox.",
    inputSchema: {
      type: "object",
      properties: {
        filePath: { type: "string", description: "Absolute or relative path." },
        content: { type: "string", description: "Complete file content to write." }
      },
      required: ["filePath", "content"]
    }
  },
  {
    name: "read_file",
    description: "Read the contents of a specific file from the execution sandbox.",
    inputSchema: {
      type: "object",
      properties: {
        filePath: { type: "string", description: "Path of the file to read." }
      },
      required: ["filePath"]
    }
  },
  {
    name: "execute_command",
    description: "Execute a shell command inside the sandbox (e.g., 'npm run test').",
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string", description: "The shell command to execute." },
        cwd: { type: "string", description: "Working directory. Defaults to '/home/user'." }
      },
      required: ["command"]
    }
  }
];
