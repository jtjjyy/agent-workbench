// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { diffLines } from 'diff';
import type { AgentBridge, EventEnvelope } from '../../src/shared/contracts';
import type { ApprovalIdentity, PendingFileEdit } from '../../src/shared/file-edit';
import { FileEditReview } from '../../src/renderer/components/FileEditReview';
import { ToolTrace } from '../../src/renderer/components/ToolTrace';

vi.mock('diff', async (importOriginal) => ({ ...await importOriginal<typeof import('diff')>(), diffLines: vi.fn() }));

const proposal = (): PendingFileEdit => ({
  runId: 'run-1', toolCallId: 'call-1', approvalId: 'approval-1', bindingDigest: 'a'.repeat(64),
  path: 'src/example.ts', beforeSha256: 'b'.repeat(64), afterSha256: 'c'.repeat(64),
  beforeText: '保留行\n旧内容\n', afterText: '保留行\n<script>新内容</script>\n',
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
});

function identity(current: PendingFileEdit): ApprovalIdentity {
  return { runId: current.runId, toolCallId: current.toolCallId, approvalId: current.approvalId,
    bindingDigest: current.bindingDigest, path: current.path,
    beforeSha256: current.beforeSha256, afterSha256: current.afterSha256 };
}

function fixture(initial = proposal()) {
  const bridge: Pick<AgentBridge, 'readPendingFileEdit' | 'decideFileEdit'> = {
    readPendingFileEdit: vi.fn(async () => initial),
    decideFileEdit: vi.fn(async () => ({ ok: true as const })),
  };
  const props = { bridge, events: [] as EventEnvelope[], activeRunId: initial.runId,
    conversationId: 'default', blocked: false };
  return { bridge, props, initial };
}

afterEach(() => { cleanup(); vi.useRealTimers(); vi.resetAllMocks(); });

