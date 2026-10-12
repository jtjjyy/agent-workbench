import { Bot, CircleAlert, RotateCcw, Settings, User } from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { DEFAULT_CONVERSATION_ID, type EventEnvelope, type SubmitMessageRequest } from '../../shared/contracts';
import type { ModelSettingsResult, PublicModelSettings, SaveModelSettingsRequest } from '../../shared/model-settings';
import { APP_DISPLAY_NAME, runErrorText, settingsErrorText } from '../../shared/zh-CN';
import { conversationReducer, createConversationState } from '../state/conversation-reducer';
import { Composer } from './Composer';
import { EventTrace } from './EventTrace';
import { FileEditReview } from './FileEditReview';
import { ModelSettingsDialog } from './ModelSettingsDialog';
import { ToolTrace } from './ToolTrace';
import { WorkspaceBar } from './WorkspaceBar';
import { KnowledgePanel } from './KnowledgePanel';
import { SkillsPanel } from './SkillsPanel';
import { CommandApproval } from './CommandApproval';

export function App() {
  const [state, setState] = useState(createConversationState);
  const [text, setText] = useState('');
  const [loading, setLoading] = useState(true);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [runtimeUnavailable, setRuntimeUnavailable] = useState(false);
  const [pending, setPending] = useState(false);
  const [reload, setReload] = useState(0);
  const [settings, setSettings] = useState<PublicModelSettings | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsLoading, setSettingsLoading] = useState(true);
  const [settingsReadError, setSettingsReadError] = useState<string | null>(null);
  const [settingsBusy, setSettingsBusy] = useState(false);
  const [workspaceBusy, setWorkspaceBusy] = useState(false);
  const [awaitingApproval, setAwaitingApproval] = useState(false);
  const [awaitingCommandApproval, setAwaitingCommandApproval] = useState(false);
  const [cancellingRunId, setCancellingRunId] = useState<string | null>(null);
  const pendingRequest = useRef<SubmitMessageRequest | null>(null);
  const settingsMutation = useRef(false);
  const workspaceMutation = useRef(false);
  const settingsVisible = useRef(false);
  const cancelRequest = useRef<string | null>(null);
  const latestState = useRef(state);
  latestState.current = state;
  const mounted = useRef(false);
  const transcriptRef = useRef<HTMLDivElement>(null);
  const tracePanelRef = useRef<HTMLElement>(null);
  const followsTail = useRef(true);
  const traceFollowsTail = useRef(true);
  const bridge = window.agent;

  useLayoutEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const onWorkspaceBusyChange = useCallback((busy: boolean) => {
    if (busy && (pendingRequest.current || settingsMutation.current || settingsVisible.current
      || latestState.current.activeRunId)) {
      throw new Error('当前请求、任务或模型设置尚未结束。');
    }
    workspaceMutation.current = busy;
    if (mounted.current) setWorkspaceBusy(busy);
  }, []);

  useEffect(() => {
    let disposed = false;
    setSettingsLoading(true);
    setSettingsReadError(null);
    async function readSettings() {
      try {
        if (!bridge || typeof bridge.readModelSettings !== 'function') throw new Error();
        const restored = await bridge.readModelSettings();
        if (!disposed) setSettings(restored);
      } catch {
        if (!disposed) setSettingsReadError(settingsErrorText('SETTINGS_READ_FAILED'));
      } finally {
        if (!disposed) setSettingsLoading(false);
      }
    }
    void readSettings();
    return () => { disposed = true; };
  }, [bridge, settingsOpen]);

  useEffect(() => {
    let disposed = false;
    let phase: 'loading' | 'live' | 'failed' = 'loading';
    let unsubscribe: (() => void) | undefined;
    const buffered: EventEnvelope[] = [];
    setLoading(true);
    setHistoryError(null);

    async function restore() {
      if (!bridge) {
        setHistoryError('桌面连接不可用。');
        setLoading(false);
        return;
      }
      try {
        // Subscribe first: history may overlap events delivered during the read.
        unsubscribe = bridge.onEvent((event) => {
          if (disposed || phase === 'failed') return;
          if (phase === 'loading') buffered.push(event);
          else {
            const next = conversationReducer(latestState.current, event);
            latestState.current = next;
            setState(next);
          }
        });
        const history = await bridge.readConversation(DEFAULT_CONVERSATION_ID);
        if (disposed) return;
        const ordered = [...history, ...buffered].sort((a, b) => a.sequence - b.sequence);
        const restored = ordered.reduce(conversationReducer, createConversationState());
        buffered.length = 0;
        phase = 'live';
        latestState.current = restored;
        setState(restored);
        setLoading(false);
      } catch {
        if (disposed) return;
        phase = 'failed';
        buffered.length = 0;
        setHistoryError('无法加载会话。');
        setLoading(false);
      }
    }
    void restore();
    return () => {
      disposed = true;
      buffered.length = 0;
      unsubscribe?.();
    };
  }, [bridge, reload]);

  useEffect(() => {
    if (transcriptRef.current && followsTail.current) {
      transcriptRef.current.scrollTop = transcriptRef.current.scrollHeight;
    }
  }, [state.messages, awaitingApproval, awaitingCommandApproval]);

  useEffect(() => {
    if (tracePanelRef.current && traceFollowsTail.current) {
      tracePanelRef.current.scrollTop = tracePanelRef.current.scrollHeight;
    }
  }, [state.events]);

  useEffect(() => {
    if (cancellingRunId && state.activeRunId !== cancellingRunId) {
      cancelRequest.current = null;
      setCancellingRunId(null);
    }
  }, [state.activeRunId, cancellingRunId]);

  const configurationError = settingsReadError || (settings?.configurationError
    ? settingsErrorText(settings.configurationError) : null);
  const disabled = runtimeUnavailable || !bridge || loading || !!historyError || state.reloadRequired
    || !!state.activeRunId || pending || settingsBusy || workspaceBusy || settingsOpen || settingsLoading || !settings
    || !!configurationError;
  const error = runtimeUnavailable
    ? runErrorText('JOURNAL_WRITE_FAILED')
    : historyError || submitError || state.error || configurationError;
  const status = runtimeUnavailable ? '不可用' : !bridge ? '未连接' : loading || settingsLoading ? '加载中'
    : historyError ? '不可用' : state.reloadRequired ? '需要重新加载'
      : cancellingRunId && state.activeRunId === cancellingRunId ? '取消中'
        : state.activeRunId ? (awaitingApproval || awaitingCommandApproval ? '待审批' : '运行中') : pending ? '发送中' : workspaceBusy ? '工作区处理中'
          : configurationError ? '设置不可用' : '就绪';
  const actualProvider = state.activeRunId ? state.runProvider : settings?.provider;
  const actualModel = state.activeRunId ? state.runModel : settings?.provider === 'deepseek' ? settings.model : undefined;
  const providerLabel = actualProvider === 'mock' ? '本地模拟'
    : actualProvider === 'deepseek' ? 'DeepSeek' : '未知提供方';
  const settingsBlocked = pending || !!state.activeRunId || workspaceBusy || runtimeUnavailable || loading
    || !!historyError || state.reloadRequired || !bridge;
  const workspaceBlocked = pending || !!state.activeRunId || settingsBusy || settingsOpen || settingsLoading
    || runtimeUnavailable || loading || !!historyError || state.reloadRequired || !bridge;
  const canCancel = !!bridge && typeof bridge.cancelRun === 'function' && !runtimeUnavailable
    && !loading && !historyError && !state.reloadRequired;
  const approvalBlocked = !bridge || runtimeUnavailable || loading || !!historyError || state.reloadRequired
    || settingsBusy || workspaceBusy || settingsOpen || (cancellingRunId === state.activeRunId && !!cancellingRunId);

  async function changeSettings(request?: SaveModelSettingsRequest): Promise<ModelSettingsResult> {
    if (pendingRequest.current || latestState.current.activeRunId || settingsMutation.current || workspaceMutation.current) {
      return { ok: false, code: 'RUN_ACTIVE' };
    }
    if (!bridge || settingsBlocked) return { ok: false, code: 'SETTINGS_WRITE_FAILED' };
    settingsMutation.current = true;
    setSettingsBusy(true);
    try {
      const result = request
        ? await bridge.saveModelSettings(request)
        : await bridge.deleteModelApiKey();
      if (mounted.current && result.ok) {
        setSettings(result.settings);
        setSettingsReadError(null);
      }
      return result;
    } catch {
      return { ok: false, code: 'SETTINGS_WRITE_FAILED' };
    } finally {
      settingsMutation.current = false;
      if (mounted.current) setSettingsBusy(false);
    }
  }

  async function cancel(runId: string) {
    if (!bridge || !canCancel || cancelRequest.current || latestState.current.activeRunId !== runId) return;
    const conversationId = latestState.current.conversationId;
    cancelRequest.current = runId;
    setCancellingRunId(runId);
    setSubmitError(null);
    try {
      const result = await bridge.cancelRun({ conversationId, runId });
      if (mounted.current && latestState.current.activeRunId === runId && !result.cancelled) {
        cancelRequest.current = null;
        setCancellingRunId(null);
        setSubmitError('无法取消当前任务，请重试。');
      }
      // An acknowledgement is not termination; only the matching journal event unlocks the composer.
    } catch {
      if (mounted.current && latestState.current.activeRunId === runId) {
        cancelRequest.current = null;
        setCancellingRunId(null);
        setSubmitError('无法取消当前任务，请重试。');
      }
    }
  }

  async function submit() {
    if (!bridge || disabled || pendingRequest.current || settingsMutation.current || workspaceMutation.current
      || settingsVisible.current || latestState.current.activeRunId || !text.trim()) return;
    const request: SubmitMessageRequest = {
      conversationId: DEFAULT_CONVERSATION_ID,
      clientRequestId: crypto.randomUUID(),
      text: text.trim(),
    };
    pendingRequest.current = request;
    setPending(true);
    setSubmitError(null);
    try {
      const result = await bridge.submitMessage(request);
      if (mounted.current) {
        if (result?.status === 'unavailable') setRuntimeUnavailable(true);
        else setText('');
      }
    } catch {
      if (mounted.current) setSubmitError('无法发送消息。');
    } finally {
      pendingRequest.current = null;
      if (mounted.current) setPending(false);
    }
  }

  return (
    <main className="workbench">
      <header className="workbench-header">
        <h1>{APP_DISPLAY_NAME}</h1>
        <span className="provider-label">{providerLabel}{actualModel ? ` / ${actualModel}`
          : actualProvider === 'deepseek' ? ' / 未知模型' : ''}</span>
        <span role="status" className={`connection-status${status === '运行中' || status === '待审批' ? ' is-running' : ''}`}>
          <span className="status-marker" aria-hidden="true" />{status}
        </span>
        <button className="icon-button" type="button" aria-label="模型设置" title="模型设置"
          disabled={!bridge || workspaceBusy} onClick={() => {
            if (workspaceMutation.current) return;
            settingsVisible.current = true;
            setSettingsOpen(true);
          }}>
          <Settings size={18} aria-hidden="true" />
        </button>
      </header>
      <WorkspaceBar bridge={bridge} blocked={workspaceBlocked}
        networkAuthorized={settings?.provider === 'deepseek' && settings.dataEgressConsent === true}
        onBusyChange={onWorkspaceBusyChange} />
      <div className="workbench-body">
        <section className="conversation" aria-label="会话">
          <header className="section-header"><h2>会话</h2></header>
          <div className="transcript" ref={transcriptRef} tabIndex={0} onScroll={(event) => {
            const transcript = event.currentTarget;
            followsTail.current = transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 48;
          }}>
            {state.messages.map((message) => (
              <article className={`message message-${message.role}`} key={message.messageId}
                aria-label={message.role === 'user' ? '你的消息' : '智能体消息'}>
                <header className="message-header">
                  {message.role === 'user'
                    ? <User size={15} aria-hidden="true" />
                    : <Bot size={15} aria-hidden="true" />}
                  <span>{message.role === 'user' ? '你' : '智能体'}</span>
                  {message.status === 'streaming' && (
                    <span className="message-status">{runtimeUnavailable ? '已停止' : '生成中'}</span>
                  )}
                  {message.status === 'failed' && <span className="message-failed">失败</span>}
                  {message.status === 'cancelled' && <span className="message-status">已取消</span>}
                </header>
                <p className="message-text">{message.text}</p>
                {message.role === 'agent' && message.status === 'complete' && (
                  <p className="message-usage">
                    {message.usage
                      ? `词元用量：输入 ${message.usage.inputTokens}，输出 ${message.usage.outputTokens}，缓存读取 ${message.usage.cacheReadTokens}，总计 ${message.usage.totalTokens}`
                      : '词元用量未知'}
                    {message.stopReason === 'length' && <span>已达到输出上限</span>}
                  </p>
                )}
              </article>
            ))}
            <FileEditReview bridge={bridge} events={state.events} conversationId={state.conversationId}
              activeRunId={state.activeRunId} blocked={approvalBlocked} reloadKey={reload}
              onPendingChange={setAwaitingApproval} />
            <CommandApproval bridge={bridge} events={state.events} activeRunId={state.activeRunId}
              blocked={approvalBlocked} onPendingChange={setAwaitingCommandApproval} />
          </div>
          {error && (
            <div className="error-row">
              <CircleAlert size={16} aria-hidden="true" />
              <p role="alert">{error}</p>
              {!runtimeUnavailable && bridge && (historyError || state.reloadRequired) && (
                <button className="icon-button" type="button" aria-label="重新加载会话"
                  title="重新加载会话" disabled={pending || loading || workspaceBusy || settingsBusy}
                  onClick={() => { setSubmitError(null); setReload((value) => value + 1); }}>
                  <RotateCcw size={16} aria-hidden="true" />
                </button>
              )}
            </div>
          )}
          <Composer text={text} disabled={disabled} onChange={setText} onSubmit={() => { void submit(); }}
            activeRunId={state.activeRunId} cancelling={cancellingRunId === state.activeRunId && !!cancellingRunId}
            canCancel={canCancel} onCancel={(runId) => { void cancel(runId); }} />
        </section>
        <aside className="trace-panel" aria-label="运行轨迹" tabIndex={0} ref={tracePanelRef}
          onScroll={(event) => {
            const panel = event.currentTarget;
            traceFollowsTail.current = panel.scrollHeight - panel.scrollTop - panel.clientHeight < 48;
          }}>
          <KnowledgePanel bridge={bridge} blocked={workspaceBusy || !!state.activeRunId || settingsOpen || loading || !!historyError} />
          <SkillsPanel bridge={bridge} blocked={workspaceBusy || !!state.activeRunId || settingsOpen || loading || !!historyError} />
          <ToolTrace events={state.events} />
          <EventTrace events={state.events} />
        </aside>
      </div>
      {settingsOpen && <ModelSettingsDialog settings={settings} loading={settingsLoading}
        readError={settingsReadError} blocked={settingsBlocked} onSave={(request) => changeSettings(request)}
        onDeleteKey={() => changeSettings()} onClose={() => {
          settingsVisible.current = false;
          setSettingsOpen(false);
        }} />}
    </main>
  );
}
