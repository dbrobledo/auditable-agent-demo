/**
 * Executes model-requested tool calls against a guarded sandbox session.
 *
 * A refused write is reported back to the model as a tool RESULT, not raised as
 * an exception: the model should see "that file is pinned, fix the
 * implementation instead" and get another turn. The orchestrator separately
 * records the refusal, and repeated refusals fail the task -- a model that
 * keeps trying to edit the spec is not converging on a fix.
 */

import { WriteRefusedError } from '../sandbox/types.js';
import type { GuardedSession } from '../sandbox/guard.js';
import type { ToolCall } from '../llm/types.js';

export interface ToolExecution {
  call: ToolCall;
  ok: boolean;
  result: string;
  refused?: 'outside_workspace' | 'pinned_spec';
}

const str = (v: unknown): string => (typeof v === 'string' ? v : String(v ?? ''));

export async function executeToolCall(session: GuardedSession, call: ToolCall): Promise<ToolExecution> {
  const args = call.arguments ?? {};
  try {
    switch (call.name) {
      case 'write_file': {
        const filePath = str(args['filePath']);
        const content = str(args['content']);
        if (!filePath) return { call, ok: false, result: 'error: filePath is required' };
        await session.writeFile({ filePath, content });
        return { call, ok: true, result: `wrote ${filePath} (${content.length} bytes)` };
      }
      case 'read_file': {
        const filePath = str(args['filePath']);
        if (!filePath) return { call, ok: false, result: 'error: filePath is required' };
        return { call, ok: true, result: await session.readFile({ filePath }) };
      }
      case 'list_files': {
        const dirPath = str(args['dirPath']) || '.';
        const recursive = args['recursive'] === true || str(args['recursive']) === 'true';
        const files = await session.listFiles({ dirPath, recursive });
        return { call, ok: true, result: files.join('\n') || '(empty)' };
      }
      case 'execute_command': {
        const command = str(args['command']);
        if (!command) return { call, ok: false, result: 'error: command is required' };
        const raw = args['timeoutMs'];
        const timeoutMs = typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? raw : 120_000;
        const r = await session.executeCommand({
          command,
          timeoutMs,
          ...(args['cwd'] ? { cwd: str(args['cwd']) } : {}),
        });
        if (r.outcome !== 'completed') {
          return { call, ok: false, result: `command did not complete (${r.outcome}): ${r.error}` };
        }
        return {
          call,
          ok: r.exitCode === 0,
          result: `exit ${r.exitCode}\nSTDOUT:\n${r.stdout}\nSTDERR:\n${r.stderr}`,
        };
      }
      default:
        return { call, ok: false, result: `error: unknown tool "${call.name}"` };
    }
  } catch (e) {
    if (e instanceof WriteRefusedError) {
      const guidance = e.why === 'pinned_spec'
        ? 'That file is part of the pinned test spec and cannot be modified. ' +
          'Change the implementation so the existing tests pass.'
        : 'That path is outside the workspace. Use a path inside the workspace root.';
      return { call, ok: false, result: `REFUSED: ${e.message}. ${guidance}`, refused: e.why };
    }
    return { call, ok: false, result: `error: ${e instanceof Error ? e.message : String(e)}` };
  }
}