describe('中文文件审批', () => {
  it('按增删行显示完整文本、相对路径与哈希，不执行 HTML', async () => {
    vi.mocked(diffLines).mockReturnValue([
      { value: '保留行\n', added: false, removed: false, count: 1 },
      { value: '旧内容\n', added: false, removed: true, count: 1 },
      { value: '<script>新内容</script>\n', added: true, removed: false, count: 1 },
    ]);
    const { props, initial } = fixture();
    const view = render(<FileEditReview {...props} />);
    await screen.findByRole('button', { name: '批准修改' });
    expect(screen.getByText(initial.path)).toBeInTheDocument();
    expect(screen.getByText(initial.beforeSha256)).toBeInTheDocument();
    expect(screen.getByText(initial.afterSha256)).toBeInTheDocument();
    expect(view.container.querySelector('.diff-removed')).toHaveTextContent('旧内容');
    expect(view.container.querySelector('.diff-added')).toHaveTextContent('<script>新内容</script>');
    expect(view.container.querySelector('script')).toBeNull();
    expect(diffLines).toHaveBeenCalledWith(initial.beforeText, initial.afterText,
      expect.objectContaining({ timeout: 50, maxEditLength: 1_000 }));
  });

  it('算法放弃时显示前后全文，包括末尾而非截断', async () => {
    vi.mocked(diffLines).mockImplementation((() => undefined) as typeof diffLines);
    const initial = { ...proposal(), beforeText: `${'旧'.repeat(11_999)}甲`, afterText: `${'新'.repeat(11_999)}乙` };
    render(<FileEditReview {...fixture(initial).props} />);
    expect(await screen.findByLabelText('修改前全文')).toHaveTextContent(initial.beforeText);
    expect(screen.getByLabelText('修改后全文')).toHaveTextContent(initial.afterText);
  });

  it('重新读取发现提案变化时不提交旧审批', async () => {
    const { bridge, props } = fixture();
    render(<FileEditReview {...props} />);
    const approve = await screen.findByRole('button', { name: '批准修改' });
    vi.mocked(bridge.readPendingFileEdit).mockResolvedValue({ ...proposal(), approvalId: 'approval-2' });
    fireEvent.click(approve);
    await screen.findByText('当前提案已变化，请重新审阅后决定。');
    expect(bridge.decideFileEdit).not.toHaveBeenCalled();
  });

  it('同步阻止重复点击，仅提交身份与决定，不发送正文', async () => {
    const { bridge, props, initial } = fixture();
    let resolve!: (value: PendingFileEdit) => void;
    render(<FileEditReview {...props} />);
    const approve = await screen.findByRole('button', { name: '批准修改' });
    vi.mocked(bridge.readPendingFileEdit).mockImplementation(() => new Promise((done) => { resolve = done; }));
    fireEvent.click(approve);
    fireEvent.click(approve);
    await act(async () => { resolve(initial); });
    await waitFor(() => expect(bridge.decideFileEdit).toHaveBeenCalledTimes(1));
    expect(bridge.decideFileEdit).toHaveBeenCalledWith({ conversationId: 'default', runId: initial.runId,
      approvalId: initial.approvalId, bindingDigest: initial.bindingDigest, decision: 'approved' });
    expect(screen.queryByRole('button', { name: '批准修改' })).not.toBeInTheDocument();
  });

  it('决定请求失败后清除旧正文并重新读取', async () => {
    const { bridge, props, initial } = fixture();
    render(<FileEditReview {...props} />);
    const reject = await screen.findByRole('button', { name: '拒绝修改' });
    vi.mocked(bridge.decideFileEdit).mockRejectedValue(new Error('transport'));
    vi.mocked(bridge.readPendingFileEdit).mockResolvedValueOnce(initial).mockResolvedValueOnce(null);
    fireEvent.click(reject);
    await screen.findByText('无法提交审批决定，已重新读取当前提案。');
    expect(screen.queryByRole('button', { name: '批准修改' })).not.toBeInTheDocument();
    expect(bridge.readPendingFileEdit).toHaveBeenCalledTimes(3);
  });

  it('过期后关闭审批入口', async () => {
    vi.useFakeTimers();
    const { props } = fixture({ ...proposal(), expiresAt: new Date(Date.now() + 1_000).toISOString() });
    render(<FileEditReview {...props} />);
    await act(async () => {});
    expect(screen.getByRole('button', { name: '批准修改' })).toBeEnabled();
    await act(async () => { vi.advanceTimersByTime(1_001); });
    expect(screen.queryByRole('button', { name: '批准修改' })).not.toBeInTheDocument();
    expect(screen.getByText('审批已到期，未提交修改。')).toBeInTheDocument();
  });

  it.each(['approval.decided', 'file.edit.started', 'file.edit.completed'] as const)(
    '%s 事件到达后清除正文', async (type) => {
      const { props, bridge, initial } = fixture();
      const view = render(<FileEditReview {...props} />);
      await screen.findByRole('button', { name: '批准修改' });
      const event = { schemaVersion: 1, eventId: 'event-1', sequence: 1, conversationId: 'default',
        occurredAt: new Date().toISOString(), type,
        payload: { ...identity(initial), ...(type === 'approval.decided' ? { decision: 'cancelled' }
          : type === 'file.edit.completed' ? { status: 'cancelled' } : {}) } } as EventEnvelope;
      vi.mocked(bridge.readPendingFileEdit).mockResolvedValue(initial);
      view.rerender(<FileEditReview {...props} events={[event]} />);
      await act(async () => {});
      expect(screen.queryByRole('button', { name: '批准修改' })).not.toBeInTheDocument();
      expect(screen.queryByText('<script>新内容</script>')).not.toBeInTheDocument();
    });

  it('超过完整文本上限时不截断成可批准提案', async () => {
    render(<FileEditReview {...fixture({ ...proposal(), afterText: 'x'.repeat(12_001) }).props} />);
    await screen.findByText('提案超过完整预览上限或内容无效，不能批准。');
    expect(screen.queryByRole('button', { name: '批准修改' })).not.toBeInTheDocument();
  });

  it('历史写入开始没有完成事件时显示结果未确认', () => {
    const event: EventEnvelope<'file.edit.started'> = { schemaVersion: 1, eventId: 'event-1',
      conversationId: 'default', sequence: 1, occurredAt: new Date().toISOString(),
      type: 'file.edit.started', payload: identity(proposal()) };
    render(<ToolTrace events={[event]} />);
    expect(screen.getByText('结果未确认')).toBeInTheDocument();
    expect(screen.queryByText('已写入')).not.toBeInTheDocument();
  });
});
