export const TASK_SCHEMA_VERSION = 1;
export const MAX_TASK_PROMPT = 20_000;
export const MAX_TASK_STEPS = 40;
export const MAX_TASK_CONTEXT = 12_000;
export const MAX_TASK_CHECKPOINT = 18_000;
export const MAX_TASK_TOOL_CALLS = 2_000;
export const MAX_TASK_APPROVALS = 1_000;
export const MAX_TASK_RUNS = 1_000;
export const MAX_TASK_RECORDS = 1_000;

export type TaskStatus = 'running' | 'waiting_approval' | 'paused' | 'cancelled'
  | 'interrupted' | 'completed' | 'failed';
export type TaskStepStatus = 'pending' | 'in_progress' | 'completed' | 'blocked' | 'cancelled';
export type TaskSideEffect = 'none' | 'file_write' | 'command' | 'browser_interaction' | 'unknown';
export type TaskFinishStatus = Exclude<TaskStatus, 'running' | 'waiting_approval'>;

export interface TaskPlanStep {
  id: string;
  title: string;
  status: TaskStepStatus;
  detail?: string;
  toolCallIds?: string[];
}

export interface TaskToolCall {
  runId: string;
  toolCallId: string;
  toolName: string;
  status: 'completed' | 'unknown';
  phase: 'started' | 'finished';
  sideEffect: TaskSideEffect;
  summary: string;
  startedAt: string;
  finishedAt?: string;
  isError?: boolean;
  durationMs?: number;
  acknowledgedAt?: string;
}

export type TaskApprovalType = 'approval.requested' | 'approval.decided'
  | 'command.approval.requested' | 'command.approval.decided'
  | 'change-set.approval.requested' | 'change-set.approval.decided';
export type TaskJson = null | boolean | number | string | TaskJson[] | { [key: string]: TaskJson };
export interface TaskApproval {
  runId: string;
  approvalId: string;
  toolCallId: string;
  type: TaskApprovalType;
  status: 'pending' | 'approved' | 'rejected' | 'expired' | 'cancelled';
  payload: { [key: string]: TaskJson };
  createdAt: string;
  updatedAt: string;
}

export interface TaskRecord {
  taskId: string;
  prompt: string;
  workspaceRoot: string | null;
  workspaceIdentity: string | null;
  plan: { steps: TaskPlanStep[]; updatedAt: string };
  runIds: string[];
  activeRunId: string | null;
  status: TaskStatus;
  context: string[];
  checkpoint: { summary: string; updatedAt: string };
  toolCalls: TaskToolCall[];
  approvals: TaskApproval[];
  createdAt: string;
  updatedAt: string;
  error?: string;
}

export interface TaskStoreDocument { schemaVersion: 1; tasks: TaskRecord[] }
export interface TaskAccess {
  get(id: string): Promise<TaskRecord>;
  updatePlan(id: string, steps: TaskPlanStep[]): Promise<void>;
}
export interface TaskResumeRequest { taskId: string; acknowledgeUnknown: boolean }
export interface TaskBridge {
  readTasks(): Promise<TaskRecord[]>;
  pauseTask(request: { taskId: string }): Promise<{ ok: boolean }>;
  cancelTask(request: { taskId: string }): Promise<{ ok: boolean }>;
  resumeTask(request: TaskResumeRequest): Promise<TaskRecord | { ok: false; code: string }>;
}
export interface TaskToolProgress {
  type: 'started' | 'completed';
  toolCallId: string;
  toolName: string;
  summary: string;
  runId?: string;
  sideEffect?: TaskSideEffect;
  status?: 'completed' | 'unknown';
  isError?: boolean;
  durationMs?: number;
  sources?: unknown[];
}

export function unknownTaskEffects(task: TaskRecord): TaskToolCall[] {
  return task.toolCalls.filter((call) => call.status === 'unknown' && call.sideEffect !== 'none');
}

export function unresolvedTaskEffects(task: TaskRecord): TaskToolCall[] {
  return unknownTaskEffects(task).filter((call) => !call.acknowledgedAt);
}

export class TaskValidationError extends Error {
  constructor(message: string) { super(message); this.name = 'TaskValidationError'; }
}

export function taskAssert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new TaskValidationError(message);
}

