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
import { WorkspacePolicyError } from '../workspace/workspace-session';
import { FileEditApprovals } from './file-edit-approvals';
import type { DecideFileEditRequest, DecideFileEditResult, PendingFileEdit } from '../../shared/file-edit';
import { EMPTY_KNOWLEDGE_STATE, type KnowledgeSearchResult, type KnowledgeState, type ManagedMemory, type MemoryScope, type ProjectKnowledgeSummary } from '../../shared/knowledge';
import type { KnowledgeService } from '../knowledge/knowledge-service';
import type { SkillService } from '../skills/skill-service';
import { CommandApprovals } from './command-approvals';
import type { PendingCommandApproval, CommandApprovalResult } from '../../shared/command';
import { taskId, taskObject, taskAssert, unknownTaskEffects,
  type TaskAccess, type TaskRecord, type TaskResumeRequest, type TaskFinishStatus } from '../../shared/tasks';
import { TaskStore, TaskStoreError, taskWorkspaceIdentity } from '../tasks/task-store';
import type { ChangeSetService } from '../changes/change-set-service';
import type { ChangeSetEvent, ChangeSetEventPayload, DecideChangeSetRequest, DecideChangeSetResult,
  PendingChangeSet, ChangeSetRecord, ChangeDelivery } from '../../shared/change-set';

export class RunCoordinator {
  private nextSequence = 1;
  private initialization: Promise<void> | undefined;
  private queue: Promise<void> = Promise.resolve();
  private journalQueue: Promise<void> = Promise.resolve();
  private readonly seen = new Map<string, string>();
  private readonly listeners = new Set<(event: EventEnvelope) => void>();
  private active: { runId: string; taskId?: string; abort: AbortController; cancellable: boolean;
    stopReason?: 'paused' | 'cancelled' | 'interrupted'; done: Promise<void>; settle: () => void } | undefined;
  private pendingSubmissions = 0;
  private changingSettings = false;
  private storageFailed = false;
  private stopping = false;
  private restartRequired = false;
  private maintenance: Promise<unknown> | undefined;
  private readonly editApprovals = new FileEditApprovals();
  private readonly commandApprovals: CommandApprovals;

  constructor(private readonly store: EventStore, private readonly provider: AgentProvider,
    private readonly settings?: ModelSettingsStore, private readonly workspace?: WorkspaceSession,
    private readonly pickDirectory?: () => Promise<string | undefined>,
    private readonly knowledge?: KnowledgeService,
    private readonly skills?: SkillService, commandApprovals?: CommandApprovals,
    private readonly tasks?: TaskStore, private readonly changes?: ChangeSetService) {
    this.commandApprovals = commandApprovals ?? new CommandApprovals();
  }

  initialize(): Promise<void> {
    return this.initialization ??= this.restore();
  }

