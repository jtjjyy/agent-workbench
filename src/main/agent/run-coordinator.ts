import { randomUUID } from 'node:crypto';
import {
  DEFAULT_CONVERSATION_ID,
  validateSubmitMessageRequest,
  type AgentProvider,
  type EventEnvelope,
  type EventPayloads,
  type EventStore,
  type EventType,
  type SubmitMessageRequest,
  type SubmitMessageResult,
  type ContextTurn,
} from '../../shared/contracts';
import type { ModelSettingsResult, ModelSettingsStore, SaveModelSettingsRequest } from '../../shared/model-settings';
import { ProviderError } from './provider-errors';
import { RUN_ERROR_MESSAGES } from '../../shared/zh-CN';
import { EMPTY_WORKSPACE, type WorkspaceResult, type WorkspaceState } from '../../shared/workspace';
import type { WorkspaceSession } from '../workspace/workspace-session';
import { FileEditApprovals } from './file-edit-approvals';
import type { DecideFileEditRequest, DecideFileEditResult, PendingFileEdit } from '../../shared/file-edit';
import { EMPTY_KNOWLEDGE_STATE, type KnowledgeSearchResult, type KnowledgeState, type ManagedMemory, type MemoryScope, type ProjectKnowledgeSummary } from '../../shared/knowledge';
import type { KnowledgeService } from '../knowledge/knowledge-service';
import type { SkillService } from '../skills/skill-service';
import { CommandApprovals } from './command-approvals';
import type { PendingCommandApproval, CommandApprovalResult } from '../../shared/command';

export class RunCoordinator {
  private nextSequence = 1;
  private initialization: Promise<void> | undefined;
  private queue: Promise<void> = Promise.resolve();
  private readonly seen = new Map<string, string>();
  private readonly listeners = new Set<(event: EventEnvelope) => void>();
  private active: { runId: string; abort: AbortController; cancellable: boolean } | undefined;
  private pendingSubmissions = 0;
  private changingSettings = false;
  private storageFailed = false;
  private stopping = false;
  private readonly editApprovals = new FileEditApprovals();
  private readonly commandApprovals: CommandApprovals;

  constructor(private readonly store: EventStore, private readonly provider: AgentProvider,
    private readonly settings?: ModelSettingsStore, private readonly workspace?: WorkspaceSession,
    private readonly pickDirectory?: () => Promise<string | undefined>,
    private readonly knowledge?: KnowledgeService,
    private readonly skills?: SkillService, commandApprovals?: CommandApprovals) {
    this.commandApprovals = commandApprovals ?? new CommandApprovals();
  }

  initialize(): Promise<void> {
    return this.initialization ??= this.restore();
  }

  private async restore(): Promise<void> {
    const events = await this.store.readAll(DEFAULT_CONVERSATION_ID);
    const unfinished = new Set<string>();
    for (const event of events) {
      if (event.sequence !== this.nextSequence) throw new Error('Conversation journal has a sequence gap');
      this.nextSequence++;
      if (event.type === 'message.user.created') this.seen.set(event.payload.clientRequestId, event.payload.text);
      if (event.type === 'run.started') unfinished.add(event.payload.runId);
      if (event.type === 'run.completed' || event.type === 'run.failed') unfinished.delete(event.payload.runId);
    }
    if (events.length === 0) await this.persist('conversation.created', { title: '本地会话' });
    // An unfinished local response is marked interrupted, never automatically rerun.
    for (const runId of unfinished) {
      await this.persist('run.failed', { runId, code: 'RUN_INTERRUPTED', message: RUN_ERROR_MESSAGES.RUN_INTERRUPTED });
    }
  }

  async submit(request: SubmitMessageRequest): Promise<SubmitMessageResult> {
    const validation = validateSubmitMessageRequest(request);
    if (!validation.ok) throw new Error(validation.error);
    this.requireConversation(request.conversationId);
    if (this.changingSettings) throw new Error('Model settings are being updated.');
    this.pendingSubmissions++;
    try {
      await this.initialize();
      if (this.stopping || this.storageFailed) throw new Error('Runtime unavailable. Reopen the application.');
      const task = this.queue.then(() => this.run(request));
      this.queue = task.catch(() => {});
      await task;
    } catch (error) {
      if (this.storageFailed) return { status: 'unavailable', code: 'JOURNAL_WRITE_FAILED' };
      throw error;
    } finally {
      this.pendingSubmissions--;
    }
  }

