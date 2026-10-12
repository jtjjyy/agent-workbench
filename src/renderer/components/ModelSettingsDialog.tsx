import { CircleAlert, Save, Trash2, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import {
  DEEPSEEK_BASE_URL, DEEPSEEK_MODELS, validateModelSettings,
  type DeepSeekModelId, type ModelSettingsResult, type PublicModelSettings,
  type SaveModelSettingsRequest,
} from '../../shared/model-settings';
import { settingsErrorText } from '../../shared/zh-CN';

interface ModelSettingsDialogProps {
  settings: PublicModelSettings | null;
  loading: boolean;
  readError: string | null;
  blocked: boolean;
  onSave: (request: SaveModelSettingsRequest) => Promise<ModelSettingsResult>;
  onDeleteKey: () => Promise<ModelSettingsResult>;
  onClose: () => void;
}

export function settingsErrorMessage(code: unknown): string {
  return settingsErrorText(code);
}

export function ModelSettingsDialog({ settings, loading, readError, blocked, onSave, onDeleteKey, onClose }: ModelSettingsDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const keyRef = useRef<HTMLInputElement>(null);
  const workingRef = useRef(false);
  const [draft, setDraft] = useState<PublicModelSettings | null>(settings);
  const [apiKey, setApiKey] = useState('');
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => { setDraft(settings); }, [settings]);
  useEffect(() => {
    const dialog = dialogRef.current;
    dialog?.showModal();
    return () => {
      if (keyRef.current) keyRef.current.value = '';
      dialog?.close();
    };
  }, []);

  function clearKey() {
    setApiKey('');
    if (keyRef.current) keyRef.current.value = '';
  }

  function close() {
    if (workingRef.current) return;
    clearKey();
    onClose();
  }

  const locked = blocked || working || loading || !!readError || !draft;

  async function mutate(removeKey: boolean) {
    const request: SaveModelSettingsRequest | null = draft ? {
      provider: draft.provider, model: draft.model, maxOutputTokens: draft.maxOutputTokens,
      timeoutMs: draft.timeoutMs, dataEgressConsent: draft.dataEgressConsent,
      ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
    } : null;
    clearKey();
    if (workingRef.current) return;
    setError(null);
    setNotice(null);
    if (blocked) { setError(settingsErrorMessage('RUN_ACTIVE')); return; }
    if (locked || !draft || !request) return;
    if (!removeKey && (!validateModelSettings(request, true) || !Number.isInteger(request.timeoutMs / 1000))) {
      setError(settingsErrorMessage('INVALID_SETTINGS'));
      return;
    }
    if (!removeKey && draft.provider === 'deepseek') {
      if (!draft.secureStorageAvailable) {
        setError(settingsErrorMessage('SECURE_STORAGE_UNAVAILABLE'));
        return;
      }
      if (!draft.hasApiKey && !request.apiKey) {
        setError(settingsErrorMessage('API_KEY_REQUIRED'));
        return;
      }
    }
    workingRef.current = true;
    setWorking(true);
    try {
      const result = await (removeKey ? onDeleteKey() : onSave(request));
      if (result.ok) {
        setDraft(result.settings);
        setNotice(removeKey ? '已删除保存的 API 密钥。' : '模型设置已保存。');
      } else setError(settingsErrorMessage(result.code));
    } catch {
      setError(settingsErrorMessage('SETTINGS_WRITE_FAILED'));
    } finally {
      clearKey();
      workingRef.current = false;
      setWorking(false);
    }
  }

  const displayedError = error || readError || (draft?.configurationError
    ? settingsErrorMessage(draft.configurationError) : null);

  return (
    <dialog className="model-settings-dialog" ref={dialogRef} aria-labelledby="model-settings-title"
      aria-describedby="model-settings-privacy" onCancel={(event) => { event.preventDefault(); close(); }}>
      <header className="settings-header">
        <h2 id="model-settings-title">模型设置</h2>
        <button type="button" className="icon-button" aria-label="关闭模型设置"
          title="关闭模型设置" disabled={working} onClick={close} autoFocus>
          <X size={18} aria-hidden="true" />
        </button>
      </header>
      <form className="settings-form" noValidate onSubmit={(event) => { event.preventDefault(); void mutate(false); }}>
        {loading && <p className="settings-notice" role="status">正在加载设置...</p>}
        {draft && <fieldset className="settings-fields" disabled={locked}>
          <legend className="sr-only">模型配置</legend>
          <fieldset className="provider-options">
            <legend>提供方</legend>
            <div className="provider-segments">
              <label><input type="radio" name="model-provider" value="mock" checked={draft.provider === 'mock'}
                onChange={() => setDraft({ ...draft, provider: 'mock' })} />本地模拟</label>
              <label><input type="radio" name="model-provider" value="deepseek" checked={draft.provider === 'deepseek'}
                onChange={() => setDraft({ ...draft, provider: 'deepseek' })} />DeepSeek</label>
            </div>
          </fieldset>
          <label className="settings-field" htmlFor="deepseek-model">DeepSeek 模型
            <select id="deepseek-model" value={draft.model}
              onChange={(event) => setDraft({ ...draft, model: event.target.value as DeepSeekModelId })}>
              {DEEPSEEK_MODELS.map((model) => <option key={model} value={model}>{model}</option>)}
            </select>
          </label>
          <div className="settings-number-fields">
            <label className="settings-field" htmlFor="model-output-limit">输出词元上限
              <input id="model-output-limit" type="number" min={512} max={8192} step={1} required
                value={Number.isFinite(draft.maxOutputTokens) ? draft.maxOutputTokens : ''}
                onChange={(event) => setDraft({ ...draft, maxOutputTokens: event.target.valueAsNumber })} />
            </label>
            <label className="settings-field" htmlFor="model-timeout">超时时间（秒）
              <input id="model-timeout" type="number" min={15} max={180} step={1} required
                value={Number.isFinite(draft.timeoutMs) ? draft.timeoutMs / 1000 : ''}
                onChange={(event) => setDraft({ ...draft, timeoutMs: event.target.valueAsNumber * 1000 })} />
            </label>
          </div>
          <label className="settings-field" htmlFor="deepseek-api-key">DeepSeek API 密钥
            <input id="deepseek-api-key" ref={keyRef} type="password" value={apiKey}
              autoComplete="new-password" spellCheck={false} autoCapitalize="none"
              disabled={!draft.secureStorageAvailable} aria-describedby="saved-key-status"
              onChange={(event) => setApiKey(event.target.value)} />
          </label>
          <div className="saved-key-row">
            <span id="saved-key-status">{draft.hasApiKey ? '已保存密钥：********（已存在）' : '未保存密钥'}</span>
            <button className="icon-button" type="button" aria-label="删除已保存的 API 密钥"
              title="删除已保存的 API 密钥" disabled={!draft.hasApiKey} onClick={() => { void mutate(true); }}>
              <Trash2 size={16} aria-hidden="true" />
            </button>
          </div>
          {!draft.secureStorageAvailable && <p className="settings-notice">系统密钥加密不可用。</p>}
          <label className="egress-consent">
            <input type="checkbox" checked={draft.dataEgressConsent} required={draft.provider === 'deepseek'}
              onChange={(event) => setDraft({ ...draft, dataEgressConsent: event.target.checked })} />
            <span>我同意将当前提示词、最近成功的 DeepSeek 对话、公开网页请求和网页结果发送至 {DEEPSEEK_BASE_URL}。
              不会发送此前的本地模拟对话；联网工具和工作区工具的访问权限保持独立。</span>
          </label>
        </fieldset>}
        <p className="settings-privacy" id="model-settings-privacy">历史对话文本以明文保存在本地。</p>
        {blocked && <p className="settings-notice" role="status">请求等待处理或任务运行期间，无法修改设置。</p>}
        {displayedError && <div className="settings-error"><CircleAlert size={16} aria-hidden="true" />
          <p role="alert">{displayedError}</p></div>}
        {notice && <p className="settings-notice" role="status">{notice}</p>}
        <footer className="settings-footer">
          <button className="settings-save" type="submit" disabled={locked}>
            <Save size={16} aria-hidden="true" />{working ? '正在保存...' : '保存设置'}
          </button>
        </footer>
      </form>
    </dialog>
  );
}
