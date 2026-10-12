import { diffLines } from 'diff';
import { Check, CircleAlert, Clock, FilePenLine, LoaderCircle, RotateCcw, X } from 'lucide-react';
import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { AgentBridge, EventEnvelope } from '../../shared/contracts';
import { MAX_EDIT_TEXT_LENGTH, type ApprovalIdentity, type PendingFileEdit } from '../../shared/file-edit';

interface FileEditReviewProps {
  bridge?: Pick<AgentBridge, 'readPendingFileEdit' | 'decideFileEdit'>;
  events: EventEnvelope[];
  conversationId: string;
  activeRunId: string | null;
  blocked: boolean;
  reloadKey?: number;
  onPendingChange?: (pending: boolean) => void;
}

const DECISION_ERRORS = {
  APPROVAL_UNAVAILABLE: '审批已不可用，已重新读取当前提案。',
  INVALID_APPROVAL_COMMAND: '审批身份无效，已重新读取当前提案。',
  JOURNAL_WRITE_FAILED: '审批决定未能写入日志，已重新读取当前提案。',
};

function identityKey(identity: ApprovalIdentity): string {
  return JSON.stringify([identity.runId, identity.toolCallId, identity.approvalId, identity.bindingDigest,
    identity.path, identity.beforeSha256, identity.afterSha256]);
}

function validPreview(proposal: PendingFileEdit): boolean {
  return typeof proposal.beforeText === 'string' && typeof proposal.afterText === 'string'
    && proposal.beforeText.length <= MAX_EDIT_TEXT_LENGTH && proposal.afterText.length <= MAX_EDIT_TEXT_LENGTH
    && Number.isFinite(Date.parse(proposal.expiresAt));
}

function samePreview(left: PendingFileEdit, right: PendingFileEdit): boolean {
  return identityKey(left) === identityKey(right) && left.beforeText === right.beforeText
    && left.afterText === right.afterText && left.expiresAt === right.expiresAt;
}

function FileDiff({ proposal }: { proposal: PendingFileEdit }) {
  const changes = useMemo(() => {
    try {
      return diffLines(proposal.beforeText, proposal.afterText, {
        timeout: 50, maxEditLength: 1_000, oneChangePerToken: true,
      });
    } catch {
      return undefined;
    }
  }, [proposal.beforeText, proposal.afterText]);

  if (!changes) return <div className="file-edit-full-text">
    <p className="file-edit-notice">差异计算达到限额，以下为完整前后文本。</p>
    <h3>修改前</h3><pre aria-label="修改前全文">{proposal.beforeText}</pre>
    <h3>修改后</h3><pre aria-label="修改后全文">{proposal.afterText}</pre>
  </div>;

  let beforeLine = 1;
  let afterLine = 1;
  return <div className="file-edit-diff" role="region" aria-label="完整文件差异" tabIndex={0}>
    <div className="diff-column-head" aria-hidden="true"><span>原行</span><span>新行</span><span />
      <span>文件内容</span></div>
    {changes.map((change, index) => {
      const oldLine = change.added ? '' : beforeLine;
      const newLine = change.removed ? '' : afterLine;
      if (!change.added) beforeLine += change.count;
      if (!change.removed) afterLine += change.count;
      const kind = change.added ? 'added' : change.removed ? 'removed' : 'unchanged';
      return <div className={`diff-row diff-${kind}`} key={index}>
        <span className="diff-line-number" aria-hidden="true">{oldLine}</span>
        <span className="diff-line-number" aria-hidden="true">{newLine}</span>
        <span className="diff-sign" aria-label={change.added ? '新增行' : change.removed ? '删除行' : '保留行'}>
          {change.added ? '+' : change.removed ? '-' : ' '}</span>
        <div className="diff-content"><pre>{change.value}</pre>
          {!change.value.endsWith('\n') && <span className="diff-no-newline">末尾无换行</span>}
        </div>
      </div>;
    })}
  </div>;
}