  private async run(request: SubmitMessageRequest): Promise<void> {
    if (this.stopping || this.storageFailed) throw new Error('Runtime unavailable. Reopen the application.');
    const previous = this.seen.get(request.clientRequestId);
    if (previous !== undefined) {
      if (previous !== request.text) throw new Error('Request key already belongs to a different prompt');
      return;
    }
    const messageId = randomUUID();
    const runId = randomUUID();
    const agentMessageId = randomUUID();
    const configuration = await this.settings?.readPublic();
    const workspace = this.workspace?.snapshot() ?? { ...EMPTY_WORKSPACE };
    // Never carry evidence from another workspace or previously revoked access into a new task.
    const history = configuration?.provider === 'deepseek' && !workspace.root ? await this.readContext() : [];
    const abort = new AbortController();
    this.active = { runId, abort, cancellable: true };
    const startedAt = Date.now();
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const metadata = configuration ? { provider: configuration.provider,
      model: configuration.provider === 'mock' ? 'deterministic-local' : configuration.model } : {};
    try {
      await this.persist('message.user.created', { messageId, clientRequestId: request.clientRequestId, text: request.text });
      this.seen.set(request.clientRequestId, request.text);
      await this.persist('run.started', { runId, sourceMessageId: messageId, ...metadata,
        workspaceAttached: configuration?.provider === 'deepseek' && !!workspace.root && workspace.dataEgressConsent });
      await this.persist('message.agent.created', { messageId: agentMessageId, runId });
      timer = setTimeout(() => { timedOut = true; abort.abort(); }, configuration?.timeoutMs ?? 90_000);
      if (this.stopping) abort.abort();
      const selectedSkills = this.skills ? await this.skills.select(request.text) : { names: [], instructions: '' };
      const reply = await this.provider.streamReply({ text: request.text, runId, history, workspace, knowledge: this.knowledge, skills: selectedSkills,
        onApproval: async (type, payload) => this.persist(type, payload),
        onFileEdit: async (toolCallId, proposal, apply, signal) => {
          abort.signal.throwIfAborted();
          if (!workspace.root || !workspace.dataEgressConsent || this.active?.runId !== runId) {
            throw new ProviderError('WORKSPACE_UNAVAILABLE');
          }
          return this.editApprovals.request({ runId, toolCallId, workspaceRoot: workspace.root },
            proposal, apply, AbortSignal.any([abort.signal, signal]),
            (type, payload) => this.persist(type, payload));
        },
        onTool: async (progress) => {
          if (progress.type === 'started') abort.signal.throwIfAborted();
          if (progress.type === 'started') {
            const { type: _type, ...payload } = progress;
            await this.persist('tool.started', { runId, ...payload });
          } else {
            const { type: _type, ...payload } = progress;
            await this.persist('tool.completed', { runId, ...payload });
          }
        },
      }, abort.signal, async (text) => {
        abort.signal.throwIfAborted();
        await this.persist('message.agent.delta', { messageId: agentMessageId, runId, text });
      });
      abort.signal.throwIfAborted();
      this.active.cancellable = false;
      if (timer) clearTimeout(timer);
      await this.persist('run.completed', { runId, messageId: agentMessageId,
        ...(reply ?? {}), durationMs: Math.max(0, Date.now() - startedAt) });
    } catch (error) {
      this.active.cancellable = false;
      if (this.storageFailed) throw error;
      const code = timedOut ? 'RUN_TIMEOUT' : abort.signal.aborted ? 'RUN_CANCELLED'
        : error instanceof ProviderError ? error.code : 'PROVIDER_FAILED';
      await this.persist('run.failed', {
        runId,
        code,
        message: timedOut ? RUN_ERROR_MESSAGES.RUN_TIMEOUT
          : abort.signal.aborted ? RUN_ERROR_MESSAGES.RUN_CANCELLED
            : error instanceof ProviderError ? error.message : RUN_ERROR_MESSAGES.PROVIDER_FAILED,
      });
    } finally {
      if (timer) clearTimeout(timer);
      this.active = undefined;
    }
  }

  private async readContext(): Promise<ContextTurn[]> {
    const events = await this.store.readAll(DEFAULT_CONVERSATION_ID);
    const users = new Map<string, string>();
    const runs = new Map<string, { user: string; assistant: string; deepseek: boolean }>();
    const completed: ContextTurn[] = [];
    for (const event of events) {
      if (event.type === 'message.user.created') users.set(event.payload.messageId, event.payload.text);
      if (event.type === 'run.started') runs.set(event.payload.runId, {
        user: users.get(event.payload.sourceMessageId) ?? '', assistant: '',
        deepseek: event.payload.provider === 'deepseek' && !event.payload.workspaceAttached,
      });
      if (event.type === 'message.agent.delta') {
        const run = runs.get(event.payload.runId);
        if (run) run.assistant += event.payload.text;
      }
      if (event.type === 'run.completed') {
        const run = runs.get(event.payload.runId);
        if (run?.deepseek && run.user && run.assistant && event.payload.stopReason !== 'length') {
          completed.push({ user: run.user, assistant: run.assistant });
        }
        runs.delete(event.payload.runId);
      }
      if (event.type === 'run.failed') runs.delete(event.payload.runId);
    }
    const selected: ContextTurn[] = [];
    let size = 0;
    for (const turn of completed.reverse()) {
      const length = turn.user.length + turn.assistant.length;
      if (selected.length === 6 || size + length > 24_000) break;
      selected.unshift(turn);
      size += length;
    }
    return selected;
  }