export function taskObject(value: unknown, required: string[], optional: string[] = []): Record<string, unknown> {
  taskAssert(value !== null && typeof value === 'object' && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value)), '任务数据必须是普通对象。');
  const descriptors = Object.getOwnPropertyDescriptors(value);
  taskAssert(Reflect.ownKeys(value).every((key) => typeof key === 'string'
    && (required.includes(key) || optional.includes(key))), '任务数据包含不支持的字段。');
  taskAssert(required.every((key) => Object.hasOwn(descriptors, key))
    && Object.values(descriptors).every((entry) => entry.enumerable && 'value' in entry),
  '任务数据缺少必要字段或包含访问器。');
  return value as Record<string, unknown>;
}

export function taskText(value: unknown, maximum: number, blank = false): asserts value is string {
  taskAssert(typeof value === 'string' && value.length <= maximum && (blank || value.trim().length > 0)
    && !value.includes('\u0000'), '任务文本为空、超出长度限制或包含空字符。');
}

export function taskId(value: unknown, maximum = 128): asserts value is string {
  taskText(value, maximum);
  taskAssert(/^[A-Za-z0-9_.:-]+$/.test(value), '任务或运行标识包含不支持的字符。');
}

export function taskCallId(value: unknown): asserts value is string {
  taskText(value, 256);
  taskAssert(!/[\u0000-\u001f\u007f-\u009f]/u.test(value), '工具调用 ID 不能包含控制字符。');
}

function timestamp(value: unknown): asserts value is string {
  taskText(value, 40);
  const millis = Date.parse(value);
  taskAssert(Number.isFinite(millis) && new Date(millis).toISOString() === value, '任务时间必须是标准 ISO 时间。');
}

function array(value: unknown, maximum: number): asserts value is unknown[] {
  taskAssert(Array.isArray(value) && value.length <= maximum, '任务列表格式错误或超过容量限制。');
  taskAssert(Reflect.ownKeys(value).length === value.length + 1
    && Array.from({ length: value.length }, (_, index) => index).every((index) => {
      const entry = Object.getOwnPropertyDescriptor(value, String(index));
      return entry && 'value' in entry && entry.enumerable;
    }), '任务列表必须是连续的普通数组。');
}

export function assertTaskSteps(value: unknown): asserts value is TaskPlanStep[] {
  array(value, MAX_TASK_STEPS);
  const ids = new Set<string>();
  let active = 0;
  for (const step of value) {
    const item = taskObject(step, ['id', 'title', 'status'], ['detail', 'toolCallIds']);
    taskId(item.id); taskText(item.title, 240);
    taskAssert(['pending', 'in_progress', 'completed', 'blocked', 'cancelled'].includes(item.status as string), '计划步骤状态无效。');
    taskAssert(!ids.has(item.id), '计划步骤标识不能重复。'); ids.add(item.id);
    if (item.status === 'in_progress') active++;
    if (item.detail !== undefined) taskText(item.detail, 800, true);
    if (item.toolCallIds !== undefined) {
      array(item.toolCallIds, 20);
      for (const id of item.toolCallIds) taskCallId(id);
      taskAssert(new Set(item.toolCallIds).size === item.toolCallIds.length, '计划工具证据 ID 不能重复。');
    }
    if (item.status === 'completed') taskAssert(Array.isArray(item.toolCallIds)
      && item.toolCallIds.length > 0, '完成步骤必须绑定真实工具证据，模型摘要不证明完成。');
  }
  taskAssert(active <= 1, '同一任务最多有一个进行中的计划步骤。');
}

export function assertTaskPayload(value: unknown): asserts value is { [key: string]: TaskJson } {
  let budget = 0;
  const seen = new Set<object>();
  function visit(item: unknown, depth: number): void {
    taskAssert(depth <= 6 && ++budget <= 512, '审批内容过深或过大。');
    if (item === null || typeof item === 'boolean') return;
    if (typeof item === 'number') { taskAssert(Number.isFinite(item), '审批数字必须有限。'); return; }
    if (typeof item === 'string') { taskText(item, 8_000, true); return; }
    taskAssert(item !== null && typeof item === 'object' && !seen.has(item), '审批内容不是可保存的 JSON。');
    seen.add(item);
    if (Array.isArray(item)) { array(item, 128); for (const child of item) visit(child, depth + 1); }
    else {
      const keys = Reflect.ownKeys(item);
      taskAssert(keys.every((key) => typeof key === 'string' && key.length <= 128
        && !['__proto__', 'prototype', 'constructor'].includes(key)), '审批字段无效。');
      const object = taskObject(item, keys as string[]);
      for (const child of Object.values(object)) visit(child, depth + 1);
    }
    seen.delete(item);
  }
  taskAssert(value !== null && typeof value === 'object' && !Array.isArray(value), '审批内容必须是 JSON 对象。');
  visit(value, 0);
  taskAssert(JSON.stringify(value).length <= 10_000, '审批内容超过保存上限。');
}

