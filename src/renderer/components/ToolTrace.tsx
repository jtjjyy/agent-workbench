import { CircleAlert, CircleCheck, CircleHelp, FilePenLine, FileText, LoaderCircle, Search, FolderTree, Wrench } from 'lucide-react';
import { useMemo } from 'react';
import type { EventEnvelope } from '../../shared/contracts';
import type { ReadonlyToolName } from '../../shared/workspace';
import type { EditOutcomeStatus } from '../../shared/file-edit';

type ToolStartedEvent = Extract<EventEnvelope, { type: 'tool.started' }>;
type ToolCompletedEvent = Extract<EventEnvelope, { type: 'tool.completed' }>;

interface ToolEntry {
  key: string;
  runId: string;
  toolCallId: string;
  sequence: number;
  started?: ToolStartedEvent;
  completed?: ToolCompletedEvent;
}

const TOOL_NAMES: Record<ReadonlyToolName | 'replace_text' | 'search_knowledge' | 'read_project_knowledge' | 'run_powershell' | 'web_search' | 'web_fetch' | 'browser_open' | 'browser_read' | 'browser_screenshot' | 'browser_click' | 'browser_type' | 'unknown', string> = {
  run_powershell: '执行 PowerShell', web_search: '搜索网页', web_fetch: '读取网页',
  browser_open: '打开网页', browser_read: '读取页面', browser_screenshot: '页面截图',
  browser_click: '点击页面元素', browser_type: '输入页面文本',
  list_files: '列出文件',
  read_file: '读取文件',
  search_text: '搜索文本',
  replace_text: '替换文本',
  unknown: '未知工具',
  search_knowledge: '检索项目知识',
  read_project_knowledge: '读取项目知识摘要',
};

const TOOL_ICONS = { list_files: FolderTree, read_file: FileText, search_text: Search,
  replace_text: FilePenLine, search_knowledge: FileText, read_project_knowledge: FolderTree,
  run_powershell: Wrench, web_search: Search, web_fetch: FileText, browser_open: FolderTree,
  browser_read: FileText, browser_screenshot: FileText, browser_click: Wrench, browser_type: Wrench, unknown: Wrench };

const EDIT_STATUS: Record<EditOutcomeStatus, string> = {
  applied: '已写入', rejected: '已拒绝', expired: '已到期', cancelled: '已取消',
  conflict: '文件冲突，未写入', failed: '写入失败', unknown: '结果未确认',
};

type FileEditEvent = EventEnvelope<'approval.requested' | 'approval.decided' | 'file.edit.started' | 'file.edit.completed'>;

interface FileEditEntry {
  key: string;
  sequence: number;
  identity: FileEditEvent['payload'];
  requested?: EventEnvelope<'approval.requested'>;
  decided?: EventEnvelope<'approval.decided'>;
  started?: EventEnvelope<'file.edit.started'>;
  completed?: EventEnvelope<'file.edit.completed'>;
}