  private async restore(): Promise<void> {
    if (this.tasks) await this.saveTask(() => this.tasks!.interruptActive());
    if (this.changes) await this.readChanges(() => this.changes!.list());
    let events: EventEnvelope[];
    try { events = await this.store.readAll(DEFAULT_CONVERSATION_ID); }
    catch { this.storageFailed = true; throw new Error('会话日志读取失败，请检查原数据后重新启动。'); }
    const unfinished = new Set<string>();
    for (const event of events) {
      if (event.sequence !== this.nextSequence) {
        this.storageFailed = true; throw new Error('会话日志序号不连续，请检查原数据后重新启动。');
      }
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
    this.requireAvailable();
    this.pendingSubmissions++;
    try {
      await this.initialize();
      this.requireAvailable();
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

  private async run(request: SubmitMessageRequest, resume?: TaskResumeRequest,
    onStarted?: (record: TaskRecord) => void): Promise<void> {
    this.requireAvailable();
    const previous = this.seen.get(request.clientRequestId);
    if (!resume && previous !== undefined) {
      if (previous !== request.text) throw new Error('Request key already belongs to a different prompt');
      return;
    }
    const messageId = randomUUID();
    const runId = randomUUID();
    const agentMessageId = randomUUID();
    const configuration = await this.settings?.readPublic();
    const workspace = this.workspace?.snapshot() ?? { ...EMPTY_WORKSPACE };
    // Never carry evidence from another workspace or previously revoked access into a new task.
    const history = !resume && configuration?.provider === 'deepseek' && !workspace.root ? await this.readContext() : [];
    this.requireAvailable();
    const abort = new AbortController();
    let settle!: () => void;
    const done = new Promise<void>((resolve) => { settle = resolve; });
    const active = { runId, abort, cancellable: true, done, settle } as NonNullable<typeof this.active>;
    this.active = active;
    let record: TaskRecord | undefined;
    let resumeContext: string | undefined;
    let modelSummary = '';
    let runPublished = false;
    const startedAt = Date.now();
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const metadata = configuration ? { provider: configuration.provider,
      model: configuration.provider === 'mock' ? 'deterministic-local' : configuration.model } : {};
    try {
      if (this.stopping) { active.stopReason = 'interrupted'; abort.abort(); }
      abort.signal.throwIfAborted();
      if (this.tasks) {
        if (resume) {
          if (workspace.root) {
            taskAssert(workspace.dataEgressConsent === true, '请重新授权原工作区后续接。');
          }
          const prepared = await this.readTask(() => this.tasks!.prepareResume(resume.taskId, workspace.root, resume.acknowledgeUnknown));
          resumeContext = prepared.checkpoint.summary;
          taskAssert(prepared.prompt === request.text, '续接原始输入发生变化。');
        }
        record = await this.readTask(() => this.tasks!.startRun(resume?.taskId, request.text,
          workspace.root, runId));
        active.taskId = record.taskId;
      }
      abort.signal.throwIfAborted();
      await this.persist('message.user.created', { messageId, clientRequestId: request.clientRequestId, text: request.text });
      this.seen.set(request.clientRequestId, request.text);
      await this.persist('run.started', { runId, sourceMessageId: messageId, ...metadata,
        workspaceAttached: configuration?.provider === 'deepseek' && !!workspace.root && workspace.dataEgressConsent });
      runPublished = true;
      await this.persist('message.agent.created', { messageId: agentMessageId, runId });
      if (record) onStarted?.(record);
      timer = setTimeout(() => { timedOut = true; abort.abort(); }, configuration?.timeoutMs ?? 90_000);
      if (this.stopping) abort.abort();
      const selectedSkills = this.skills ? await this.skills.select(request.text) : { names: [], instructions: '' };
      const taskAccess: TaskAccess | undefined = record && this.tasks ? {
        get: async (id) => {
          taskAssert(id === record!.taskId, '只能读取本次绑定任务。');
          return this.readTask(() => this.tasks!.get(id));
        },
        updatePlan: async (id, steps) => {
          taskAssert(id === record!.taskId && this.active === active && active.cancellable && !abort.signal.aborted,
            '只能更新当前活动任务计划。');
          try { await this.tasks!.updatePlan(id, steps); }
          catch (error) {
            if (this.isStorageError(error)) { this.storageFailed = true; abort.abort(); }
            throw error;
          }
        },
      } : undefined;
      const reply = await this.provider.streamReply({ text: request.text, runId, history, workspace,
        taskId: record?.taskId, tasks: taskAccess, resumeContext, changes: this.changes,
        knowledge: this.knowledge, skills: selectedSkills,
        onApproval: async (type: ChangeSetEvent | 'command.approval.requested' | 'command.approval.decided',
          payload: ChangeSetEventPayload | EventPayloads['command.approval.requested'] | EventPayloads['command.approval.decided']) => {
          this.requireRun(active);
          taskAssert(payload.runId === runId, '审批事件不属于当前运行。');
          if (type.startsWith('change-set.')) {
            taskAssert(record && 'taskId' in payload && payload.taskId === record.taskId, '变更事件不属于当前任务。');
          }
          if (record && (type.endsWith('.requested') || type.endsWith('.decided'))) {
            await this.saveTask(() => this.tasks!.recordApproval(record!.taskId,
              type as Parameters<TaskStore['recordApproval']>[1], payload));
          }
          await this.persist(type, payload);
        },
        onFileEdit: async (toolCallId, proposal, apply, signal) => {
          abort.signal.throwIfAborted();
          if (!workspace.root || !workspace.dataEgressConsent || this.active?.runId !== runId) {
            throw new ProviderError('WORKSPACE_UNAVAILABLE');
          }
          return this.editApprovals.request({ runId, toolCallId, workspaceRoot: workspace.root },
            proposal, apply, AbortSignal.any([abort.signal, signal]),
            async (type, payload) => {
              this.requireRun(active);
              if (record && (type === 'approval.requested' || type === 'approval.decided')) {
                await this.saveTask(() => this.tasks!.recordApproval(record!.taskId, type, payload));
              }
              await this.persist(type, payload);
            });
        },
        onTool: async (progress) => {
          this.requireRun(active);
          if (progress.type === 'started') abort.signal.throwIfAborted();
          if (record) await this.saveTask(() => this.tasks!.recordTool(record!.taskId, { ...progress, runId }));
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
        modelSummary = (modelSummary + text).slice(-10_000);
        await this.persist('message.agent.delta', { messageId: agentMessageId, runId, text });
      });
      abort.signal.throwIfAborted();
      this.requireRun(active);
      active.cancellable = false;
      if (timer) clearTimeout(timer);
      if (record) {
        await this.saveTask(() => this.tasks!.appendContext(record!.taskId,
          `模型输出节选（未经独立验证，不是完成证据）：\n${modelSummary}`));
        const finalRecord = await this.readTask(() => this.tasks!.get(record!.taskId));
        let status: TaskFinishStatus = 'paused';
        const completePlan = finalRecord.plan.steps.length > 0 && finalRecord.plan.steps.every((step) => step.status === 'completed');
        const confirmed = unknownTaskEffects(finalRecord).length === 0
          && !finalRecord.toolCalls.some((call) => call.runId === runId && call.phase === 'started');
        const writes = finalRecord.toolCalls.filter((call) => call.sideEffect === 'file_write');
        const changeSets = this.changes ? await this.readChanges(() => this.changes!.list(record!.taskId)) : [];
        let deliveryConfirmed = writes.length === 0 && changeSets.length === 0
          && !finalRecord.toolCalls.some((call) => call.sideEffect === 'command');
        if (this.changes && changeSets.length > 0 && workspace.root && workspace.dataEgressConsent) {
          const delivery = await this.readChanges(() => this.changes!.getDelivery(record!.taskId, workspace, abort.signal));
          // 旧单文件编辑和任意命令不能凭变更集报告推断其验证覆盖范围。
          const coveredWrites = writes.every((call) => call.toolName === 'propose_change_set'
            && delivery.changeSets.some((change) => change.runId === call.runId
              && change.toolCallId === call.toolCallId && change.status === 'applied'));
          const uncoveredCommands = finalRecord.toolCalls.some((call) => call.sideEffect === 'command'
            && call.toolName !== 'run_verification');
          deliveryConfirmed = coveredWrites && !uncoveredCommands && delivery.canComplete
            && delivery.verification === 'passed';
          await this.saveTask(() => this.tasks!.appendContext(record!.taskId,
            `真实交付查询：代次 ${delivery.generation}；验证 ${delivery.verification}；可完成 ${delivery.canComplete}。${delivery.verificationReason}`));
        }
        if (reply && reply.stopReason === 'stop' && completePlan && confirmed && deliveryConfirmed) status = 'completed';
        await this.saveTask(() => this.tasks!.finishRun(record!.taskId, status));
      }
      await this.persist('run.completed', { runId, messageId: agentMessageId,
        ...(reply ?? {}), durationMs: Math.max(0, Date.now() - startedAt) });
    } catch (error) {
      active.cancellable = false;
      if (this.storageFailed) throw error;
      if (record) {
        if (modelSummary) await this.saveTask(() => this.tasks!.appendContext(record!.taskId,
          `中止前模型输出节选（未经独立验证）：\n${modelSummary}`));
        const status: TaskFinishStatus = active.stopReason ?? (timedOut ? 'interrupted' : abort.signal.aborted ? 'cancelled' : 'failed');
        await this.saveTask(() => this.tasks!.finishRun(record!.taskId, status,
          timedOut ? RUN_ERROR_MESSAGES.RUN_TIMEOUT : active.stopReason === 'paused' ? '用户暂停了当前运行。'
            : active.stopReason === 'interrupted' ? RUN_ERROR_MESSAGES.RUN_INTERRUPTED
              : abort.signal.aborted ? RUN_ERROR_MESSAGES.RUN_CANCELLED : '本轮运行失败，实际工具结果请核对任务记录。'));
      }
      if (!runPublished) throw error;
      const code = timedOut ? 'RUN_TIMEOUT' : active.stopReason === 'paused' ? 'RUN_PAUSED'
        : active.stopReason === 'interrupted' ? 'RUN_INTERRUPTED' : abort.signal.aborted ? 'RUN_CANCELLED'
        : error instanceof ProviderError ? error.code : 'PROVIDER_FAILED';
      await this.persist('run.failed', {
        runId,
        code,
        message: timedOut ? RUN_ERROR_MESSAGES.RUN_TIMEOUT : active.stopReason === 'paused' ? '用户暂停了当前运行。'
          : active.stopReason === 'interrupted' ? RUN_ERROR_MESSAGES.RUN_INTERRUPTED
          : abort.signal.aborted ? RUN_ERROR_MESSAGES.RUN_CANCELLED
            : error instanceof ProviderError ? error.message : RUN_ERROR_MESSAGES.PROVIDER_FAILED,
      });
    } finally {
      if (timer) clearTimeout(timer);
      this.active = undefined;
      active.settle();
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
    if (this.active.stopReason) return Promise.resolve({ cancelled: false });
    this.active.stopReason = 'cancelled';
    this.active.abort.abort();
    return Promise.resolve({ cancelled: true });
  }

  async readTasks(): Promise<TaskRecord[]> {
    this.requireAvailable();
    await this.initialize();
    this.requireAvailable();
    return this.tasks ? this.readTask(() => this.tasks!.list()) : [];
  }

  pauseTask(request: { taskId: string }): Promise<{ ok: boolean }> {
    return this.stopTask(request, 'paused');
  }

  cancelTask(request: { taskId: string }): Promise<{ ok: boolean }> {
    return this.stopTask(request, 'cancelled');
  }

  private async stopTask(request: { taskId: string }, reason: 'paused' | 'cancelled'): Promise<{ ok: boolean }> {
    const input = taskObject(request, ['taskId']); taskId(input.taskId);
    if (this.storageFailed || this.restartRequired || this.stopping) this.requireAvailable();
    const active = this.active;
    if (!active?.cancellable || active.taskId !== input.taskId || active.stopReason) return { ok: false };
    active.stopReason = reason;
    active.abort.abort();
    // 等待审批取消及已开始工具的真实结果写入，再向面板返回最终状态。
    await active.done;
    this.requireAvailable();
    const record = await this.readTask(() => this.tasks!.get(input.taskId as string));
    return { ok: record.status === reason };
  }

  async resumeTask(request: TaskResumeRequest): Promise<TaskRecord | { ok: false; code: string }> {
    const input = taskObject(request, ['taskId', 'acknowledgeUnknown']); taskId(input.taskId);
    taskAssert(typeof input.acknowledgeUnknown === 'boolean', '续接必须明确确认是否核对未知副作用。');
    this.requireAvailable();
    if (!this.tasks || this.pendingSubmissions || this.active) return { ok: false, code: 'RUN_ACTIVE' };
    this.pendingSubmissions++;
    let handedOff = false;
    try {
      await this.initialize(); this.requireAvailable();
      const record = await this.readTask(() => this.tasks!.get(request.taskId));
      const submit: SubmitMessageRequest = { conversationId: DEFAULT_CONVERSATION_ID,
        clientRequestId: randomUUID(), text: record.prompt };
      let resolveStarted!: (record: TaskRecord) => void;
      let rejectStarted!: (error: unknown) => void;
      const started = new Promise<TaskRecord>((resolve, reject) => { resolveStarted = resolve; rejectStarted = reject; });
      const execution = this.queue.then(() => this.run(submit, request, resolveStarted));
      const settled = execution.then(() => { rejectStarted(new Error('任务未能开始续接，请查看任务状态。')); }, rejectStarted)
        .finally(() => { this.pendingSubmissions--; });
      this.queue = settled;
      handedOff = true;
      // IPC 返回新的活动记录；生命周期仍归属协调器，关闭/暂停会等待 execution。
      return await started;
    } finally {
      if (!handedOff) this.pendingSubmissions--;
    }
  }

  readPendingChangeSet(): Promise<PendingChangeSet | null> {
    if (this.stopping || this.storageFailed || this.restartRequired || !this.active?.cancellable
      || this.active.abort.signal.aborted) return Promise.resolve(null);
    return Promise.resolve(this.changes?.readPending() ?? null);
  }

  decideChangeSet(request: DecideChangeSetRequest): Promise<DecideChangeSetResult> {
    if (!this.changes || this.stopping || this.storageFailed || this.restartRequired || !this.active?.cancellable
      || this.active.abort.signal.aborted || this.active.runId !== request.runId || this.active.taskId !== request.taskId) {
      return Promise.resolve({ ok: false, code: 'APPROVAL_UNAVAILABLE' });
    }
    return Promise.resolve(this.changes.decide(request));
  }

  async readChangeSets(id?: string): Promise<ChangeSetRecord[]> {
    this.requireAvailable(); if (id !== undefined) taskId(id);
    await this.initialize(); this.requireAvailable();
    return this.changes ? this.readChanges(() => this.changes!.list(id)) : [];
  }

  getDelivery(id: string): Promise<ChangeDelivery> {
    taskId(id);
    return this.withMaintenance(async () => {
      if (!this.tasks || !this.changes) throw new Error('任务交付服务不可用。');
      const record = await this.readTask(() => this.tasks!.get(id));
      const workspace = this.workspace?.snapshot();
      taskAssert(workspace?.root && workspace.dataEgressConsent, '请重新选择并授权任务原工作区后查询交付。');
      const identity = await taskWorkspaceIdentity(workspace.root);
      taskAssert(record.workspaceRoot === identity.root && record.workspaceIdentity === identity.fingerprint,
        '当前授权工作区路径或目录身份与任务不一致。');
      return this.readChanges(() => this.changes!.getDelivery(id, workspace));
    });
  }

  isTaskActive(): boolean {
    return !!this.active || this.pendingSubmissions > 0;
  }

  requireRestart(): void {
    this.restartRequired = true;
    if (this.active) { this.active.stopReason = 'interrupted'; this.active.abort.abort(); }
  }

  async withMaintenance<T>(operation: () => Promise<T>): Promise<T> {
    this.requireAvailable();
    if (this.changingSettings || this.isTaskActive()) throw new Error('已有任务或维护操作，请等待结束后再维护数据。');
    this.changingSettings = true;
    const maintenance = Promise.resolve().then(async () => {
      await this.initialize();
      if (this.stopping || this.storageFailed || this.restartRequired) throw new Error('当前应用状态不允许维护，请重新启动。');
      return operation();
    });
    this.maintenance = maintenance;
    try { return await maintenance; }
    finally { this.changingSettings = false; this.maintenance = undefined; }
  }

  private requireAvailable(): void {
    if (this.storageFailed) throw new Error('本地存储失败，已停止执行；请检查数据并重新启动应用。');
    if (this.restartRequired) throw new Error('数据恢复后必须重新启动应用，才能继续任务或更改设置。');
    if (this.stopping) throw new Error('应用正在关闭。');
    if (this.changingSettings) throw new Error('正在维护数据或更新设置，请稍后操作。');
  }

  private requireRun(active: NonNullable<RunCoordinator['active']>): void {
    if (this.active !== active || !active.cancellable || this.storageFailed || this.restartRequired) {
      throw new Error('运行已结束或存储不可用，拒绝迟到回调。');
    }
    // 取消后的结束回调仍须落盘，不能只因 signal.aborted 抹去已发生的结果。
  }

  private isStorageError(error: unknown): boolean {
    return error instanceof TaskStoreError && ['TASK_READ_FAILED', 'TASK_WRITE_FAILED', 'TASK_SCHEMA_INVALID'].includes(error.code);
  }

  private async readTask<T>(operation: () => Promise<T>): Promise<T> {
    try { return await operation(); }
    catch (error) {
      if (this.isStorageError(error)) { this.storageFailed = true; this.active?.abort.abort(); }
      throw error;
    }
  }

  private async saveTask<T>(operation: () => Promise<T>): Promise<T> {
    try { return await operation(); }
    catch (error) { this.storageFailed = true; this.active?.abort.abort(); throw error; }
  }

  private async readChanges<T>(operation: () => Promise<T>): Promise<T> {
    try { return await operation(); }
    catch (error) {
      // 授权/路径拒绝可纠正；变更记录读写失败不能作为普通工具错误继续运行。
      if (!(error instanceof WorkspacePolicyError) && !this.active?.abort.signal.aborted) {
        this.storageFailed = true; this.active?.abort.abort();
      }
      throw error;
    }
  }

  readModelSettings() {
    if (!this.settings) throw new Error('Model settings unavailable');
    return this.settings.readPublic();
  }

  readWorkspace(): Promise<WorkspaceState> {
    return Promise.resolve(this.workspace?.read() ?? { ...EMPTY_WORKSPACE });
  }

  readPendingFileEdit(): Promise<PendingFileEdit | null> {
    if (this.stopping || this.storageFailed || this.restartRequired || !this.active?.cancellable
      || this.active.abort.signal.aborted) return Promise.resolve(null);
    return Promise.resolve(this.editApprovals.readPending());
  }

  decideFileEdit(request: DecideFileEditRequest): Promise<DecideFileEditResult> {
    if (this.storageFailed) return Promise.resolve({ ok: false, code: 'JOURNAL_WRITE_FAILED' });
    if (this.stopping || this.restartRequired || !this.active?.cancellable || this.active.abort.signal.aborted || this.active.runId !== request.runId) {
      return Promise.resolve({ ok: false, code: 'APPROVAL_UNAVAILABLE' });
    }
    return Promise.resolve(this.editApprovals.decide(request));
  }

  readPendingCommand(): Promise<PendingCommandApproval | null> {
    if (this.stopping || this.storageFailed || this.restartRequired || !this.active?.cancellable
      || this.active.abort.signal.aborted) return Promise.resolve(null);
    return Promise.resolve(this.commandApprovals.readPending());
  }

  decideCommand(request: { conversationId: string; runId: string; approvalId: string; bindingDigest: string; decision: 'approved' | 'rejected' }): Promise<CommandApprovalResult> {
    if (this.storageFailed) return Promise.resolve({ ok: false, code: 'JOURNAL_WRITE_FAILED' });
    if (this.stopping || this.restartRequired || !this.active?.cancellable || this.active.abort.signal.aborted
      || this.active.runId !== request.runId || request.conversationId !== DEFAULT_CONVERSATION_ID) return Promise.resolve({ ok: false, code: 'APPROVAL_UNAVAILABLE' });
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
    if (!this.knowledge || !this.workspace?.read().root || this.pendingSubmissions || this.active || this.changingSettings
      || this.stopping || this.storageFailed || this.restartRequired) {
      return Promise.resolve({ ...EMPTY_KNOWLEDGE_STATE, lastError: '当前任务尚未结束或工作区不可用' });
    }
    const current = this.workspace.read();
    return this.withMaintenance(() => this.knowledge!.sync(current)).catch(() => ({ ...EMPTY_KNOWLEDGE_STATE,
      projectKey: current.root, lastError: '知识索引同步失败或当前状态不允许维护' }));
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
    if (!this.knowledge || this.active || this.pendingSubmissions || this.stopping || this.changingSettings
      || this.storageFailed || this.restartRequired) return Promise.resolve(null);
    const current = this.workspace?.read() ?? { root: null, name: null, dataEgressConsent: false };
    return this.withMaintenance(() => this.knowledge!.saveMemory(current, request.scope, request.content)).catch(() => null);
  }

  deleteMemory(request: { id: string }): Promise<{ deleted: boolean }> {
    if (!this.knowledge || this.active || this.pendingSubmissions || this.stopping || this.changingSettings
      || this.storageFailed || this.restartRequired) return Promise.resolve({ deleted: false });
    return this.withMaintenance(() => this.knowledge!.deleteMemory(request.id)).then((deleted) => ({ deleted })).catch(() => ({ deleted: false }));
  }

  readSkills() {
    return this.skills?.list() ?? Promise.resolve([]);
  }

  setSkillEnabled(request: { id: string; enabled: boolean }) {
    if (this.active || this.pendingSubmissions || this.changingSettings || this.stopping || this.storageFailed || this.restartRequired) {
      return Promise.reject(new Error('当前任务尚未结束'));
    }
    return this.withMaintenance(() => this.skills?.setEnabled(request.id, request.enabled) ?? Promise.resolve([]));
  }

  private async changeWorkspace(operation: () => Promise<WorkspaceResult>): Promise<WorkspaceResult> {
    if (!this.workspace || this.stopping || this.storageFailed || this.restartRequired) return { ok: false, code: 'WORKSPACE_UNAVAILABLE' };
    if (this.pendingSubmissions || this.active || this.changingSettings) return { ok: false, code: 'RUN_ACTIVE' };
    try { return await this.withMaintenance(operation); }
    catch { return { ok: false, code: 'WORKSPACE_UNAVAILABLE' }; }
  }

  saveModelSettings(request: SaveModelSettingsRequest): Promise<ModelSettingsResult> {
    return this.changeSettings(() => this.settings!.save(request));
  }

  deleteModelApiKey(): Promise<ModelSettingsResult> {
    return this.changeSettings(() => this.settings!.deleteApiKey());
  }

  private async changeSettings(operation: () => Promise<ModelSettingsResult>): Promise<ModelSettingsResult> {
    if (!this.settings) return { ok: false, code: 'SETTINGS_WRITE_FAILED' };
    if (this.pendingSubmissions || this.active || this.changingSettings || this.stopping || this.storageFailed || this.restartRequired) return { ok: false, code: 'RUN_ACTIVE' };
    try { return await this.withMaintenance(operation); }
    catch { return { ok: false, code: 'SETTINGS_WRITE_FAILED' }; }
  }

  async readConversation(conversationId: string): Promise<EventEnvelope[]> {
    this.requireConversation(conversationId);
    await this.initialize();
    return this.store.readAll(conversationId);
  }

  private requireConversation(conversationId: string): void {
    if (conversationId !== DEFAULT_CONVERSATION_ID) throw new Error('Unknown conversation');
  }

  private persist<T extends EventType>(type: T, payload: EventPayloads[T]): Promise<void> {
    const captured = structuredClone(payload);
    const pending = this.journalQueue.then(async () => {
      if (this.storageFailed) throw new Error('本地存储不可用，拒绝发布事件。');
      const event = {
        schemaVersion: 1, eventId: randomUUID(), conversationId: DEFAULT_CONVERSATION_ID,
        sequence: this.nextSequence, occurredAt: new Date().toISOString(), type, payload: captured,
      } as EventEnvelope;
      try { await this.store.append(event); }
      catch {
        this.storageFailed = true; this.active?.abort.abort();
        throw new Error('本地会话日志写入失败，已停止执行；请检查数据并重新启动应用。');
      }
      this.nextSequence++;
      for (const listener of this.listeners) {
        try { listener(event); } catch { console.error('事件订阅回调失败'); }
      }
    });
    this.journalQueue = pending.then(() => undefined, () => undefined);
    return pending;
  }

  subscribe(listener: (event: EventEnvelope) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  async shutdown(): Promise<void> {
    this.stopping = true;
    if (this.active) { this.active.stopReason ??= 'interrupted'; this.active.abort.abort(); }
    if (this.initialization) await this.initialization.catch(() => undefined);
    await this.queue;
    if (this.active) await this.active.done;
    if (this.maintenance) await this.maintenance.catch(() => undefined);
    await this.journalQueue;
  }
}