  cancelRun(request: { conversationId: string; runId: string }): Promise<{ cancelled: boolean }> {
    this.requireConversation(request.conversationId);
    if (!this.active?.cancellable || this.active.runId !== request.runId) return Promise.resolve({ cancelled: false });
    this.active.abort.abort();
    return Promise.resolve({ cancelled: true });
  }

  readModelSettings() {
    if (!this.settings) throw new Error('Model settings unavailable');
    return this.settings.readPublic();
  }

  readWorkspace(): Promise<WorkspaceState> {
    return Promise.resolve(this.workspace?.read() ?? { ...EMPTY_WORKSPACE });
  }

  readPendingFileEdit(): Promise<PendingFileEdit | null> {
    if (this.stopping || this.storageFailed || !this.active?.cancellable) return Promise.resolve(null);
    return Promise.resolve(this.editApprovals.readPending());
  }

  decideFileEdit(request: DecideFileEditRequest): Promise<DecideFileEditResult> {
    if (this.storageFailed) return Promise.resolve({ ok: false, code: 'JOURNAL_WRITE_FAILED' });
    if (this.stopping || !this.active?.cancellable || this.active.runId !== request.runId) {
      return Promise.resolve({ ok: false, code: 'APPROVAL_UNAVAILABLE' });
    }
    return Promise.resolve(this.editApprovals.decide(request));
  }

  readPendingCommand(): Promise<PendingCommandApproval | null> {
    if (this.stopping || this.storageFailed || !this.active?.cancellable) return Promise.resolve(null);
    return Promise.resolve(this.commandApprovals.readPending());
  }

  decideCommand(request: { conversationId: string; runId: string; approvalId: string; bindingDigest: string; decision: 'approved' | 'rejected' }): Promise<CommandApprovalResult> {
    if (this.storageFailed) return Promise.resolve({ ok: false, code: 'JOURNAL_WRITE_FAILED' });
    if (this.stopping || !this.active?.cancellable || this.active.runId !== request.runId) return Promise.resolve({ ok: false, code: 'APPROVAL_UNAVAILABLE' });
    return Promise.resolve(this.commandApprovals.decide(request));
  }

  chooseWorkspace(): Promise<WorkspaceResult> {
    return this.changeWorkspace(async () => {
      const selected = await this.pickDirectory?.();
      if (this.stopping) return { ok: false, code: 'WORKSPACE_UNAVAILABLE' };
      return { ok: true, workspace: selected ? await this.workspace!.select(selected) : this.workspace!.read() };
    });
  }

  setWorkspaceConsent(request: { dataEgressConsent: boolean }): Promise<WorkspaceResult> {
    return this.changeWorkspace(async () => ({ ok: true,
      workspace: this.workspace!.setConsent(request.dataEgressConsent) }));
  }

  clearWorkspace(): Promise<WorkspaceResult> {
    return this.changeWorkspace(async () => ({ ok: true, workspace: this.workspace!.clear() }));
  }

  readKnowledgeState(): Promise<KnowledgeState> {
    if (!this.knowledge) return Promise.resolve({ ...EMPTY_KNOWLEDGE_STATE });
    return this.knowledge.readState(this.workspace?.read() ?? { root: null, name: null, dataEgressConsent: false });
  }

  syncKnowledge(): Promise<KnowledgeState> {
    if (!this.knowledge || !this.workspace?.read().root || this.pendingSubmissions || this.active || this.changingSettings) {
      return Promise.resolve({ ...EMPTY_KNOWLEDGE_STATE, lastError: '当前任务尚未结束或工作区不可用' });
    }
    this.changingSettings = true;
    const current = this.workspace.read();
    return this.knowledge.sync(current).catch(() => ({ ...EMPTY_KNOWLEDGE_STATE,
      projectKey: current.root, lastError: '知识索引同步失败' })).finally(() => { this.changingSettings = false; });
  }