export function assertTaskRecord(value: unknown): asserts value is TaskRecord {
  const task = taskObject(value, ['taskId', 'prompt', 'workspaceRoot', 'workspaceIdentity', 'plan', 'runIds', 'activeRunId', 'status',
    'context', 'checkpoint', 'toolCalls', 'approvals', 'createdAt', 'updatedAt'], ['error']);
  taskId(task.taskId); taskText(task.prompt, MAX_TASK_PROMPT);
  if (task.workspaceRoot !== null) taskText(task.workspaceRoot, 2_000);
  if (task.workspaceRoot === null) taskAssert(task.workspaceIdentity === null, '无工作区任务不能带目录身份。');
  else {
    taskText(task.workspaceIdentity, 128);
    taskAssert(/^\d+:\d+:\d+$/.test(task.workspaceIdentity), '工作区目录身份无效。');
  }
  taskAssert(['running', 'waiting_approval', 'paused', 'cancelled', 'interrupted', 'completed', 'failed']
    .includes(task.status as string), '任务状态无效。');
  timestamp(task.createdAt); timestamp(task.updatedAt);
  if (task.error !== undefined) taskText(task.error, 2_000, true);
  const plan = taskObject(task.plan, ['steps', 'updatedAt']);
  assertTaskSteps(plan.steps); timestamp(plan.updatedAt);
  array(task.runIds, MAX_TASK_RUNS);
  taskAssert(task.runIds.length > 0, '任务必须包含运行编号。');
  for (const id of task.runIds) taskId(id);
  taskAssert(new Set(task.runIds).size === task.runIds.length, '任务运行编号重复。');
  const active = task.status === 'running' || task.status === 'waiting_approval';
  taskAssert(active ? typeof task.activeRunId === 'string' && task.activeRunId === task.runIds.at(-1)
    : task.activeRunId === null, '任务活动运行编号与状态不一致。');
  array(task.context, 24);
  for (const text of task.context) taskText(text, MAX_TASK_CONTEXT, true);
  taskAssert((task.context as string[]).reduce((size, text) => size + text.length, 0) <= MAX_TASK_CONTEXT, '任务上下文超出上限。');
  const checkpoint = taskObject(task.checkpoint, ['summary', 'updatedAt']);
  taskText(checkpoint.summary, MAX_TASK_CHECKPOINT, true); timestamp(checkpoint.updatedAt);
  array(task.toolCalls, MAX_TASK_TOOL_CALLS);
  const calls = new Set<string>();
  for (const entry of task.toolCalls) {
    const call = taskObject(entry, ['runId', 'toolCallId', 'toolName', 'status', 'phase', 'sideEffect', 'summary', 'startedAt'],
      ['finishedAt', 'isError', 'durationMs', 'acknowledgedAt']);
    taskId(call.runId); taskCallId(call.toolCallId); taskId(call.toolName, 128); taskText(call.summary, 800, true);
    taskAssert(task.runIds.includes(call.runId) && !calls.has(call.toolCallId), '工具调用 ID 必须在任务内全局唯一，且属于当前任务。');
    calls.add(call.toolCallId);
    taskAssert(['completed', 'unknown'].includes(call.status as string)
      && ['started', 'finished'].includes(call.phase as string)
      && ['none', 'file_write', 'command', 'browser_interaction', 'unknown'].includes(call.sideEffect as string), '工具结果或副作用分类无效。');
    timestamp(call.startedAt);
    if (call.phase === 'finished') { timestamp(call.finishedAt); taskAssert(typeof call.isError === 'boolean', '工具结束缺少错误标记。'); }
    else taskAssert(call.status === 'unknown' && call.finishedAt === undefined && call.isError === undefined
      && call.durationMs === undefined, '未结束工具不能声明已完成。');
    if (call.durationMs !== undefined) taskAssert(Number.isSafeInteger(call.durationMs) && (call.durationMs as number) >= 0, '工具耗时无效。');
    if (call.acknowledgedAt !== undefined) {
      timestamp(call.acknowledgedAt); taskAssert(call.status === 'unknown' && call.sideEffect !== 'none', '只有未知副作用可以标记人工核对。');
    }
  }
  assertTaskPlanEvidence(value as TaskRecord, plan.steps);
  if (task.status === 'completed') taskAssert((plan.steps as TaskPlanStep[]).length > 0
    && (plan.steps as TaskPlanStep[]).every((step) => step.status === 'completed')
    && unknownTaskEffects(value as TaskRecord).length === 0, '完成任务必须有全部完成的真实计划且没有未知副作用。');
  array(task.approvals, MAX_TASK_APPROVALS);
  const approvals = new Set<string>();
  for (const entry of task.approvals) {
    const approval = taskObject(entry, ['runId', 'approvalId', 'toolCallId', 'type', 'status', 'payload', 'createdAt', 'updatedAt']);
    taskId(approval.runId); taskId(approval.approvalId); taskCallId(approval.toolCallId);
    taskAssert(task.runIds.includes(approval.runId) && !approvals.has(`${approval.runId}/${approval.approvalId}`), '审批重复或不属于当前任务。');
    approvals.add(`${approval.runId}/${approval.approvalId}`);
    taskAssert(['approval.requested', 'approval.decided', 'command.approval.requested', 'command.approval.decided',
      'change-set.approval.requested', 'change-set.approval.decided'].includes(approval.type as string)
      && ['pending', 'approved', 'rejected', 'expired', 'cancelled'].includes(approval.status as string), '审批类型或状态无效。');
    assertTaskPayload(approval.payload); timestamp(approval.createdAt); timestamp(approval.updatedAt);
    taskAssert(approval.payload.runId === approval.runId && approval.payload.approvalId === approval.approvalId
      && approval.payload.toolCallId === approval.toolCallId, '审批内容与身份不一致。');
    if (approval.status === 'pending') taskAssert(task.status === 'waiting_approval'
      && approval.runId === task.activeRunId && (approval.type as string).endsWith('.requested'), '待审批项与活动任务不一致。');
  }
  if (task.status === 'waiting_approval') taskAssert((task.approvals as TaskApproval[]).some((entry) => entry.status === 'pending'), '等待审批任务缺少审批项。');
}

