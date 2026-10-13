import { diffLines } from 'diff';
import { Check, Clock, FilePenLine, LoaderCircle, RotateCcw, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  CHANGE_SET_LIMITS, type ChangePreview, type ChangeSetBridge, type ChangeSetRecord, type PendingChangeSet,
} from '../../shared/change-set';

export interface ChangeSetReviewProps {
  bridge?: ChangeSetBridge;
  activeRunId: string | null;
  taskId?: string;
  blocked?: boolean;
  reloadKey?: number;
  events?: readonly { type: string; sequence: number }[];
  onPendingChange?: (pending: boolean) => void;
}

const operationLabel = { create: '新建', update: '修改', delete: '删除', rename: '重命名' } as const;
const statusLabel: Record<string, string> = { pending: '待审批', not_applied: '未应用', applying: '应用中',
  applied: '已应用', partial: '部分应用', conflict: '冲突', failed: '失败', unknown: '结果未知',
  cancelled: '已取消', rejected: '已拒绝', expired: '已过期' };
const preStyle = { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', maxWidth: '100%' } as const;

function validPreview(value: PendingChangeSet): boolean {
  return Array.isArray(value.operations) && value.operations.length > 0
    && value.operations.length <= CHANGE_SET_LIMITS.operations
    && Number.isFinite(Date.parse(value.expiresAt))
    && value.operations.every((item) => ['create', 'update', 'delete', 'rename'].includes(item.operation)
      && [item.beforeText, item.afterText].every((text) => text === null
        || (typeof text === 'string' && text.length <= CHANGE_SET_LIMITS.textLength)));
}

function FullDiff({ operation }: { operation: ChangePreview }) {
  const changes = useMemo(() => {
    try { return diffLines(operation.beforeText ?? '', operation.afterText ?? '',
      { timeout: 50, maxEditLength: 1000, oneChangePerToken: true }); }
    catch { return undefined; }
  }, [operation.beforeText, operation.afterText]);
  if (!changes) return <div className="file-edit-full-text">
    <p>差异计算达到限额，显示完整前后正文。</p>
    <h4>变更前全文</h4><pre style={preStyle}>{operation.beforeText ?? '文件不存在'}</pre>
    <h4>变更后全文</h4><pre style={preStyle}>{operation.afterText ?? '文件不存在'}</pre>
  </div>;
  if (!changes.length) return <p>{operation.operation === 'create' ? '新建空文件'
    : operation.operation === 'delete' ? '删除空文件' : '正文保持不变'}</p>;
  let beforeLine = 1;
  let afterLine = 1;
  return <div className="file-edit-diff" role="region" aria-label="完整文件差异" tabIndex={0}>
    <div className="diff-column-head" aria-hidden="true"><span>原行</span><span>新行</span><span /><span>正文</span></div>
    {changes.map((change, index) => {
      const oldLine = change.added ? '' : beforeLine;
      const newLine = change.removed ? '' : afterLine;
      if (!change.added) beforeLine += change.count;
      if (!change.removed) afterLine += change.count;
      return <div key={index} className={`diff-row diff-${change.added ? 'added' : change.removed ? 'removed' : 'unchanged'}`}>
        <span className="diff-line-number" aria-hidden="true">{oldLine}</span>
        <span className="diff-line-number" aria-hidden="true">{newLine}</span>
        <span className="diff-sign" aria-label={change.added ? '新增行' : change.removed ? '删除行' : '保留行'}>
          {change.added ? '+' : change.removed ? '-' : ' '}</span>
        <div className="diff-content" style={{ minWidth: 0 }}><pre style={preStyle}>{change.value}</pre>
          {!change.value.endsWith('\n') && <span className="diff-no-newline">末尾无换行</span>}
        </div>
      </div>;
    })}
  </div>;
}

export function ChangeSetReview({ bridge, activeRunId, taskId, blocked = false, reloadKey = 0,
  events, onPendingChange }: ChangeSetReviewProps) {
  const [pending, setPending] = useState<PendingChangeSet | null>(null);
  const [records, setRecords] = useState<ChangeSetRecord[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [now, setNow] = useState(Date.now);
  const epoch = useRef(0);
  const inFlight = useRef(false);
  const latest = useRef({ bridge, activeRunId, taskId, blocked });
  latest.current = { bridge, activeRunId, taskId, blocked };
  const lastChangeEvent = events?.findLast((event) => event.type !== 'message.agent.delta')?.sequence;

  function available(value: PendingChangeSet): boolean {
    const current = latest.current;
    return !current.blocked && value.runId === current.activeRunId
      && (!current.taskId || value.taskId === current.taskId) && Date.parse(value.expiresAt) > Date.now();
  }

  useEffect(() => {
    setPending(null);
    setRecords([]);
    setError(null);
    setNotice(null);
  }, [bridge, activeRunId, taskId]);

  useEffect(() => {
    const generation = ++epoch.current;
    if (!bridge) return;
    const load = async () => {
      try {
        const proposal = await bridge.readPendingChangeSet();
        if (generation !== epoch.current) return;
        if (proposal && !validPreview(proposal)) throw new Error();
        setPending(proposal && available(proposal) ? proposal : null);
        const history = await bridge.readChangeSets(taskId);
        if (generation === epoch.current) setRecords(history);
      } catch {
        if (generation === epoch.current) {
          setPending(null);
          setError('无法读取当前变更集或完整预览。');
        }
      }
    };
    void load();
    return () => { ++epoch.current; };
  }, [bridge, activeRunId, taskId, blocked, reloadKey, lastChangeEvent, refresh]);

  useEffect(() => {
    if (!pending) return;
    const timer = window.setInterval(() => {
      setNow(Date.now());
      if (!available(pending)) {
        setPending(null);
        setNotice('本次审批已不可用；未提交新的批准决定。');
      }
    }, 250);
    return () => window.clearInterval(timer);
  }, [pending]);

  const visible = pending && available(pending) ? pending : null;
  useEffect(() => {
    onPendingChange?.(!!visible);
    return () => onPendingChange?.(false);
  }, [!!visible, onPendingChange]);

  async function decide(decision: 'approved' | 'rejected'): Promise<void> {
    if (!visible || !bridge || inFlight.current) return;
    const reviewed = visible;
    const generation = epoch.current;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      const current = await bridge.readPendingChangeSet();
      if (generation !== epoch.current) return;
      if (!current || !validPreview(current) || !available(current)) { setPending(null); return; }
      // 正文与完整身份均需一致，客户端旧快照不能代表本次批准。
      if (JSON.stringify(current) !== JSON.stringify(reviewed)) {
        setPending(current);
        setError('提案内容或审批身份已变化，请重新审阅。');
        return;
      }
      const result = await bridge.decideChangeSet({ id: current.id, runId: current.runId,
        taskId: current.taskId, toolCallId: current.toolCallId, approvalId: current.approvalId,
        bindingDigest: current.bindingDigest, decision });
      if (generation !== epoch.current) return;
      setPending(null);
      if (!result.ok) setError('审批已不可用，请重新读取当前提案。');
      else setNotice(decision === 'approved' ? '已提交批准，实际结果以逐项应用记录为准。' : '已拒绝此批变更。');
      setRefresh((value) => value + 1);
    } catch {
      if (generation === epoch.current) setError('无法提交变更集审批决定。');
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  if (!bridge) return null;
  return <section className="file-edit-review" aria-label="多文件变更审阅" aria-busy={busy} style={{ minWidth: 0 }}>
    <header className="file-edit-header"><h2><FilePenLine size={16} aria-hidden="true" />多文件变更</h2>
      <button type="button" className="icon-button" title="刷新变更记录" aria-label="刷新变更记录"
        disabled={busy} onClick={() => { setError(null); setRefresh((value) => value + 1); }}>
        <RotateCcw size={16} aria-hidden="true" /></button>
    </header>
    {visible && <>
      <p><Clock size={14} aria-hidden="true" /> 剩余 {Math.max(0, Math.ceil((Date.parse(visible.expiresAt) - now) / 1000))} 秒</p>
      <p style={preStyle}>工作区：<code>{visible.workspaceRoot}</code></p>
      {visible.operations.map((item, index) => <div key={`${index}:${item.path}`} style={{ minWidth: 0 }}>
        <h3 style={preStyle}>{index + 1}. {operationLabel[item.operation]} <code>{item.path}</code>
          {item.toPath && <> → <code>{item.toPath}</code></>}</h3>
        <dl className="file-edit-metadata">
          <dt>变更前 SHA-256</dt><dd style={preStyle}><code>{item.beforeSha256 ?? '不存在'}</code></dd>
          <dt>变更后 SHA-256</dt><dd style={preStyle}><code>{item.afterSha256 ?? '不存在'}</code></dd>
        </dl>
        <FullDiff operation={item} />
      </div>)}
      <p>本次审批绑定整个批次。部分失败保留实际结果，不自动回滚。</p>
      <div className="file-edit-actions">
        <button type="button" className="file-edit-decision file-edit-reject" disabled={busy}
          title="拒绝本次完整变更集" onClick={() => { void decide('rejected'); }}>
          <X size={16} aria-hidden="true" />拒绝整批</button>
        <button type="button" className="file-edit-decision file-edit-approve" disabled={busy}
          title="批准当前完整变更集" onClick={() => { void decide('approved'); }}>
          {busy ? <LoaderCircle size={16} aria-hidden="true" /> : <Check size={16} aria-hidden="true" />}批准整批</button>
      </div>
    </>}
    {error && <p role="alert">{error}</p>}
    {notice && <p role="status">{notice}</p>}
    {records.length > 0 && <div aria-label="逐项应用记录">
      {records.map((record) => <details key={record.id}>
        <summary>变更代次 {record.generation} · {statusLabel[record.status]}</summary>
        {record.operations.map((item, index) => <p key={`${index}:${item.path}`} style={preStyle}>
          {operationLabel[item.operation]} <code>{item.path}</code>{item.toPath && <> → <code>{item.toPath}</code></>}
          {' · '}{statusLabel[item.status]}：{item.summary}
        </p>)}
      </details>)}
    </div>}
  </section>;
}
