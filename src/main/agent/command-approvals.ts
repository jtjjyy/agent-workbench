import { createHash, randomUUID } from 'node:crypto';
import type { CommandApprovalIdentity, CommandApprovalDecision, CommandApprovalResult, PendingCommandApproval } from '../../shared/command';
import type { CommandExecutionResult } from '../tools/command-executor';
import type { EventPayloads } from '../../shared/contracts';

type ApprovalEvent = 'command.approval.requested' | 'command.approval.decided';
export type CommandApprovalPublisher = (type: ApprovalEvent, payload: EventPayloads[ApprovalEvent]) => Promise<void>;
type Pending = { view: PendingCommandApproval; resolve: (decision: CommandApprovalDecision) => void };

function uuid(value: string): boolean { return /^[a-f0-9-]{36}$/i.test(value); }
function digest(value: string): string { return createHash('sha256').update(value).digest('hex'); }

export class CommandApprovals {
  private pending: Pending | undefined;

  readPending(): PendingCommandApproval | null { return this.pending?.view ?? null; }

  decide(request: { runId: string; approvalId: string; bindingDigest: string; decision: 'approved' | 'rejected' }): CommandApprovalResult {
    const current = this.pending;
    if (!current || current.view.runId !== request.runId || current.view.approvalId !== request.approvalId
      || current.view.bindingDigest !== request.bindingDigest || Date.parse(current.view.expiresAt) <= Date.now()) {
      return { ok: false, code: 'APPROVAL_UNAVAILABLE' };
    }
    current.resolve(request.decision);
    return { ok: true };
  }

  async request(context: { runId: string; toolCallId: string; workspaceRoot: string; operation?: string;
    bindingInput?: string; preview?: string }, command: string,
    timeoutMs: number, signal: AbortSignal, publish: CommandApprovalPublisher,
    execute: (signal: AbortSignal) => Promise<CommandExecutionResult>): Promise<CommandExecutionResult> {
    signal.throwIfAborted();
    if (!uuid(context.runId) || !context.toolCallId.trim() || context.toolCallId.length > 256 || /[\u0000-\u001f]/u.test(context.toolCallId) || !command.trim()) throw new Error('命令审批参数无效');
    if (this.pending) throw new Error('已有命令等待审批');
    const approvalId = randomUUID();
    const identity: CommandApprovalIdentity = {
      runId: context.runId, toolCallId: context.toolCallId, approvalId, command, cwd: context.workspaceRoot,
      bindingDigest: digest(JSON.stringify({ ...context, operation: context.operation ?? 'run_powershell',
        bindingInput: context.bindingInput ?? command, approvalId, command, timeoutMs })),
    };
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    const view: PendingCommandApproval = { ...identity, timeoutMs, expiresAt, preview: context.preview,
      risk: /\b(Remove-Item|del|erase|rmdir|Stop-Process|Set-ExecutionPolicy|git\s+push|npm\s+install|Invoke-WebRequest)\b/i.test(command)
        ? 'mutation' : /\b(Invoke-WebRequest|curl|wget|git\s+clone)\b/i.test(command) ? 'network' : 'workspace' };
    let resolve!: (decision: CommandApprovalDecision) => void;
    const decisionPromise = new Promise<CommandApprovalDecision>((yes) => { resolve = yes; });
    const pending: Pending = { view, resolve };
    this.pending = pending;
    const onAbort = () => resolve('cancelled');
    signal.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => resolve('expired'), 60_000);
    try {
      await publish('command.approval.requested', { ...identity, expiresAt });
      let decision = await decisionPromise;
      if (decision === 'approved' && signal.aborted) decision = 'cancelled';
      await publish('command.approval.decided', { ...identity, decision });
      if (decision !== 'approved') return { status: decision === 'expired' ? 'timed_out' : decision === 'cancelled' ? 'cancelled' : 'failed', exitCode: null,
        output: '', summary: decision === 'rejected' ? '用户拒绝执行命令' : decision === 'expired' ? '命令审批已过期' : '命令审批已取消' };
      if (signal.aborted) return { status: 'cancelled', exitCode: null, output: '', summary: '任务已取消，命令未开始执行' };
      return await execute(signal);
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      if (this.pending === pending) this.pending = undefined;
    }
  }
}
