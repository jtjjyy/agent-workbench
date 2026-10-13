import { AlertTriangle, ClipboardList, FileCheck, LoaderCircle, Pause, Play, RefreshCw, Square } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  unknownTaskEffects, type TaskRecord, type TaskResumeRequest, type TaskStatus, type TaskStepStatus,
} from '../../shared/tasks';
import type { ChangeDelivery } from '../../shared/change-set';

export interface TaskPanelBridge {
  readTasks(): Promise<TaskRecord[]>;
  pauseTask(request: { taskId: string }): Promise<unknown>;
  cancelTask(request: { taskId: string }): Promise<unknown>;
  resumeTask(request: TaskResumeRequest): Promise<unknown>;
  getDelivery?(taskId: string): Promise<ChangeDelivery>;
}

export interface TaskPanelProps { bridge?: TaskPanelBridge; activeRunId?: string | null; blocked?: boolean;
  events?: readonly { type: string; sequence: number }[] }

const STATUS: Record<TaskStatus, string> = { running: '进行中', waiting_approval: '等待审批', paused: '已暂停',
  cancelled: '已取消', interrupted: '已中断', completed: '已完成', failed: '失败' };
const STEP_STATUS: Record<TaskStepStatus, string> = { pending: '待执行', in_progress: '进行中',
  completed: '已完成', blocked: '受阻', cancelled: '已取消' };
const EFFECT = { none: '无外部副作用', file_write: '文件修改', command: '命令执行',
  browser_interaction: '浏览器交互', unknown: '未分类副作用' };
const RESUMABLE = new Set<TaskStatus>(['paused', 'cancelled', 'interrupted', 'failed']);
const wrap = { minWidth: 0, overflowWrap: 'anywhere' as const };

function assertActionResult(value: unknown): void {
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    if (record.ok === false || record.paused === false || record.cancelled === false
      || record.resumed === false || record.status === 'unavailable') throw new Error();
  }
}