  searchKnowledge(request: { query: string }): Promise<KnowledgeSearchResult[]> {
    if (!this.knowledge || !this.workspace?.read().root || !this.workspace.read().dataEgressConsent) return Promise.resolve([]);
    return this.knowledge.search(this.workspace.read(), request.query).catch(() => []);
  }

  readProjectKnowledge(): Promise<ProjectKnowledgeSummary | null> {
    if (!this.knowledge || !this.workspace?.read().root || !this.workspace.read().dataEgressConsent) return Promise.resolve(null);
    return this.knowledge.readProjectKnowledge(this.workspace.read()).catch(() => null);
  }

  readMemories(): Promise<ManagedMemory[]> {
    if (!this.knowledge) return Promise.resolve([]);
    return this.knowledge.readMemories(this.workspace?.read() ?? { root: null, name: null, dataEgressConsent: false });
  }

  saveMemory(request: { scope: MemoryScope; content: string }): Promise<ManagedMemory | null> {
    if (!this.knowledge || this.active || this.pendingSubmissions || this.stopping) return Promise.resolve(null);
    const current = this.workspace?.read() ?? { root: null, name: null, dataEgressConsent: false };
    return this.knowledge.saveMemory(current, request.scope, request.content).catch(() => null);
  }

  deleteMemory(request: { id: string }): Promise<{ deleted: boolean }> {
    if (!this.knowledge || this.active || this.pendingSubmissions || this.stopping) return Promise.resolve({ deleted: false });
    return this.knowledge.deleteMemory(request.id).then((deleted) => ({ deleted })).catch(() => ({ deleted: false }));
  }

  readSkills() {
    return this.skills?.list() ?? Promise.resolve([]);
  }

  setSkillEnabled(request: { id: string; enabled: boolean }) {
    if (this.active || this.pendingSubmissions || this.changingSettings || this.stopping) {
      return Promise.reject(new Error('当前任务尚未结束'));
    }
    return this.skills?.setEnabled(request.id, request.enabled) ?? Promise.resolve([]);
  }

  private async changeWorkspace(operation: () => Promise<WorkspaceResult>): Promise<WorkspaceResult> {
    if (!this.workspace || this.stopping || this.storageFailed) return { ok: false, code: 'WORKSPACE_UNAVAILABLE' };
    if (this.pendingSubmissions || this.active || this.changingSettings) return { ok: false, code: 'RUN_ACTIVE' };
    this.changingSettings = true;
    try { return await operation(); }
    catch { return { ok: false, code: 'WORKSPACE_UNAVAILABLE' }; }
    finally { this.changingSettings = false; }
  }

  saveModelSettings(request: SaveModelSettingsRequest): Promise<ModelSettingsResult> {
    return this.changeSettings(() => this.settings!.save(request));
  }

  deleteModelApiKey(): Promise<ModelSettingsResult> {
    return this.changeSettings(() => this.settings!.deleteApiKey());
  }

  private async changeSettings(operation: () => Promise<ModelSettingsResult>): Promise<ModelSettingsResult> {
    if (!this.settings) return { ok: false, code: 'SETTINGS_WRITE_FAILED' };
    if (this.pendingSubmissions || this.active || this.changingSettings || this.stopping) return { ok: false, code: 'RUN_ACTIVE' };
    this.changingSettings = true;
    try { return await operation(); }
    catch { return { ok: false, code: 'SETTINGS_WRITE_FAILED' }; }
    finally { this.changingSettings = false; }
  }

  async readConversation(conversationId: string): Promise<EventEnvelope[]> {
    this.requireConversation(conversationId);
    await this.initialize();
    return this.store.readAll(conversationId);
  }

  private requireConversation(conversationId: string): void {
    if (conversationId !== DEFAULT_CONVERSATION_ID) throw new Error('Unknown conversation');
  }

  private async persist<T extends EventType>(type: T, payload: EventPayloads[T]): Promise<void> {
    const event = {
      schemaVersion: 1, eventId: randomUUID(), conversationId: DEFAULT_CONVERSATION_ID,
      sequence: this.nextSequence, occurredAt: new Date().toISOString(), type, payload,
    } as EventEnvelope;
    try {
      await this.store.append(event);
    } catch {
      this.storageFailed = true;
      throw new Error('Local journal write failed. Reopen the application before continuing.');
    }
    this.nextSequence++;
    for (const listener of this.listeners) {
      try { listener(event); } catch { console.error('Event subscriber failed'); }
    }
  }

  subscribe(listener: (event: EventEnvelope) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  async shutdown(): Promise<void> {
    this.stopping = true;
    this.active?.abort.abort();
    await this.queue;
  }
}
