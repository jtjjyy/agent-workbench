import { spawn } from 'node:child_process';
import { isAbsolute, relative, resolve } from 'node:path';
import { MAX_COMMAND_OUTPUT_LENGTH, MAX_COMMAND_TIMEOUT_MS, type CommandOutcomeStatus } from '../../shared/command';

export interface CommandExecutionResult {
  status: CommandOutcomeStatus;
  exitCode: number | null;
  output: string;
  summary: string;
}

function insideWorkspace(root: string, cwd: string): boolean {
  const child = relative(resolve(root), resolve(cwd));
  return child === '' || (!child.startsWith('..') && !isAbsolute(child));
}

export async function executePowerShell(command: string, workspaceRoot: string, timeoutMs: number,
  signal: AbortSignal): Promise<CommandExecutionResult> {
  const cwd = resolve(workspaceRoot);
  if (!insideWorkspace(workspaceRoot, cwd)) throw new Error('命令工作目录超出授权工作区');
  const boundedTimeout = Math.min(MAX_COMMAND_TIMEOUT_MS, Math.max(1_000, timeoutMs));
  signal.throwIfAborted();
  return new Promise((resolveResult, reject) => {
    const child = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command], {
      cwd,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { SystemRoot: process.env.SystemRoot ?? 'C:\\Windows', TEMP: process.env.TEMP ?? '', TMP: process.env.TMP ?? '', Path: process.env.Path ?? '' },
    });
    let output = '';
    let timedOut = false;
    let settled = false;
    const append = (chunk: Buffer) => {
      if (output.length >= MAX_COMMAND_OUTPUT_LENGTH) return;
      output += chunk.toString('utf8').slice(0, MAX_COMMAND_OUTPUT_LENGTH - output.length);
    };
    const stop = (status: 'cancelled' | 'timed_out') => {
      if (settled) return;
      if (status === 'timed_out') timedOut = true;
      child.kill();
    };
    const onAbort = () => stop('cancelled');
    const timer = setTimeout(() => stop('timed_out'), boundedTimeout);
    signal.addEventListener('abort', onAbort, { once: true });
    child.stdout.on('data', append);
    child.stderr.on('data', append);
    child.once('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      reject(error);
    });
    child.once('close', (exitCode) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      const status: CommandOutcomeStatus = timedOut ? 'timed_out' : signal.aborted ? 'cancelled'
        : exitCode === 0 ? 'completed' : 'failed';
      resolveResult({ status, exitCode, output, summary: status === 'completed'
        ? `PowerShell 命令已完成，退出码 ${exitCode ?? 0}`
        : status === 'timed_out' ? 'PowerShell 命令超时，结果可能未确认'
          : status === 'cancelled' ? 'PowerShell 命令已取消，结果可能未确认'
            : `PowerShell 命令失败，退出码 ${exitCode ?? '未知'}` });
    });
  });
}
