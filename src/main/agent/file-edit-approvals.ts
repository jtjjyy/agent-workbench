import { createHash, randomUUID } from 'node:crypto';
import { DEFAULT_CONVERSATION_ID, type EventPayloads } from '../../shared/contracts';
import { EDIT_APPROVAL_TTL_MS, MAX_EDIT_FILE_BYTES, MAX_EDIT_TEXT_LENGTH,
  type ApplyFileEdit, type ApprovalDecision, type ApprovalIdentity, type DecideFileEditRequest,
  type DecideFileEditResult, type EditOutcome, type FileEditProposal, type PendingFileEdit } from '../../shared/file-edit';

type ApprovalEvent = 'approval.requested' | 'approval.decided' | 'file.edit.started' | 'file.edit.completed';
type PublishApproval = <T extends ApprovalEvent>(type: T, payload: EventPayloads[T]) => Promise<void>;
interface PendingApproval {
  view: PendingFileEdit;
  signal: AbortSignal;
  consumed: boolean;
  published: boolean;
  resolve: (decision: ApprovalDecision) => void;
}

const hash = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
const uuid = (value: unknown): value is string => typeof value === 'string'
  && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);

function validProposal(proposal: FileEditProposal): boolean {
  return typeof proposal.path === 'string' && proposal.path.length > 0 && proposal.path.length <= 512
    && !proposal.path.startsWith('/') && !/[\\:\u0000-\u001f\u007f-\u009f<>"|?*]/u.test(proposal.path)
    && proposal.path.split('/').every((part) => part && part !== '.' && part !== '..' && !/[. ]$/u.test(part))
    && [proposal.beforeText, proposal.afterText].every((text) => typeof text === 'string'
      && text.length <= MAX_EDIT_TEXT_LENGTH && Buffer.byteLength(text, 'utf8') <= MAX_EDIT_FILE_BYTES)
    && proposal.beforeText !== proposal.afterText && hash(proposal.beforeText) === proposal.beforeSha256
    && hash(proposal.afterText) === proposal.afterSha256;
}

export class FileEditApprovals {
  private pending: PendingApproval | undefined;

  readPending(): PendingFileEdit | null {
    const pending = this.pending;
    if (!pending || pending.consumed || !pending.published || pending.signal.aborted) return null;
    if (Date.now() >= Date.parse(pending.view.expiresAt)) {
      this.settle(pending, 'expired');
      return null;
    }
    return { ...pending.view };
  }

  decide(request: DecideFileEditRequest): DecideFileEditResult {
    const pending = this.pending;
    if (!pending || pending.consumed || !pending.published || pending.signal.aborted
      || Date.now() >= Date.parse(pending.view.expiresAt)
      || request.conversationId !== DEFAULT_CONVERSATION_ID || request.runId !== pending.view.runId
      || request.approvalId !== pending.view.approvalId || request.bindingDigest !== pending.view.bindingDigest
      || (request.decision !== 'approved' && request.decision !== 'rejected')) {
      return { ok: false, code: 'APPROVAL_UNAVAILABLE' };
    }
    // 在第一个 await 之前消费审批，重复点击不能触发第二次写入。
    this.settle(pending, request.decision);
    return { ok: true };
  }

  private settle(pending: PendingApproval, decision: ApprovalDecision): void {
    if (pending.consumed) return;
    pending.consumed = true;
    pending.resolve(decision);
  }

  async request(context: { runId: string; toolCallId: string; workspaceRoot: string },
    proposal: FileEditProposal, apply: ApplyFileEdit, signal: AbortSignal,
    publish: PublishApproval): Promise<EditOutcome> {
    signal.throwIfAborted();
    if (this.pending || !uuid(context.runId) || !uuid(context.toolCallId) || !validProposal(proposal)) {
      throw new Error('文件修改提案不符合审批协议。');
    }
    const approvalId = randomUUID();
    const identity: ApprovalIdentity = {
      runId: context.runId, toolCallId: context.toolCallId, approvalId,
      path: proposal.path, beforeSha256: proposal.beforeSha256, afterSha256: proposal.afterSha256,
      bindingDigest: hash(JSON.stringify({ operation: 'replace_text', ...context, approvalId,
        path: proposal.path, beforeSha256: proposal.beforeSha256, afterSha256: proposal.afterSha256 })),
    };
    const expiresAt = new Date(Date.now() + EDIT_APPROVAL_TTL_MS).toISOString();
    let resolve!: (decision: ApprovalDecision) => void;
    const decisionPromise = new Promise<ApprovalDecision>((yes) => { resolve = yes; });
    const pending: PendingApproval = { view: { ...proposal, ...identity, expiresAt },
      signal, consumed: false, published: false, resolve };
    this.pending = pending;
    const onAbort = () => this.settle(pending, 'cancelled');
    signal.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => this.settle(pending, 'expired'), EDIT_APPROVAL_TTL_MS);
    try {
      await publish('approval.requested', { ...identity, expiresAt });
      pending.published = true;
      if (signal.aborted) onAbort();
      let decision = await decisionPromise;
      if (decision === 'approved' && signal.aborted) decision = 'cancelled';
      await publish('approval.decided', { ...identity, decision });
      if (decision !== 'approved') {
        return { status: decision, summary: decision === 'rejected' ? '用户拒绝修改，未写入文件。'
          : decision === 'expired' ? '审批已到期，未写入文件。' : '审批已取消，未写入文件。' };
      }
      if (signal.aborted) return { status: 'cancelled', summary: '任务已取消，未开始写入文件。' };
      await publish('file.edit.started', identity);
      let outcome: EditOutcome;
      if (signal.aborted) outcome = { status: 'cancelled', summary: '任务已取消，未开始写入文件。' };
      else {
        try { outcome = await apply(signal); }
        catch { outcome = { status: 'unknown', summary: '文件修改结果未确认，请人工检查文件。' }; }
      }
      // 写入后的取消不能抹掉实际结果；日志失败也不能当作已回滚。
      await publish('file.edit.completed', { ...identity, status: outcome.status });
      return outcome;
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      if (this.pending === pending) this.pending = undefined;
    }
  }
}
