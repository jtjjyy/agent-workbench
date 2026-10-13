import { useEffect, useRef, useState } from 'react';
import { Archive, Check, Download, Monitor, RefreshCw, Settings, Upload } from 'lucide-react';
import {
  DESKTOP_DATA_SCOPES, DESKTOP_ERROR_MESSAGES, DESKTOP_SCOPE_LABELS,
  type DesktopBridge, type DesktopDataScope, type DesktopInfo, type DesktopResult,
} from '../../shared/desktop';

export interface DesktopPanelProps {
  bridge?: DesktopBridge;
  blocked: boolean;
  onOpenModelSettings?: () => void;
  reloadKey?: string | number;
  onBusyChange?: (busy: boolean) => void;
  onRestartRequired?: () => void;
}

const migrationLabels: Record<DesktopInfo['migration']['status'], string> = {
  none: '无需迁移', migrated: '旧数据已迁移，原目录与备份保留',
  'skipped-existing': '已使用现有数据，未覆盖', failed: '迁移失败，旧数据保留',
};

export function DesktopPanel({ bridge, blocked, onOpenModelSettings, reloadKey,
  onBusyChange, onRestartRequired }: DesktopPanelProps) {
  const [info, setInfo] = useState<DesktopInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [scopes, setScopes] = useState<DesktopDataScope[]>([...DESKTOP_DATA_SCOPES]);
  const working = useRef(false);
  const readSequence = useRef(0);
  const locked = !bridge || busy || blocked || !info?.initialized || Boolean(info?.restartRequired);

  useEffect(() => {
    const sequence = ++readSequence.current;
    setInfo(null);
    setError(null);
    if (bridge) void bridge.readDesktopInfo().then((value) => {
      if (sequence === readSequence.current) setInfo(value);
    }, () => { if (sequence === readSequence.current) setError('无法读取桌面交付状态，请重试。'); });
    return () => { ++readSequence.current; };
  }, [bridge, reloadKey]);

  useEffect(() => { onBusyChange?.(busy); }, [busy, onBusyChange]);
  useEffect(() => { if (info?.restartRequired) onRestartRequired?.(); }, [info?.restartRequired, onRestartRequired]);

  async function refresh() {
    if (!bridge || working.current) return;
    working.current = true;
    const sequence = ++readSequence.current;
    setBusy(true);
    setError(null);
    try {
      const value = await bridge.readDesktopInfo();
      if (sequence === readSequence.current) setInfo(value);
    }
    catch { if (sequence === readSequence.current) setError('无法读取桌面交付状态，请重试。'); }
    finally { working.current = false; setBusy(false); }
  }

  async function perform(action: 'setup' | 'diagnostics' | 'backup' | 'restore') {
    if (!bridge || working.current || (action !== 'diagnostics' && locked)) return;
    working.current = true;
    const sequence = ++readSequence.current;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result: DesktopResult = action === 'setup' ? await bridge.completeSetup()
        : action === 'diagnostics' ? await bridge.exportDiagnostics()
          : action === 'backup' ? await bridge.backupDesktop({ scopes: [...scopes] })
            : await bridge.restoreDesktop();
      if (result.ok) {
        if (result.info.restartRequired) onRestartRequired?.();
        if (sequence !== readSequence.current) return;
        setInfo(result.info);
        setNotice(action === 'setup' ? (result.info.setupMode === 'mock'
          ? '首次配置已保存，当前使用本地模拟。' : '首次配置已保存，尚未验证真实模型请求。')
          : action === 'restore' ? `数据已恢复，请关闭所有客户端窗口后重新启动。恢复前备份：${result.safetyBackupPath ?? '保存在数据目录内'}`
            : `${action === 'backup' ? '本地备份' : '诊断信息'}已保存：${result.path ?? ''}`);
      } else if ('code' in result) {
        if (sequence === readSequence.current) {
          setError(`${DESKTOP_ERROR_MESSAGES[result.code]}${result.safetyBackupPath ? ` 恢复前备份：${result.safetyBackupPath}` : ''}`);
        }
      } else if (sequence === readSequence.current) setNotice('已取消，未执行操作。');
      if (!result.ok) {
        try {
          const value = await bridge.readDesktopInfo();
          if (value.restartRequired) onRestartRequired?.();
          if (sequence === readSequence.current) setInfo(value);
        } catch { /* Keep the actionable result visible. */ }
      }
    } catch {
      if (sequence === readSequence.current) setError('桌面维护操作失败，请重试；已有数据保留。');
    }
    finally { working.current = false; setBusy(false); }
  }

  function select(scope: DesktopDataScope, checked: boolean) {
    setScopes((previous) => checked ? DESKTOP_DATA_SCOPES.filter((item) => item === scope || previous.includes(item))
      : previous.filter((item) => item !== scope));
  }

  return <section className="desktop-panel" aria-label="桌面交付与本地数据" style={{ minWidth: 0 }}>
    <style>{`
      .desktop-panel .desktop-body { padding: 12px 16px; min-width: 0; font-size: 12px; line-height: 1.6; }
      .desktop-panel p { margin: 0 0 8px; overflow-wrap: anywhere; }
      .desktop-panel h3 { margin: 0 0 8px; font-size: 13px; }
      .desktop-panel dl { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 4px 12px; margin: 0 0 12px; }
      .desktop-panel dt { color: var(--muted); }
      .desktop-panel dd { margin: 0; min-width: 0; overflow-wrap: anywhere; }
      .desktop-panel code { font-size: 11px; overflow-wrap: anywhere; }
      .desktop-panel .desktop-section { padding: 12px 0; border-top: 1px solid var(--border); }
      .desktop-panel .desktop-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
      .desktop-panel .desktop-actions button { display: inline-flex; align-items: center; gap: 6px; max-width: 100%; min-height: 32px; white-space: normal; text-align: left; }
      .desktop-panel button svg { flex-shrink: 0; }
      .desktop-panel fieldset { border: 0; padding: 0; margin: 0 0 10px; min-width: 0; display: grid; gap: 6px; }
      .desktop-panel label { display: flex; align-items: flex-start; gap: 7px; overflow-wrap: anywhere; }
      .desktop-panel input { flex-shrink: 0; margin-top: 4px; accent-color: var(--green); }
      .desktop-panel .desktop-muted { color: var(--muted); }
      .desktop-panel .desktop-error { color: var(--red); }
      @media (max-width: 520px) { .desktop-panel dl { grid-template-columns: minmax(0, 1fr); gap: 2px; } .desktop-panel dd { margin-bottom: 6px; } }
    `}</style>
    <header className="section-header">
      <h2><Monitor size={15} aria-hidden="true" />桌面与数据</h2>
      <button className="icon-button" type="button" title="刷新桌面状态" aria-label="刷新桌面状态"
        disabled={!bridge || busy} onClick={() => { void refresh(); }}><RefreshCw size={15} aria-hidden="true" /></button>
    </header>
    <div className="desktop-body" aria-busy={busy}>
      {!bridge && <p className="desktop-muted" role="status">桌面维护入口尚未接入。</p>}
      {bridge && !info && !error && <p role="status">正在读取桌面状态...</p>}
      {info && <>
        <dl>
          <dt>客户端版本</dt><dd>{info.version}</dd>
          <dt>稳定数据目录</dt><dd><code>{info.dataDir}</code></dd>
          <dt>旧数据</dt><dd>{migrationLabels[info.migration.status]}</dd>
          <dt>配置状态</dt><dd>{info.configurationReady
            ? (info.setupCompleted ? '首次配置已完成' : '已保存设置，首次配置待确认') : '未配置或配置不可用'}</dd>
          {info.setupMode && <><dt>配置模式</dt><dd>{info.setupMode === 'mock' ? '本地模拟' : 'DeepSeek（尚未验证真实请求）'}</dd></>}
        </dl>
        {info.migration.backupPath && <p className="desktop-muted">迁移备份：<code>{info.migration.backupPath}</code></p>}
        {info.restartRequired && <p role="status">数据已变更，请关闭所有客户端窗口后重新启动。</p>}
        {(!info.setupCompleted || !info.configurationReady) && <div className="desktop-section">
          <h3>首次配置</h3>
          <p>请先保存模型设置。选择本地模拟可离线使用；使用 DeepSeek 需要密钥与数据发送授权。</p>
          <div className="desktop-actions">
            <button className="text-button" type="button" disabled={locked || !onOpenModelSettings}
              onClick={onOpenModelSettings}><Settings size={14} aria-hidden="true" />模型设置</button>
            <button className="text-button" type="button" disabled={locked || !info.configurationReady}
              onClick={() => { void perform('setup'); }}><Check size={14} aria-hidden="true" />完成首次配置</button>
          </div>
        </div>}
        <div className="desktop-section">
          <h3>本地备份与恢复</h3>
          <fieldset disabled={locked}><legend className="sr-only">选择备份数据</legend>
            {DESKTOP_DATA_SCOPES.map((scope) => <label key={scope}>
              <input type="checkbox" checked={scopes.includes(scope)} onChange={(event) => select(scope, event.target.checked)} />
              <span>{scope === 'tasks' ? '任务记录与交付证据' : DESKTOP_SCOPE_LABELS[scope]}</span>
            </label>)}
          </fieldset>
          <p className="desktop-muted">备份可能含明文任务与会话。密钥保留系统密文，通常仅可由同一电脑、同一系统账号解密，不能保证跨机恢复。</p>
          <p className="desktop-muted">恢复会替换备份选定类别，先保留当前数据备份；恢复后必须重启。工作区文件与项目索引不包含在备份中。</p>
          <div className="desktop-actions">
            <button className="text-button" type="button" disabled={locked || scopes.length === 0}
              onClick={() => { void perform('backup'); }}><Archive size={14} aria-hidden="true" />保存本地备份</button>
            <button className="text-button" type="button" disabled={locked}
              onClick={() => { void perform('restore'); }}><Upload size={14} aria-hidden="true" />从备份恢复</button>
          </div>
        </div>
        <div className="desktop-section">
          <button className="text-button" type="button" disabled={!bridge || busy}
            onClick={() => { void perform('diagnostics'); }}><Download size={14} aria-hidden="true" />导出安全诊断</button>
        </div>
      </>}
      {blocked && <p className="desktop-muted" role="status">请求处理或任务运行期间，无法配置、备份或恢复。</p>}
      {busy && <p className="desktop-muted" role="status">正在处理，请稍候...</p>}
      {error && <p className="desktop-error" role="alert">{error}</p>}
      {!error && info?.lastError && <p className="desktop-error" role="alert">{DESKTOP_ERROR_MESSAGES[info.lastError]}</p>}
      {notice && <p role="status">{notice}</p>}
    </div>
  </section>;
}
