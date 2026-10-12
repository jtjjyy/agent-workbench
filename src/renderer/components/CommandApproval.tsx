import { Check, CircleAlert, Clock, LoaderCircle, X } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { AgentBridge, EventEnvelope } from '../../shared/contracts';
import type { PendingCommandApproval } from '../../shared/command';

interface Props {
  bridge?: Pick<AgentBridge, 'readPendingCommand' | 'decideCommand'>;
  events: EventEnvelope[];
  activeRunId: string | null;
  blocked: boolean;
  onPendingChange?: (pending: boolean) => void;
}

function same(a: PendingCommandApproval, b: PendingCommandApproval): boolean {
  return a.runId === b.runId && a.approvalId === b.approvalId && a.bindingDigest === b.bindingDigest
    && a.command === b.command && a.cwd === b.cwd && a.preview === b.preview;
}

export function CommandApproval({ bridge, events, activeRunId, blocked, onPendingChange }: Props) {
  const [pending, setPending] = useState<PendingCommandApproval | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now);
  const generation = useRef(0);
  const requested = events.some((event) => event.type === 'command.approval.requested' && event.payload.runId === activeRunId);

  useLayoutEffect(() => {
    let live = true;
    const current = ++generation.current;
    const read = bridge?.readPendingCommand();
    if (!read) {
      setPending(null);
      return () => { live = false; };
    }
    void read.then((value) => {
      if (live && current === generation.current) {
        setPending(value && value.runId === activeRunId && Date.parse(value.expiresAt) > Date.now() ? value : null);
      }
    }).catch(() => {
      if (live) setError('无法读取当前命令审批。');
    });
    return () => { live = false; };
  }, [bridge, activeRunId, blocked, requested]);

  useEffect(() => {
    if (!pending) return;
    const timer = window.setInterval(() => {
      setNow(Date.now());
      if (Date.parse(pending.expiresAt) <= Date.now()) {
        setPending(null);
        setError('命令审批已过期。');
      }
    }, 250);
    return () => window.clearInterval(timer);
  }, [pending]);

  useEffect(() => {
    onPendingChange?.(!!pending && !blocked);
    return () => onPendingChange?.(false);
  }, [pending, blocked, onPendingChange]);

  async function decide(decision: 'approved' | 'rejected'): Promise<void> {
    if (!pending || blocked || busy || !bridge) return;
    setBusy(true);
    setError(null);
    try {
      const current = await bridge.readPendingCommand();
      if (!current || !same(pending, current)) {
        setError('当前审批内容已变化，请重新查看。');
        setPending(current);
        return;
      }
      const result = await bridge.decideCommand({ conversationId: 'default', runId: current.runId,
        approvalId: current.approvalId, bindingDigest: current.bindingDigest, decision });
      if (!result.ok) setError('审批已不可用，请重新提交任务。');
      else setPending(null);
    } catch {
      setError('无法提交命令审批决定。');
    } finally {
      setBusy(false);
    }
  }

  if ((!pending || blocked) && !error) return null;
  return <section className="command-approval" aria-label="命令与浏览器交互审批" aria-busy={busy}>
    <header className="command-approval-header">
      <h2><CircleAlert size={16} aria-hidden="true" />命令与浏览器交互审批</h2>
      {pending && <span><Clock size={14} aria-hidden="true" />剩余 {Math.max(0,
        Math.ceil((Date.parse(pending.expiresAt) - now) / 1000))} 秒</span>}
    </header>
    {pending && <>
      <p>风险等级：{pending.risk === 'mutation' ? '可能修改工作区' : pending.risk === 'network' ? '可能访问网络' : '工作区操作'}</p>
      <pre className="command-approval-command">{pending.command}</pre>
      {pending.preview !== undefined && <>
        <p>待输入内容（仅当前审批显示，不写入事件日志）：</p>
        <pre className="command-approval-command">{pending.preview}</pre>
      </>}
      <p>工作目录：<code>{pending.cwd}</code></p>
      <p>最长执行时间：{Math.ceil(pending.timeoutMs / 1000)} 秒</p>
      <p>审批只针对这一次完整操作，不是永久授权，也不是操作系统沙箱。取消后不会自动重放。</p>
      <div className="command-approval-actions">
        <button className="file-edit-decision file-edit-reject" type="button" disabled={busy}
          onClick={() => { void decide('rejected'); }}><X size={16} aria-hidden="true" />拒绝</button>
        <button className="file-edit-decision file-edit-approve" type="button" disabled={busy}
          onClick={() => { void decide('approved'); }}>{busy ? <LoaderCircle size={16} aria-hidden="true" /> : <Check size={16} aria-hidden="true" />}批准本次操作</button>
      </div>
    </>}
    {error && <p className="command-approval-error" role="alert">{error}</p>}
  </section>;
}