function sameCompletedStep(left: TaskPlanStep, right: TaskPlanStep): boolean {
  return left.id === right.id && left.title === right.title && left.status === 'completed'
    && right.status === 'completed' && left.detail === right.detail
    && JSON.stringify(left.toolCallIds ?? []) === JSON.stringify(right.toolCallIds ?? []);
}

export function assertTaskPlanEvidence(task: TaskRecord, steps: unknown, updating = false): void {
  assertTaskSteps(steps);
  const evidenceIds = new Set<string>();
  const previousCompleted = new Map(task.plan.steps.filter((step) => step.status === 'completed')
    .map((step) => [step.id, step] as const));
  if (updating) {
    taskAssert(typeof task.activeRunId === 'string', '更新计划必须有当前活动运行。');
    for (const previous of previousCompleted.values()) {
      taskAssert(steps.some((step) => sameCompletedStep(previous, step)),
        '更新计划必须完整保留已完成步骤的 id、title、detail 和 toolCallIds，不能抹掉或重写历史。');
    }
  }
  for (const step of steps) {
    const previous = previousCompleted.get(step.id);
    const preserved = previous !== undefined && sameCompletedStep(previous, step);
    for (const id of step.toolCallIds ?? []) {
      taskAssert(!evidenceIds.has(id), '同一工具证据 ID 不能被多个计划步骤复用。');
      evidenceIds.add(id);
      const matches = task.toolCalls.filter((call) => call.toolCallId === id);
      taskAssert(matches.length === 1 && matches[0].status === 'completed' && matches[0].phase === 'finished'
        && matches[0].isError === false && !['update_task_plan', 'read_task_state', 'unknown'].includes(matches[0].toolName),
      '步骤证据必须唯一绑定本任务已成功结束的真实工具，模型输出、摘要和计划工具不算证据。');
      if (updating && !preserved) taskAssert(matches[0].runId === task.activeRunId,
        '新建、变更或新完成的计划步骤只能使用当前运行的成功工具证据。');
    }
  }
}