export function FileEditReview({ bridge, events, conversationId, activeRunId, blocked,
  reloadKey = 0, onPendingChange }: FileEditReviewProps) {
  const [proposal, setProposal] = useState<PendingFileEdit | null>(null);
  const [reading, setReading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [now, setNow] = useState(Date.now);
  const generation = useRef(0);
  const pendingRef = useRef<PendingFileEdit | null>(null);
  const decisionInFlight = useRef(false);
  const mounted = useRef(false);

  useLayoutEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const lifecycle = useMemo(() => {
    const closed = new Set<string>();
    let requested: EventEnvelope<'approval.requested'> | undefined;
    let terminal = false;
    for (const event of events) {
      if (event.conversationId !== conversationId || !('runId' in event.payload)
        || event.payload.runId !== activeRunId) continue;
      if (event.type === 'approval.requested') requested = event;
      if (event.type === 'approval.decided' || event.type === 'file.edit.started'
        || event.type === 'file.edit.completed') closed.add(identityKey(event.payload));
      if (event.type === 'run.completed' || event.type === 'run.failed') terminal = true;
    }
    return { closed, requested, terminal };
  }, [events, conversationId, activeRunId]);
  const latest = useRef({ bridge, blocked, activeRunId, conversationId, lifecycle });
  latest.current = { bridge, blocked, activeRunId, conversationId, lifecycle };

  function available(candidate: PendingFileEdit): boolean {
    const current = latest.current;
    return !current.blocked && !current.lifecycle.terminal && candidate.runId === current.activeRunId
      && !current.lifecycle.closed.has(identityKey(candidate))
      && Date.parse(candidate.expiresAt) > Date.now();
  }

  function clearProposal() {
    pendingRef.current = null;
    setProposal(null);
  }

  async function readCurrent(epoch: number): Promise<PendingFileEdit | null> {
    const connection = latest.current.bridge;
    clearProposal();
    setReading(true);
    try {
      if (!connection || typeof connection.readPendingFileEdit !== 'function') throw new Error();
      const current = await connection.readPendingFileEdit();
      if (epoch !== generation.current) return null;
      if (current && !validPreview(current)) {
        setError('提案超过完整预览上限或内容无效，不能批准。');
        return null;
      }
      if (!current || !available(current)) return null;
      pendingRef.current = current;
      setProposal(current);
      setNow(Date.now());
      return current;
    } catch {
      if (epoch === generation.current) setError('无法读取当前文件修改提案，请重试。');
      return null;
    } finally {
      if (epoch === generation.current) setReading(false);
    }
  }

  useLayoutEffect(() => {
    const epoch = ++generation.current;
    clearProposal();
    setError(null);
    setNotice(null);
    setReading(false);
    setSubmitting(decisionInFlight.current);
    if (bridge && !blocked) void readCurrent(epoch);
    return () => { ++generation.current; pendingRef.current = null; };
  }, [bridge, activeRunId, conversationId, blocked, reloadKey, lifecycle.requested?.eventId, refresh]);

  useLayoutEffect(() => {
    if (pendingRef.current && !available(pendingRef.current)) clearProposal();
  }, [lifecycle]);

  useLayoutEffect(() => {
    if (!proposal) return;
    const expiresAt = Date.parse(proposal.expiresAt);
    const timer = window.setInterval(() => {
      const timestamp = Date.now();
      setNow(timestamp);
      if (timestamp >= expiresAt) {
        ++generation.current;
        clearProposal();
        setReading(false);
        setNotice('审批已到期，未提交修改。');
      }
    }, 250);
    return () => window.clearInterval(timer);
  }, [proposal]);

  const visible = proposal && !blocked && available(proposal) ? proposal : null;
  useLayoutEffect(() => {
    onPendingChange?.(!!visible);
    return () => { onPendingChange?.(false); };
  }, [!!visible, onPendingChange]);

  async function decide(decision: 'approved' | 'rejected') {
    const reviewed = pendingRef.current;
    if (!reviewed || !available(reviewed) || decisionInFlight.current) return;
    decisionInFlight.current = true;
    setSubmitting(true);
    setError(null);
    const epoch = generation.current;
    const connection = latest.current.bridge;
    const targetConversation = latest.current.conversationId;
    try {
      if (!connection || typeof connection.decideFileEdit !== 'function') throw new Error();
      // Refresh before sending: an old renderer snapshot is never approval authority.
      const current = await readCurrent(epoch);
      if (epoch !== generation.current) return;
      if (!current) return;
      if (!samePreview(reviewed, current)) {
        setError('当前提案已变化，请重新审阅后决定。');
        return;
      }
      if (!available(current)) { clearProposal(); return; }
      clearProposal();
      const result = await connection.decideFileEdit({ conversationId: targetConversation,
        runId: current.runId, approvalId: current.approvalId, bindingDigest: current.bindingDigest, decision });
      if (epoch !== generation.current) return;
      clearProposal();
      if (result.ok) {
        setNotice(decision === 'approved' ? '已提交批准决定，写入结果以完成事件为准。' : '已提交拒绝决定。');
      } else {
        setError(DECISION_ERRORS[result.code]);
        await readCurrent(epoch);
      }
    } catch {
      if (epoch === generation.current) {
        clearProposal();
        setError('无法提交审批决定，已重新读取当前提案。');
        await readCurrent(epoch);
      }
    } finally {
      decisionInFlight.current = false;
      if (mounted.current) setSubmitting(false);
    }
  }

  if (!visible && !error && !notice && ((!reading && !submitting) || !activeRunId)) return null;
  return <section className="file-edit-review" aria-label="文件修改审批" aria-busy={reading || submitting}>
    <header className="file-edit-header"><h2><FilePenLine size={16} aria-hidden="true" />文件修改审批</h2>
      {visible && <span className="file-edit-expiry"><Clock size={14} aria-hidden="true" />
        剩余 {Math.max(0, Math.ceil((Date.parse(visible.expiresAt) - now) / 1_000))} 秒</span>}
    </header>
    {reading && <p className="file-edit-notice" role="status"><LoaderCircle size={14} aria-hidden="true" />
      正在读取当前提案…</p>}
    {submitting && !reading && <p className="file-edit-notice" role="status">
      <LoaderCircle size={14} aria-hidden="true" />正在提交审批决定…</p>}
    {visible && <>
      <p className="file-edit-path"><code>{visible.path}</code></p>
      <dl className="file-edit-metadata">
        <dt>修改前 SHA-256</dt><dd><code>{visible.beforeSha256}</code></dd>
        <dt>修改后 SHA-256</dt><dd><code>{visible.afterSha256}</code></dd>
        <dt>到期时间</dt><dd><time dateTime={visible.expiresAt}>
          {new Date(visible.expiresAt).toLocaleString('zh-CN', { hour12: false })}</time></dd>
      </dl>
      <FileDiff proposal={visible} />
      <div className="file-edit-actions">
        <button type="button" className="file-edit-decision file-edit-reject" title="拒绝本次文件修改"
          disabled={submitting || reading} onClick={() => { void decide('rejected'); }}>
          <X size={16} aria-hidden="true" />拒绝修改</button>
        <button type="button" className="file-edit-decision file-edit-approve" title="批准当前完整提案"
          disabled={submitting || reading} onClick={() => { void decide('approved'); }}>
          <Check size={16} aria-hidden="true" />批准修改</button>
      </div>
    </>}
    {error && <div className="file-edit-error"><CircleAlert size={16} aria-hidden="true" />
      <p role="alert">{error}</p>
      <button className="icon-button" type="button" title="重新读取当前提案" aria-label="重新读取当前提案"
        disabled={blocked || reading || submitting} onClick={() => { setRefresh((value) => value + 1); }}>
        <RotateCcw size={16} aria-hidden="true" /></button>
    </div>}
    {notice && <p className="file-edit-notice" role="status">{notice}</p>}
  </section>;
}