export function TaskPanel({ bridge, activeRunId, blocked = false, events }: TaskPanelProps) {
  const [tasks, setTasks] = useState<TaskRecord[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [acknowledgement, setAcknowledgement] = useState<string | null>(null);
  const [delivery, setDelivery] = useState<ChangeDelivery | null>(null);
  const mounted = useRef(false);
  const busyRef = useRef(false);
  const refreshSequence = useRef(0);
  const deliverySequence = useRef(0);
  const bridgeRef = useRef(bridge);
  bridgeRef.current = bridge;

  const reload = useCallback(async (source: TaskPanelBridge | undefined) => {
    const sequence = ++refreshSequence.current;
    try {
      if (!source) throw new Error();
      const records = await source.readTasks();
      if (mounted.current && bridgeRef.current === source && sequence === refreshSequence.current) {
        setTasks(records); setError(null);
        setSelectedId((current) => records.some((task) => task.taskId === current) ? current
          : records.find((task) => task.activeRunId)?.taskId ?? records[0]?.taskId ?? null);
      }
    } catch {
      if (mounted.current && bridgeRef.current === source && sequence === refreshSequence.current) {
        setError('无法读取任务记录。请检查任务存储；已有记录仍保留。');
      }
    } finally {
      if (mounted.current && bridgeRef.current === source && sequence === refreshSequence.current) setLoading(false);
    }
  }, []);

  useEffect(() => { mounted.current = true; return () => { mounted.current = false; refreshSequence.current++; }; }, []);
  useEffect(() => {
    setLoading(true); setTasks([]); setSelectedId(null); setAcknowledgement(null);
    void reload(bridge);
  }, [bridge, reload]);
  const lastTaskEvent = events?.findLast((event) => event.type !== 'message.agent.delta')?.sequence;
  useEffect(() => { void reload(bridge); }, [activeRunId, bridge, reload, lastTaskEvent]);
  useEffect(() => {
    ++deliverySequence.current;
    setDelivery(null);
  }, [bridge, selectedId, activeRunId, lastTaskEvent]);

  const selected = tasks.find((task) => task.taskId === selectedId) ?? null;
  const unknown = selected ? unknownTaskEffects(selected) : [];
  const acknowledgementKey = selected ? JSON.stringify([selected.taskId,
    unknown.map((call) => [call.runId, call.toolCallId, call.summary, call.finishedAt ?? null])]) : '';
  const acknowledged = acknowledgement === acknowledgementKey;
  const active = selected?.status === 'running' || selected?.status === 'waiting_approval';
  const anotherRun = !!activeRunId && activeRunId !== selected?.activeRunId;
  const disableActions = !bridge || busy || loading || anotherRun;
  const resumeDisabled = disableActions || blocked || !!activeRunId
    || tasks.some((task) => task.activeRunId !== null) || (unknown.length > 0 && !acknowledged);

  async function readDelivery() {
    if (!bridge?.getDelivery || !selected || busyRef.current || blocked || activeRunId) return;
    const source = bridge;
    const requestedTaskId = selected.taskId;
    const sequence = ++deliverySequence.current;
    busyRef.current = true; setBusy(true); setError(null);
    try {
      const report = await source.getDelivery!(requestedTaskId);
      if (mounted.current && bridgeRef.current === source && sequence === deliverySequence.current
        && report.taskId === requestedTaskId) setDelivery(report);
    } catch {
      if (mounted.current && bridgeRef.current === source && sequence === deliverySequence.current) {
        setError('无法读取交付证据，请选择并授权本任务的原工作区后重试。');
      }
    } finally { busyRef.current = false; if (mounted.current) setBusy(false); }
  }

  async function act(action: 'pause' | 'cancel' | 'resume') {
    if (!bridge || !selected || busyRef.current || disableActions || (action === 'resume' && resumeDisabled)) return;
    if (action === 'resume' ? !RESUMABLE.has(selected.status) : !active) return;
    const source = bridge; const taskId = selected.taskId;
    busyRef.current = true; setBusy(true); setError(null);
    try {
      const value = action === 'pause' ? await source.pauseTask({ taskId })
        : action === 'cancel' ? await source.cancelTask({ taskId })
          : await source.resumeTask({ taskId, acknowledgeUnknown: unknown.length > 0 && acknowledged });
      assertActionResult(value);
      if (mounted.current && bridgeRef.current === source) {
        setAcknowledgement(null); await reload(source);
      }
    } catch {
      if (mounted.current && bridgeRef.current === source) {
        setError(action === 'resume' ? '续接未开始或状态无法确认。请重新授权原工作区、核对未知副作用并刷新任务记录。'
          : action === 'pause' ? '暂停未完成或状态无法确认。请刷新任务记录，已发生的副作用仍需核对。'
            : '取消未完成或状态无法确认。请刷新任务记录，取消不会撤销已发生的副作用。');
      }
    } finally { busyRef.current = false; if (mounted.current) setBusy(false); }
  }

  return <section className="knowledge-panel task-panel" aria-label="任务与续接" style={{ minWidth: 0 }}>
    <header className="section-header">
      <h2><ClipboardList size={15} aria-hidden="true" />任务与续接</h2>
      <button className="icon-button" type="button" title="刷新任务记录" aria-label="刷新任务记录"
        disabled={!bridge || busy} onClick={() => { void reload(bridge); }}>
        <RefreshCw size={15} aria-hidden="true" />
      </button>
    </header>
    <div className="knowledge-content" style={wrap}>
      {loading ? <p role="status"><LoaderCircle size={14} aria-hidden="true" />正在读取任务记录</p>
        : tasks.length === 0 ? <p>暂无任务记录</p>
          : <label style={{ display: 'grid', gap: 6 }}>任务
            <select aria-label="选择任务" value={selectedId ?? ''} disabled={busy}
              style={{ width: '100%', minWidth: 0, maxWidth: '100%' }}
              onChange={(event) => { setSelectedId(event.target.value); setAcknowledgement(null); }}>
              {tasks.map((task) => <option key={task.taskId} value={task.taskId}>
                {STATUS[task.status]} · {task.prompt.replace(/\s+/g, ' ').slice(0, 45)}
              </option>)}
            </select>
          </label>}
      {selected && <div style={{ ...wrap, display: 'grid', gap: 10, marginTop: 12 }}>
        <div style={wrap}><strong>{STATUS[selected.status]}</strong><p style={{ ...wrap, whiteSpace: 'pre-wrap', margin: '6px 0' }}>{selected.prompt}</p>
          <small>工作区：{selected.workspaceRoot ?? '未绑定工作区'}</small>
        </div>
        <div style={wrap} aria-label="任务计划"><strong>计划</strong>
          {selected.plan.steps.length === 0 ? <p>尚未制定计划</p>
            : <ol style={{ margin: '6px 0', paddingLeft: 24 }}>{selected.plan.steps.map((step) =>
              <li key={step.id} style={{ ...wrap, marginBottom: 6 }}><span>{STEP_STATUS[step.status]} · {step.title}</span>
                {step.detail && <div style={{ ...wrap, fontSize: 12, whiteSpace: 'pre-wrap' }}>{step.detail}</div>}
              </li>)}</ol>}
        </div>
        {unknown.length > 0 && <div role="group" aria-label="未知副作用核对" style={wrap}>
          <strong><AlertTriangle size={14} aria-hidden="true" />待核对的未知副作用</strong>
          <ul style={{ margin: '6px 0', paddingLeft: 20 }}>{unknown.map((call) =>
            <li key={`${call.runId}/${call.toolCallId}`} style={{ ...wrap, marginBottom: 8 }}>
              <div>{EFFECT[call.sideEffect]} · {call.toolName}</div><div>{call.summary}</div>
              <small>运行：{call.runId}；调用：{call.toolCallId}{call.acknowledgedAt ? '；此前已人工核对，结果仍未知' : ''}</small>
            </li>)}</ul>
          {RESUMABLE.has(selected.status) && <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
            <input type="checkbox" checked={acknowledged} disabled={busy || blocked || loading}
              onChange={(event) => setAcknowledgement(event.target.checked ? acknowledgementKey : null)} />
            <span style={wrap}>我已逐项核对实际文件、命令或浏览器状态，允许基于当前状态续接</span>
          </label>}
          <p style={{ margin: '6px 0', fontSize: 12 }}>确认不代表操作未执行。取消和续接不会自动回滚或重放这些调用。</p>
        </div>}
        {selected.error && <p className="knowledge-error" style={wrap}>上次运行：{selected.error}</p>}
        <details style={wrap}><summary>断点摘要</summary>
          <pre style={{ ...wrap, whiteSpace: 'pre-wrap', maxHeight: 240, overflowY: 'auto', fontSize: 12 }}>{selected.checkpoint.summary}</pre>
        </details>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          {active && <>
            <button className="text-button" type="button" title="暂停当前运行并保留续接点" disabled={disableActions}
              onClick={() => { void act('pause'); }}><Pause size={14} aria-hidden="true" />暂停</button>
            <button className="text-button cancel-button" type="button" title="取消当前运行，保留已发生的操作记录" disabled={disableActions}
              onClick={() => { void act('cancel'); }}><Square size={14} aria-hidden="true" />取消</button>
          </>}
          {RESUMABLE.has(selected.status) && <button className="text-button" type="button"
            title="重新授权原工作区后开始新一轮运行" disabled={resumeDisabled}
            onClick={() => { void act('resume'); }}><Play size={14} aria-hidden="true" />续接</button>}
          {selected.workspaceRoot && <button className="text-button" type="button" title="读取当前文件哈希与已有验证证据"
            disabled={disableActions || blocked || !!activeRunId || !bridge?.getDelivery}
            onClick={() => { void readDelivery(); }}><FileCheck size={14} aria-hidden="true" />交付状态</button>}
          {busy && <span role="status"><LoaderCircle size={14} aria-hidden="true" />正在保存任务状态</span>}
        </div>
        {delivery && <div aria-label="交付证据" style={wrap}>
          <strong>{delivery.canComplete ? '具备交付完成证据' : '交付条件未满足'}</strong>
          <p>验证：{delivery.verification === 'passed' ? '通过' : delivery.verification === 'failed' ? '未通过' : '未运行'} · 变更代次 {delivery.generation}</p>
          <p>{delivery.verificationReason}</p>
          {delivery.files.map((file) => <p key={file.path}><code>{file.path}</code> · {file.status === 'current' ? '哈希一致' : file.status === 'conflict' ? '内容冲突' : '状态未知'}</p>)}
          {delivery.evidence.map((evidence) => <details key={evidence.id}>
            <summary>验证记录 · 退出码 {evidence.exitCode ?? '未知'}</summary>
            <pre style={{ ...wrap, whiteSpace: 'pre-wrap', maxHeight: 180, overflowY: 'auto' }}>{evidence.command}{'\n'}{evidence.output}</pre>
          </details>)}
          {delivery.risks.map((risk) => <p key={risk}>{risk}</p>)}
        </div>}
      </div>}
      {error && <p className="knowledge-error" role="alert" style={wrap}>{error}</p>}
    </div>
  </section>;
}
