import { CircleAlert, FolderOpen, FolderX, RotateCcw } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import type { AgentBridge } from '../../shared/contracts';
import type { WorkspaceResult, WorkspaceState } from '../../shared/workspace';

interface WorkspaceBarProps {
  bridge: AgentBridge | undefined;
  blocked: boolean;
  networkAuthorized: boolean;
  onBusyChange: (busy: boolean) => void;
}

interface WorkspaceSession {
  active: boolean;
  busy: boolean;
}

function isWorkspaceState(value: unknown): value is WorkspaceState {
  if (!value || typeof value !== 'object') return false;
  const workspace = value as Partial<WorkspaceState>;
  return typeof workspace.dataEgressConsent === 'boolean'
    && (workspace.root === null || typeof workspace.root === 'string')
    && (workspace.name === null || typeof workspace.name === 'string');
}

function workspaceErrorText(code: string): string {
  switch (code) {
    case 'RUN_ACTIVE': return '请等待当前请求或任务结束后再修改工作区。';
    case 'WORKSPACE_UNAVAILABLE': return '工作区目录不可用，请重新选择目录。';
    case 'INVALID_WORKSPACE_COMMAND': return '工作区操作无效，请重新选择目录后重试。';
    default: return '无法更新工作区，请稍后重试。';
  }
}

