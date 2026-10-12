import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { FileEditApprovals } from '../../src/main/agent/file-edit-approvals';
import { DEFAULT_CONVERSATION_ID, type EventPayloads } from '../../src/shared/contracts';
import type { FileEditProposal, PendingFileEdit } from '../../src/shared/file-edit';

// 用户暂停验证：这些用例仅编写，尚未执行。
const digest = (text: string) => createHash('sha256').update(text).digest('hex');
const proposal: FileEditProposal = { path: 'src/example.ts', beforeText: 'const value = 1;\n',
  afterText: 'const value = 2;\n', beforeSha256: digest('const value = 1;\n'), afterSha256: digest('const value = 2;\n') };
const context = { runId: '11111111-1111-4111-8111-111111111111',
  toolCallId: '22222222-2222-4222-8222-222222222222', workspaceRoot: 'D:\\example-project' };
type ApprovalEvent = 'approval.requested' | 'approval.decided' | 'file.edit.started' | 'file.edit.completed';

function fixture(failAt?: ApprovalEvent) {
  const manager = new FileEditApprovals();
  const abort = new AbortController();
  const events: { type: ApprovalEvent; payload: unknown }[] = [];
  const operations: string[] = [];
  const publish = async <T extends ApprovalEvent>(type: T, payload: EventPayloads[T]) => {
    if (type === failAt) throw new Error('模拟存储失败');
    operations.push(type);
    events.push({ type, payload });
  };
  const apply = vi.fn(async () => {
    operations.push('实际写入');
    return { status: 'applied' as const, summary: '已写入确认的修改。' };
  });
  const run = () => manager.request(context, proposal, apply, abort.signal, publish);
  return { manager, abort, events, operations, publish, apply, run };
}

async function pending(manager: FileEditApprovals): Promise<PendingFileEdit> {
  await vi.waitFor(() => expect(manager.readPending()).not.toBeNull());
  return manager.readPending()!;
}

function decide(manager: FileEditApprovals, view: PendingFileEdit, decision: 'approved' | 'rejected') {
  return manager.decide({ conversationId: DEFAULT_CONVERSATION_ID, runId: view.runId,
    approvalId: view.approvalId, bindingDigest: view.bindingDigest, decision });
}

describe('具体文件提案审批（尚未执行）', () => {
  it('审批和开始事件落日志后才执行，批准一次只写一次', async () => {
    const f = fixture();
    const task = f.run();
    const view = await pending(f.manager);
    expect(f.apply).not.toHaveBeenCalled();
    expect(decide(f.manager, view, 'approved')).toEqual({ ok: true });
    expect(decide(f.manager, view, 'approved')).toEqual({ ok: false, code: 'APPROVAL_UNAVAILABLE' });
    expect(await task).toMatchObject({ status: 'applied' });
    expect(f.operations).toEqual(['approval.requested', 'approval.decided', 'file.edit.started', '实际写入', 'file.edit.completed']);
    expect(f.apply).toHaveBeenCalledTimes(1);
    expect(f.manager.readPending()).toBeNull();
    expect(JSON.stringify(f.events)).not.toContain('const value');
  });

  it('拒绝不调用执行器', async () => {
    const f = fixture();
    const task = f.run();
    expect(decide(f.manager, await pending(f.manager), 'rejected')).toEqual({ ok: true });
    expect(await task).toMatchObject({ status: 'rejected' });
    expect(f.apply).not.toHaveBeenCalled();
    expect(f.events.map((event) => event.type)).toEqual(['approval.requested', 'approval.decided']);
  });

  it('不接受其他任务或其他修改摘要的确认', async () => {
    const f = fixture();
    const task = f.run();
    const view = await pending(f.manager);
    expect(decide(f.manager, { ...view, bindingDigest: '0'.repeat(64) }, 'approved').ok).toBe(false);
    expect(decide(f.manager, { ...view, runId: context.toolCallId }, 'approved').ok).toBe(false);
    expect(f.apply).not.toHaveBeenCalled();
    decide(f.manager, view, 'rejected');
    await task;
  });

  it('审批期间取消会结束等待且不能继续批准', async () => {
    const f = fixture();
    const task = f.run();
    const view = await pending(f.manager);
    f.abort.abort();
    expect(await task).toMatchObject({ status: 'cancelled' });
    expect(decide(f.manager, view, 'approved').ok).toBe(false);
    expect(f.apply).not.toHaveBeenCalled();
  });

  it('60秒过期不写入且不能消费旧审批', async () => {
    vi.useFakeTimers();
    try {
      const f = fixture();
      const task = f.run();
      await Promise.resolve();
      const view = f.manager.readPending()!;
      expect(view).not.toBeNull();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(await task).toMatchObject({ status: 'expired' });
      expect(decide(f.manager, view, 'approved').ok).toBe(false);
      expect(f.apply).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });

  it.each(['approval.decided', 'file.edit.started'] as const)('%s记录失败阻止写入', async (failAt) => {
    const f = fixture(failAt);
    const task = f.run();
    const rejection = expect(task).rejects.toThrow('模拟存储失败');
    decide(f.manager, await pending(f.manager), 'approved');
    await rejection;
    expect(f.apply).not.toHaveBeenCalled();
    expect(f.manager.readPending()).toBeNull();
  });

  it('写入后取消仍记录实际写入结果，不宣称回滚', async () => {
    const f = fixture();
    f.apply.mockImplementation(async () => {
      f.abort.abort();
      return { status: 'applied', summary: '已写入确认的修改。' };
    });
    const task = f.run();
    decide(f.manager, await pending(f.manager), 'approved');
    expect(await task).toMatchObject({ status: 'applied' });
    expect(f.events.at(-1)).toMatchObject({ type: 'file.edit.completed', payload: { status: 'applied' } });
  });

  it('执行器异常作为结果未知记录，不能当作未修改', async () => {
    const f = fixture();
    f.apply.mockRejectedValueOnce(new Error('模拟执行器异常'));
    const task = f.run();
    decide(f.manager, await pending(f.manager), 'approved');
    expect(await task).toMatchObject({ status: 'unknown' });
    expect(f.events.at(-1)).toMatchObject({ payload: { status: 'unknown' } });
  });

  it('拒绝正文与哈希不一致的提案', async () => {
    const f = fixture();
    await expect(f.manager.request(context, { ...proposal, afterText: '不同内容' }, f.apply,
      f.abort.signal, f.publish)).rejects.toThrow('文件修改提案不符合审批协议');
    expect(f.events).toEqual([]);
    expect(f.apply).not.toHaveBeenCalled();
  });
});