function FileEditTrace({ events }: { events: EventEnvelope[] }) {
  const entries = useMemo(() => {
    const edits = new Map<string, FileEditEntry>();
    for (const event of events) {
      if (event.type !== 'approval.requested' && event.type !== 'approval.decided'
        && event.type !== 'file.edit.started' && event.type !== 'file.edit.completed') continue;
      const { runId, toolCallId, approvalId, bindingDigest } = event.payload;
      const key = JSON.stringify([event.conversationId, runId, toolCallId, approvalId, bindingDigest]);
      const entry: FileEditEntry = edits.get(key) ?? { key, sequence: event.sequence, identity: event.payload };
      entry.sequence = Math.min(entry.sequence, event.sequence);
      if (event.type === 'approval.requested') entry.requested = event;
      if (event.type === 'approval.decided') entry.decided = event;
      if (event.type === 'file.edit.started') entry.started = event;
      if (event.type === 'file.edit.completed') entry.completed = event;
      edits.set(key, entry);
    }
    return [...edits.values()].sort((left, right) => left.sequence - right.sequence);
  }, [events]);

  if (!entries.length) return null;
  return <section className="file-edit-trace" aria-label="文件修改轨迹">
    <h3>文件修改轨迹</h3>
    <ol className="tool-list">{entries.map((entry) => {
      const decision = entry.decided?.payload.decision;
      const status = entry.completed ? EDIT_STATUS[entry.completed.payload.status]
        : entry.started ? '结果未确认' : decision === 'approved' ? '已批准，等待写入'
          : decision === 'rejected' ? '已拒绝' : decision === 'expired' ? '已到期'
            : decision === 'cancelled' ? '已取消' : '审批结果未确认';
      const successful = entry.completed?.payload.status === 'applied';
      const uncertain = entry.started && (!entry.completed || entry.completed.payload.status === 'unknown')
        || entry.completed?.payload.status === 'failed';
      const Icon = successful ? CircleCheck : uncertain ? CircleHelp : CircleAlert;
      return <li className="tool-entry" key={entry.key}>
        <header className="tool-entry-header"><h3><FilePenLine size={15} aria-hidden="true" />替换文本</h3>
          <span className="tool-status"><Icon size={13} aria-hidden="true" />{status}</span></header>
        <p className="tool-summary"><code>{entry.identity.path}</code></p>
        {uncertain && <p className="tool-unconfirmed">写入结果未确认，请检查文件。取消或任务结束不代表已回滚。</p>}
        <details className="tool-details"><summary title="查看文件修改身份与哈希">修改身份与哈希</summary>
          <dl className="tool-identifiers">
            <dt>任务</dt><dd><code>{entry.identity.runId}</code></dd>
            <dt>调用</dt><dd><code>{entry.identity.toolCallId}</code></dd>
            <dt>审批</dt><dd><code>{entry.identity.approvalId}</code></dd>
            <dt>修改前 SHA-256</dt><dd><code>{entry.identity.beforeSha256}</code></dd>
            <dt>修改后 SHA-256</dt><dd><code>{entry.identity.afterSha256}</code></dd>
          </dl>
        </details>
      </li>;
    })}</ol>
  </section>;
}