export function WorkspaceBar({ bridge, blocked, networkAuthorized, onBusyChange }: WorkspaceBarProps) {
  const [workspace, setWorkspace] = useState<WorkspaceState | null>(null);
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState(false);
  const [readFailed, setReadFailed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const sessionRef = useRef<WorkspaceSession | null>(null);
  const consentRef = useRef<HTMLInputElement>(null);
  const mutating = useRef(false);
  const blockedRef = useRef(blocked);
  const busyCallback = useRef(onBusyChange);
  blockedRef.current = blocked;
  busyCallback.current = onBusyChange;
  const privacyId = useId();
  const statusId = useId();

  useEffect(() => {
    if (consentRef.current) consentRef.current.indeterminate = readFailed;
  }, [readFailed]);

  useEffect(() => {
    const session: WorkspaceSession = { active: true, busy: false };
    sessionRef.current = session;
    setLoading(true);
    setWorking(false);
    setReadFailed(false);
    setError(null);
    setWorkspace(null);

    async function readWorkspace() {
      try {
        busyCallback.current(true);
        session.busy = true;
        if (!bridge || typeof bridge.readWorkspace !== 'function') {
          if (session.active) {
            setReadFailed(true);
            setError('桌面工作区连接不可用，请重启工作台后重试。');
          }
          return;
        }
        const restored = await bridge.readWorkspace();
        if (!session.active) return;
        if (!isWorkspaceState(restored)) throw new Error();
        setWorkspace(restored);
      } catch {
        if (session.active) {
          setReadFailed(true);
          setError('无法读取工作区状态，请重新读取后重试。');
        }
      } finally {
        if (session.active) {
          setLoading(false);
          if (session.busy) {
            session.busy = false;
            busyCallback.current(false);
          }
        }
      }
    }

    void readWorkspace();
    return () => {
      session.active = false;
      mutating.current = false;
      if (session.busy) {
        session.busy = false;
        busyCallback.current(false);
      }
      if (sessionRef.current === session) sessionRef.current = null;
    };
  }, [bridge, reload]);

  async function mutate(action: 'choose' | 'clear' | 'consent', consent?: boolean) {
    const session = sessionRef.current;
    if (!session?.active || session.busy || mutating.current || loading || readFailed) return;
    if (blockedRef.current) {
      setError('请求、任务或模型设置处理期间，无法修改工作区。');
      return;
    }
    if (!bridge || typeof bridge.chooseWorkspace !== 'function'
      || typeof bridge.clearWorkspace !== 'function' || typeof bridge.setWorkspaceConsent !== 'function') {
      setError('桌面工作区连接不可用，请重启工作台后重试。');
      return;
    }
    if (action !== 'choose' && !workspace?.root) return;
    mutating.current = true;
    setWorking(true);
    setError(null);
    let acquired = false;
    try {
      // 先取得父组件的同步锁，再向主进程发送命令。
      busyCallback.current(true);
      acquired = true;
      session.busy = true;
      let result: WorkspaceResult;
      if (action === 'choose') result = await bridge.chooseWorkspace();
      else if (action === 'clear') result = await bridge.clearWorkspace();
      else result = await bridge.setWorkspaceConsent({ dataEgressConsent: consent === true });
      if (!session.active) return;
      if (result.ok) setWorkspace(result.workspace);
      else {
        const failureMessage = workspaceErrorText(result.code);
        setError(failureMessage);
        setReadFailed(true);
        try {
          if (typeof bridge.readWorkspace !== 'function') throw new Error();
          const restored = await bridge.readWorkspace();
          if (!session.active) return;
          if (!isWorkspaceState(restored)) throw new Error();
          setWorkspace(restored);
          setReadFailed(false);
        } catch {
          if (session.active) {
            setReadFailed(true);
            setError(`${failureMessage} 无法重新读取工作区状态，当前目录和授权状态未确认，请重新读取。`);
          }
        }
      }
    } catch {
      if (session.active) {
        if (acquired) setReadFailed(true);
        setError(acquired
          ? '无法确认工作区更新结果，界面保留上次确认的状态，请重新读取。'
          : '请求、任务或模型设置处理期间，无法修改工作区。');
      }
    } finally {
      if (session.active) {
        mutating.current = false;
        setWorking(false);
        if (session.busy) {
          session.busy = false;
          busyCallback.current(false);
        }
      }
    }
  }

  const locked = blocked || loading || working || readFailed || !bridge;
  const status = loading ? '正在读取工作区...'
    : working ? '正在更新工作区...'
      : readFailed ? '工作区状态未确认'
        : workspace?.root && workspace.dataEgressConsent ? '工作区工具已授权'
          : networkAuthorized ? '联网工具已授权，工作区工具未启用'
          : '未授权：可聊天，工作区工具已关闭';

  return (
    <section className="workspace-bar" aria-label="工作区" aria-busy={loading || working}>
      <div className="workspace-row">
        <h2><FolderOpen size={16} aria-hidden="true" />工作区</h2>
        <div className="workspace-location">
          <span className="workspace-name">{readFailed && !workspace ? '目录与授权状态未确认'
            : workspace?.name || (workspace?.root ? '当前目录' : '未选择目录')}
            {readFailed && workspace && '（上次确认）'}</span>
          {workspace?.root && <code className="workspace-root" title={workspace.root}>{workspace.root}</code>}
        </div>
        <div className="workspace-actions">
          <button className="icon-button" type="button" aria-label="选择工作区目录" title="选择工作区目录"
            disabled={locked} onClick={() => { void mutate('choose'); }}>
            <FolderOpen size={17} aria-hidden="true" />
          </button>
          <button className="icon-button" type="button" aria-label="撤销工作区及授权" title="撤销工作区及授权"
            disabled={locked || !workspace?.root} onClick={() => { void mutate('clear'); }}>
            <FolderX size={17} aria-hidden="true" />
          </button>
          {readFailed && <button className="icon-button" type="button" aria-label="重新读取工作区"
            title="重新读取工作区" disabled={blocked || loading || working || !bridge}
            onClick={() => setReload((value) => value + 1)}>
            <RotateCcw size={16} aria-hidden="true" />
          </button>}
        </div>
      </div>
      <div className="workspace-consent-row">
        <label className="workspace-consent">
          <input type="checkbox" ref={consentRef} checked={!readFailed && workspace?.dataEgressConsent === true}
            disabled={locked || !workspace?.root} aria-checked={readFailed ? 'mixed' : workspace?.dataEgressConsent === true}
            aria-describedby={`${privacyId} ${statusId}`} title={readFailed ? '工作区授权状态未确认' : '同意工作区数据外发'}
            onChange={(event) => { void mutate('consent', event.target.checked); }} />
          <span>同意工作区数据外发</span>
        </label>
        <span className="workspace-status" id={statusId} role="status">{status}</span>
      </div>
      <p className="workspace-privacy" id={privacyId}>工作区工具读取的文件名、路径、内容及工具结果，以及联网工具读取的网页内容，可能发送给 DeepSeek；
        未选择工作区时不会读取本地文件。本地日志不保存 API 密钥。</p>
      {error && <div className="workspace-error"><CircleAlert size={15} aria-hidden="true" />
        <p role="alert">{error}</p></div>}
    </section>
  );
}
