import { DEFAULT_CONVERSATION_ID, validateSubmitMessageRequest, type EventEnvelope, type SubmitMessageRequest, type SubmitMessageResult } from '../../shared/contracts';
import { validateModelSettings, type ModelSettingsResult, type PublicModelSettings, type SaveModelSettingsRequest } from '../../shared/model-settings';
import type { WorkspaceState, WorkspaceResult } from '../../shared/workspace';
import type { DecideFileEditRequest, DecideFileEditResult, PendingFileEdit } from '../../shared/file-edit';
import type { KnowledgeSearchResult, KnowledgeState, ManagedMemory, MemoryScope, ProjectKnowledgeSummary } from '../../shared/knowledge';
import type { SkillSummary } from '../../shared/skills';
import type { CommandApprovalResult, PendingCommandApproval } from '../../shared/command';
import type { TaskBridge } from '../../shared/tasks';
import type { ChangeSetBridge, DecideChangeSetRequest } from '../../shared/change-set';
import { validateDesktopBackupRequest, type DesktopBridge } from '../../shared/desktop';

export interface WindowEndpoint {
  id: number;
  mainFrame: { url: string };
  getURL(): string;
  isDestroyed(): boolean;
  send(channel: string, payload: EventEnvelope): void;
}
export interface CommandSource {
  sender: WindowEndpoint;
  senderFrame: { url: string } | null;
}
export interface IpcRegistry {
  handle(channel: string, listener: (source: CommandSource, input: unknown) => Promise<unknown>): void;
  removeHandler(channel: string): void;
}
export interface RuntimeCommands extends Partial<TaskBridge>, Partial<ChangeSetBridge> {
  readConversation(conversationId: string): Promise<EventEnvelope[]>;
  submit(request: SubmitMessageRequest): Promise<SubmitMessageResult>;
  subscribe(listener: (event: EventEnvelope) => void): () => void;
  readModelSettings?(): Promise<PublicModelSettings>;
  saveModelSettings?(request: SaveModelSettingsRequest): Promise<ModelSettingsResult>;
  deleteModelApiKey?(): Promise<ModelSettingsResult>;
  cancelRun?(request: { conversationId: string; runId: string }): Promise<{ cancelled: boolean }>;
  readWorkspace?(): Promise<WorkspaceState>;
  chooseWorkspace?(): Promise<WorkspaceResult>;
  setWorkspaceConsent?(request: { dataEgressConsent: boolean }): Promise<WorkspaceResult>;
  clearWorkspace?(): Promise<WorkspaceResult>;
  readPendingFileEdit?(): Promise<PendingFileEdit | null>;
  decideFileEdit?(request: DecideFileEditRequest): Promise<DecideFileEditResult>;
  readPendingCommand?(): Promise<PendingCommandApproval | null>;
  decideCommand?(request: { conversationId: string; runId: string; approvalId: string; bindingDigest: string; decision: 'approved' | 'rejected' }): Promise<CommandApprovalResult>;
  readKnowledgeState?(): Promise<KnowledgeState>;
  syncKnowledge?(): Promise<KnowledgeState>;
  searchKnowledge?(request: { query: string }): Promise<KnowledgeSearchResult[]>;
  readProjectKnowledge?(): Promise<ProjectKnowledgeSummary | null>;
  readMemories?(): Promise<ManagedMemory[]>;
  saveMemory?(request: { scope: MemoryScope; content: string }): Promise<ManagedMemory | null>;
  deleteMemory?(request: { id: string }): Promise<{ deleted: boolean }>;
  readSkills?(): Promise<SkillSummary[]>;
  setSkillEnabled?(request: { id: string; enabled: boolean }): Promise<SkillSummary[]>;
}