export function ToolTrace({ events }: { events: EventEnvelope[] }) {
  const { entries, terminalRuns, completedRuns, attachedWorkspaces } = useMemo(() => {
    const tools = new Map<string, ToolEntry>();
    const terminalRuns = new Map<string, 'failed' | 'completed'>();
    const completedRuns = new Map<string, EventEnvelope<'run.completed'>>();
    const attachedWorkspaces = new Map<string, boolean>();
    for (const event of events) {
      if (event.type === 'run.started' && typeof event.payload.workspaceAttached === 'boolean') {
        attachedWorkspaces.set(event.payload.runId, event.payload.workspaceAttached);
      }
      if (event.type === 'run.failed' || event.type === 'run.completed') {
        terminalRuns.set(event.payload.runId, event.type === 'run.failed' ? 'failed' : 'completed');
      }
      if (event.type === 'run.completed') completedRuns.set(event.payload.runId, event);
      if (event.type !== 'tool.started' && event.type !== 'tool.completed') continue;
      const { runId, toolCallId } = event.payload;
      const key = JSON.stringify([runId, toolCallId]);
      const entry: ToolEntry = tools.get(key) ?? { key, runId, toolCallId, sequence: event.sequence };
      entry.sequence = Math.min(entry.sequence, event.sequence);
      if (event.type === 'tool.started') entry.started = event;
      else entry.completed = event;
      tools.set(key, entry);
    }
    return {
      entries: [...tools.values()].sort((a, b) => a.sequence - b.sequence),
      terminalRuns,
      completedRuns: [...completedRuns.values()].filter((event) =>
        event.payload.modelRequestCount !== undefined || event.payload.toolCallCount !== undefined)
        .sort((a, b) => a.sequence - b.sequence),
      attachedWorkspaces,
    };
  }, [events]);

  return (
    <section className="tool-trace" aria-label="工具轨迹">
      <header className="section-header">
        <h2><Wrench size={15} aria-hidden="true" />工具轨迹</h2>
        <span className="event-count" aria-label={`${entries.length} 次工具调用`}>{entries.length}</span>
      </header>
      <p className="tool-evidence-notice">来源证据是工具读取时的快照，不代表当前文件。
        模型文本中的引用不自动视为已验证证据。</p>
      {entries.length === 0 ? <p className="trace-empty">暂无工具调用</p> : <ol className="tool-list">
        {entries.map((entry) => {
          const payload = entry.completed?.payload ?? entry.started?.payload;
          if (!payload) return null;
          const terminal = terminalRuns.get(entry.runId);
          const isError = entry.completed?.payload.isError === true;
          const status = entry.completed ? isError ? '失败' : '已完成'
            : terminal === 'failed' ? '结果未确认' : terminal === 'completed' ? '未确认' : '执行中';
          const tone = isError ? 'failed'
            : entry.completed ? 'completed' : terminal ? 'unconfirmed' : 'running';
          const ToolIcon = TOOL_ICONS[payload.toolName] ?? Wrench;
          const StatusIcon = tone === 'failed' ? CircleAlert : tone === 'completed' ? CircleCheck
            : tone === 'unconfirmed' ? CircleHelp : LoaderCircle;
          const sources = entry.completed?.payload.sources ?? [];
          const durationMs = entry.completed?.payload.durationMs;
          const hasDuration = typeof durationMs === 'number' && Number.isFinite(durationMs) && durationMs >= 0;

          return (
            <li className={`tool-entry tool-${tone}`} key={entry.key}>
              <header className="tool-entry-header">
                <h3><ToolIcon size={15} aria-hidden="true" />{TOOL_NAMES[payload.toolName] ?? '未知工具'}</h3>
                <span className="tool-status"><StatusIcon size={13} aria-hidden="true" />{status}</span>
              </header>
              <p className="tool-summary">{payload.summary}</p>
              <p className="tool-duration">{hasDuration ? `耗时 ${durationMs} 毫秒`
                : !entry.completed && !terminal ? '耗时待确认' : '耗时未确认'}</p>
              {!entry.completed && terminal && <p className="tool-unconfirmed">
                {terminal === 'failed' ? '任务已结束，未收到工具完成事件，工具结果未确认。'
                  : '任务已完成，但未收到此工具的完成事件，结果未确认。'}
              </p>}
              <details className="tool-details">
                <summary title="查看工具调用及来源快照" aria-label="查看工具调用及来源快照">
                  调用详情与来源快照（{sources.length}）
                </summary>
                <dl className="tool-identifiers">
                  <dt>任务</dt><dd><code>{entry.runId}</code></dd>
                  <dt>调用</dt><dd><code>{entry.toolCallId}</code></dd>
                </dl>
                {sources.length === 0 ? <p className="tool-no-sources">无来源证据记录</p>
                  : <ol className="source-list">{sources.map((source, index) => (
                    <li className="source-entry" key={JSON.stringify([source.path, source.startLine, source.endLine, source.sha256, index])}>
                      <p className="source-location"><FileText size={13} aria-hidden="true" />
                        <code>{source.path}:{source.startLine}-{source.endLine}</code></p>
                      <dl className="source-digest"><dt>SHA-256</dt><dd><code>{source.sha256}</code></dd></dl>
                      <pre className="source-excerpt" aria-label="读取时的来源片段">{source.excerpt}</pre>
                    </li>
                  ))}</ol>}
              </details>
            </li>
          );
        })}
      </ol>}
      <FileEditTrace events={events} />
      {completedRuns.length > 0 && <section className="tool-run-summaries" aria-label="任务完成摘要">
        <h3>任务完成摘要</h3>
        <ol className="tool-run-list">{completedRuns.map((event) => {
          const { runId, modelRequestCount, toolCallCount } = event.payload;
          const workspaceAttached = attachedWorkspaces.get(runId);
          return <li className="tool-run-summary" key={runId}>
            <p className="tool-run-id"><CircleCheck size={13} aria-hidden="true" />
              <span>已完成</span><code>{runId}</code></p>
            <dl className="tool-run-counts">
              {modelRequestCount !== undefined && <><dt>模型请求</dt><dd>{modelRequestCount} 次</dd></>}
              {toolCallCount !== undefined && <><dt>工具调用</dt><dd>{toolCallCount} 次</dd></>}
            </dl>
            {workspaceAttached !== undefined && <p className="tool-run-workspace">
              {workspaceAttached ? '运行时已附加工作区' : '运行时未附加工作区'}
            </p>}
          </li>;
        })}</ol>
      </section>}
    </section>
  );
}