export function registerHandlers(
  ipc: IpcRegistry,
  coordinator: RuntimeCommands,
  window: WindowEndpoint,
  expectedUrl: string,
  desktop?: DesktopBridge,
): () => void {
  // Chromium canonicalizes Forge's Windows file entry before exposing its URL.
  const trustedUrl = new URL(expectedUrl).href;
  const trustedWindow = () => !window.isDestroyed()
    && window.getURL() === trustedUrl && window.mainFrame.url === trustedUrl;
  const authorize = (source: CommandSource) => {
    if (source.sender !== window || source.senderFrame !== window.mainFrame || !trustedWindow()) {
      throw new Error('Untrusted IPC sender');
    }
  };
  const addedChannels: string[] = [];
  const handle = (channel: string, operation: (input: unknown) => Promise<unknown>) => {
    addedChannels.push(channel);
    ipc.handle(channel, async (source, input) => {
      authorize(source);
      return operation(input);
    });
  };
  const noInput = (input: unknown) => {
    if (input !== undefined) throw new Error('此操作不接受额外参数。');
  };
  const uuid = (value: unknown): value is string => typeof value === 'string'
    && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
  const taskRequest = (input: unknown): { taskId: string } => {
    if (!input || typeof input !== 'object' || Array.isArray(input)
      || Object.keys(input).length !== 1 || !uuid((input as Record<string, unknown>).taskId)) {
      throw new Error('任务操作参数无效。');
    }
    return { taskId: (input as { taskId: string }).taskId };
  };
  handle('agent:read-tasks', async (input) => {
    noInput(input);
    if (!coordinator.readTasks) throw new Error('任务服务尚未连接。');
    return coordinator.readTasks();
  });
  handle('agent:pause-task', async (input) => {
    const request = taskRequest(input);
    if (!coordinator.pauseTask) throw new Error('任务服务尚未连接。');
    return coordinator.pauseTask(request);
  });
  handle('agent:cancel-task', async (input) => {
    const request = taskRequest(input);
    if (!coordinator.cancelTask) throw new Error('任务服务尚未连接。');
    return coordinator.cancelTask(request);
  });
  handle('agent:resume-task', async (input) => {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('任务续接参数无效。');
    const request = input as Record<string, unknown>;
    if (Object.keys(request).length !== 2 || !uuid(request.taskId)
      || typeof request.acknowledgeUnknown !== 'boolean') throw new Error('任务续接参数无效。');
    if (!coordinator.resumeTask) throw new Error('任务服务尚未连接。');
    return coordinator.resumeTask({ taskId: request.taskId, acknowledgeUnknown: request.acknowledgeUnknown });
  });
  handle('agent:read-pending-change-set', async (input) => {
    noInput(input);
    return coordinator.readPendingChangeSet?.() ?? null;
  });
  handle('agent:read-change-sets', async (input) => {
    if (input !== undefined && !uuid(input)) throw new Error('变更集查询参数无效。');
    return coordinator.readChangeSets?.(input as string | undefined) ?? [];
  });
  handle('agent:read-delivery', async (input) => {
    if (!uuid(input)) throw new Error('交付查询参数无效。');
    if (!coordinator.getDelivery) throw new Error('交付服务尚未连接。');
    return coordinator.getDelivery(input);
  });
  handle('agent:decide-change-set', async (input) => {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return { ok: false, code: 'APPROVAL_UNAVAILABLE' };
    const request = input as Record<string, unknown>;
    const fields = ['runId', 'taskId', 'toolCallId', 'id', 'approvalId', 'bindingDigest', 'decision'];
    if (Object.keys(request).length !== fields.length || Object.keys(request).some((key) => !fields.includes(key))
      || ['runId', 'taskId', 'id', 'approvalId'].some((key) => !uuid(request[key]))
      || typeof request.toolCallId !== 'string' || !request.toolCallId.trim() || request.toolCallId.length > 256
      || typeof request.bindingDigest !== 'string' || !/^[a-f0-9]{64}$/.test(request.bindingDigest)
      || !['approved', 'rejected'].includes(request.decision as string)) {
      return { ok: false, code: 'APPROVAL_UNAVAILABLE' };
    }
    const { runId, taskId, toolCallId, id, approvalId, bindingDigest, decision } = request;
    return coordinator.decideChangeSet?.({ runId, taskId, toolCallId, id, approvalId, bindingDigest, decision } as DecideChangeSetRequest)
      ?? { ok: false, code: 'APPROVAL_UNAVAILABLE' };
  });
  handle('agent:read-desktop-info', async (input) => {
    noInput(input);
    if (!desktop) throw new Error('桌面维护服务尚未连接。');
    return desktop.readDesktopInfo();
  });
  handle('agent:complete-setup', async (input) => {
    noInput(input);
    return desktop?.completeSetup() ?? { ok: false, code: 'MAINTENANCE_UNAVAILABLE' };
  });
  handle('agent:export-diagnostics', async (input) => {
    noInput(input);
    return desktop?.exportDiagnostics() ?? { ok: false, code: 'MAINTENANCE_UNAVAILABLE' };
  });
  handle('agent:backup-desktop', async (input) => {
    if (!validateDesktopBackupRequest(input)) return { ok: false, code: 'INVALID_BACKUP' };
    return desktop?.backupDesktop({ scopes: [...input.scopes] }) ?? { ok: false, code: 'MAINTENANCE_UNAVAILABLE' };
  });
  handle('agent:restore-desktop', async (input) => {
    noInput(input);
    return desktop?.restoreDesktop() ?? { ok: false, code: 'MAINTENANCE_UNAVAILABLE' };
  });
  ipc.handle('agent:read-conversation', async (source, input) => {
    authorize(source);
    if (input !== DEFAULT_CONVERSATION_ID) throw new Error('Unknown conversation');
    return coordinator.readConversation(input);
  });
  ipc.handle('agent:submit-message', async (source, input) => {
    authorize(source);
    const validation = validateSubmitMessageRequest(input);
    if (!validation.ok) throw new Error(`Invalid command: ${validation.error}`);
    const request = input as SubmitMessageRequest;
    if (request.conversationId !== DEFAULT_CONVERSATION_ID) throw new Error('Invalid command: unknown conversation');
    // Copy only permitted fields across the application boundary.
    return coordinator.submit({ conversationId: request.conversationId, clientRequestId: request.clientRequestId, text: request.text });
  });
  ipc.handle('agent:read-model-settings', async (source, input) => {
    authorize(source);
    if (input !== undefined) throw new Error('Invalid settings command');
    if (!coordinator.readModelSettings) throw new Error('Model settings unavailable');
    return coordinator.readModelSettings();
  });
  ipc.handle('agent:save-model-settings', async (source, input) => {
    authorize(source);
    if (!validateModelSettings(input, true)) return { ok: false, code: 'INVALID_SETTINGS' };
    if (!coordinator.saveModelSettings) return { ok: false, code: 'SETTINGS_WRITE_FAILED' };
    const { provider, model, maxOutputTokens, timeoutMs, dataEgressConsent, apiKey } = input;
    return coordinator.saveModelSettings({ provider, model, maxOutputTokens, timeoutMs,
      dataEgressConsent, ...(apiKey ? { apiKey } : {}) });
  });
  ipc.handle('agent:delete-model-api-key', async (source, input) => {
    authorize(source);
    if (input !== undefined) throw new Error('Invalid settings command');
    return coordinator.deleteModelApiKey?.() ?? { ok: false, code: 'SETTINGS_WRITE_FAILED' };
  });
  ipc.handle('agent:cancel-run', async (source, input) => {
    authorize(source);
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid cancel command');
    const request = input as Record<string, unknown>;
    if (Object.keys(request).some((key) => key !== 'conversationId' && key !== 'runId')
      || request.conversationId !== DEFAULT_CONVERSATION_ID
      || typeof request.runId !== 'string' || !/^[a-f0-9-]{36}$/.test(request.runId)) {
      throw new Error('Invalid cancel command');
    }
    return coordinator.cancelRun?.({ conversationId: DEFAULT_CONVERSATION_ID, runId: request.runId })
      ?? { cancelled: false };
  });
  const unsubscribe = coordinator.subscribe((event) => {
    if (trustedWindow()) window.send('agent:event', event);
  });
  ipc.handle('agent:read-workspace', async (source, input) => {
    authorize(source);
    if (input !== undefined || !coordinator.readWorkspace) throw new Error('工作区不可用');
    return coordinator.readWorkspace();
  });
  ipc.handle('agent:read-pending-file-edit', async (source, input) => {
    authorize(source);
    if (input !== undefined) throw new Error('无效的审批读取请求。');
    return coordinator.readPendingFileEdit?.() ?? null;
  });
  ipc.handle('agent:decide-file-edit', async (source, input) => {
    authorize(source);
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      return { ok: false, code: 'INVALID_APPROVAL_COMMAND' };
    }
    const request = input as Record<string, unknown>;
    const fields = ['conversationId', 'runId', 'approvalId', 'bindingDigest', 'decision'];
    if (Object.keys(request).length !== fields.length || Object.keys(request).some((key) => !fields.includes(key))
      || request.conversationId !== DEFAULT_CONVERSATION_ID
      || ['runId', 'approvalId'].some((key) => typeof request[key] !== 'string'
        || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(request[key] as string))
      || typeof request.bindingDigest !== 'string' || !/^[a-f0-9]{64}$/.test(request.bindingDigest)
      || (request.decision !== 'approved' && request.decision !== 'rejected')) {
      return { ok: false, code: 'INVALID_APPROVAL_COMMAND' };
    }
    return coordinator.decideFileEdit?.({ conversationId: DEFAULT_CONVERSATION_ID,
      runId: request.runId as string, approvalId: request.approvalId as string,
      bindingDigest: request.bindingDigest, decision: request.decision })
      ?? { ok: false, code: 'APPROVAL_UNAVAILABLE' };
  });
  ipc.handle('agent:read-pending-command', async (source, input) => {
    authorize(source);
    if (input !== undefined) throw new Error('无效的命令审批读取请求');
    return coordinator.readPendingCommand?.() ?? null;
  });
  ipc.handle('agent:decide-command', async (source, input) => {
    authorize(source);
    if (!input || typeof input !== 'object' || Array.isArray(input)) return { ok: false, code: 'INVALID_APPROVAL_COMMAND' };
    const request = input as Record<string, unknown>;
    if (Object.keys(request).length !== 5 || request.conversationId !== DEFAULT_CONVERSATION_ID
      || typeof request.runId !== 'string' || !/^[a-f0-9-]{36}$/i.test(request.runId)
      || typeof request.approvalId !== 'string' || !/^[a-f0-9-]{36}$/i.test(request.approvalId)
      || typeof request.bindingDigest !== 'string' || !/^[a-f0-9]{64}$/.test(request.bindingDigest)
      || (request.decision !== 'approved' && request.decision !== 'rejected')) return { ok: false, code: 'INVALID_APPROVAL_COMMAND' };
    return coordinator.decideCommand?.({ conversationId: DEFAULT_CONVERSATION_ID, runId: request.runId,
      approvalId: request.approvalId, bindingDigest: request.bindingDigest, decision: request.decision })
      ?? { ok: false, code: 'APPROVAL_UNAVAILABLE' };
  });
  ipc.handle('agent:choose-workspace', async (source, input) => {
    authorize(source);
    if (input !== undefined) return { ok: false, code: 'INVALID_WORKSPACE_COMMAND' };
    return coordinator.chooseWorkspace?.() ?? { ok: false, code: 'WORKSPACE_UNAVAILABLE' };
  });
  ipc.handle('agent:clear-workspace', async (source, input) => {
    authorize(source);
    if (input !== undefined) return { ok: false, code: 'INVALID_WORKSPACE_COMMAND' };
    return coordinator.clearWorkspace?.() ?? { ok: false, code: 'WORKSPACE_UNAVAILABLE' };
  });
  ipc.handle('agent:set-workspace-consent', async (source, input) => {
    authorize(source);
    if (!input || typeof input !== 'object' || Array.isArray(input)
      || Object.keys(input).length !== 1 || !Object.hasOwn(input, 'dataEgressConsent')
      || typeof (input as Record<string, unknown>).dataEgressConsent !== 'boolean') {
      return { ok: false, code: 'INVALID_WORKSPACE_COMMAND' };
    }
    return coordinator.setWorkspaceConsent?.({ dataEgressConsent: (input as { dataEgressConsent: boolean }).dataEgressConsent })
      ?? { ok: false, code: 'WORKSPACE_UNAVAILABLE' };
  });
  ipc.handle('agent:read-knowledge-state', async (source, input) => {
    authorize(source);
    if (input !== undefined) throw new Error('无效的知识状态请求');
    return coordinator.readKnowledgeState?.() ?? { projectKey: null, indexedAt: null, fileCount: 0, chunkCount: 0, staleCount: 0, memoryCount: 0, lastError: null };
  });
  ipc.handle('agent:sync-knowledge', async (source, input) => {
    authorize(source);
    if (input !== undefined) throw new Error('无效的知识同步请求');
    return coordinator.syncKnowledge?.() ?? { projectKey: null, indexedAt: null, fileCount: 0, chunkCount: 0, staleCount: 0, memoryCount: 0, lastError: '知识服务不可用' };
  });
  ipc.handle('agent:search-knowledge', async (source, input) => {
    authorize(source);
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('无效的知识检索请求');
    const request = input as Record<string, unknown>;
    if (Object.keys(request).length !== 1 || typeof request.query !== 'string' || !request.query.trim() || request.query.length > 200) {
      throw new Error('无效的知识检索请求');
    }
    return coordinator.searchKnowledge?.({ query: request.query }) ?? [];
  });
  ipc.handle('agent:read-project-knowledge', async (source, input) => {
    authorize(source);
    if (input !== undefined) throw new Error('无效的项目知识请求');
    return coordinator.readProjectKnowledge?.() ?? null;
  });
  ipc.handle('agent:read-memories', async (source, input) => {
    authorize(source);
    if (input !== undefined) throw new Error('无效的记忆请求');
    return coordinator.readMemories?.() ?? [];
  });
  ipc.handle('agent:save-memory', async (source, input) => {
    authorize(source);
    if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
    const request = input as Record<string, unknown>;
    if (Object.keys(request).length !== 2 || (request.scope !== 'user' && request.scope !== 'project')
      || typeof request.content !== 'string' || !request.content.trim() || request.content.length > 4000) return null;
    return coordinator.saveMemory?.({ scope: request.scope, content: request.content }) ?? null;
  });
  ipc.handle('agent:delete-memory', async (source, input) => {
    authorize(source);
    if (!input || typeof input !== 'object' || Array.isArray(input)) return { deleted: false };
    const request = input as Record<string, unknown>;
    if (Object.keys(request).length !== 1 || typeof request.id !== 'string' || !/^[a-f0-9-]{36}$/i.test(request.id)) return { deleted: false };
    return coordinator.deleteMemory?.({ id: request.id }) ?? { deleted: false };
  });
  ipc.handle('agent:read-skills', async (source, input) => {
    authorize(source);
    if (input !== undefined) throw new Error('无效的 Skills 请求');
    return coordinator.readSkills?.() ?? [];
  });
  ipc.handle('agent:set-skill-enabled', async (source, input) => {
    authorize(source);
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('无效的 Skill 设置请求');
    const request = input as Record<string, unknown>;
    if (Object.keys(request).length !== 2 || typeof request.id !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(request.id)
      || typeof request.enabled !== 'boolean') throw new Error('无效的 Skill 设置请求');
    return coordinator.setSkillEnabled?.({ id: request.id, enabled: request.enabled }) ?? [];
  });
  return () => {
    unsubscribe();
    for (const channel of addedChannels) ipc.removeHandler(channel);
    ipc.removeHandler('agent:read-conversation');
    ipc.removeHandler('agent:submit-message');
    ipc.removeHandler('agent:read-model-settings');
    ipc.removeHandler('agent:save-model-settings');
    ipc.removeHandler('agent:delete-model-api-key');
    ipc.removeHandler('agent:cancel-run');
    ipc.removeHandler('agent:read-workspace');
    ipc.removeHandler('agent:choose-workspace');
    ipc.removeHandler('agent:clear-workspace');
    ipc.removeHandler('agent:set-workspace-consent');
    ipc.removeHandler('agent:read-pending-file-edit');
    ipc.removeHandler('agent:decide-file-edit');
    ipc.removeHandler('agent:read-pending-command');
    ipc.removeHandler('agent:decide-command');
    ipc.removeHandler('agent:read-knowledge-state');
    ipc.removeHandler('agent:sync-knowledge');
    ipc.removeHandler('agent:search-knowledge');
    ipc.removeHandler('agent:read-project-knowledge');
    ipc.removeHandler('agent:read-memories');
    ipc.removeHandler('agent:save-memory');
    ipc.removeHandler('agent:delete-memory');
    ipc.removeHandler('agent:read-skills');
    ipc.removeHandler('agent:set-skill-enabled');
  };
}
