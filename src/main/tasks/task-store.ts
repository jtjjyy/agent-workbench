import { randomUUID } from 'node:crypto';
import { constants, type BigIntStats } from 'node:fs';
import { mkdir, open, realpath, rename, lstat } from 'node:fs/promises';
import { dirname, isAbsolute, normalize, parse, relative, join, resolve } from 'node:path';
import {
  TASK_SCHEMA_VERSION, MAX_TASK_RECORDS, MAX_TASK_PROMPT, MAX_TASK_CONTEXT, MAX_TASK_CHECKPOINT,
  assertTaskPayload, assertTaskRecord, assertTaskSteps, assertTaskPlanEvidence, taskAssert, taskId, taskCallId, taskObject, taskText,
  unresolvedTaskEffects, unknownTaskEffects,
  type TaskApprovalType, type TaskFinishStatus, type TaskPlanStep, type TaskRecord,
  type TaskSideEffect, type TaskStoreDocument, type TaskToolProgress,
} from '../../shared/tasks';

const MAX_STORE_BYTES = 32 * 1024 * 1024;
const RESUMABLE = new Set(['paused', 'cancelled', 'interrupted', 'failed']);
const READ_TOOLS = new Set(['list_files', 'read_file', 'search_text', 'search_knowledge', 'read_project_knowledge',
  'web_search', 'web_fetch', 'browser_read', 'browser_screenshot', 'read_task_state', 'update_task_plan', 'deliver_task', 'deliver_changes']);

function missing(error: unknown): boolean {
  return !!error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT';
}

function canonical(path: string): string {
  const normalized = resolve(path);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function sameIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.birthtimeNs === right.birthtimeNs;
}

function sameFile(left: BigIntStats | null, right: BigIntStats | null): boolean {
  return left === null || right === null ? left === right : sameIdentity(left, right)
    && left.size === right.size && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

export class TaskStoreError extends Error {
  constructor(public readonly code: 'TASK_READ_FAILED' | 'TASK_WRITE_FAILED' | 'TASK_SCHEMA_INVALID'
    | 'TASK_WORKSPACE_UNAVAILABLE' | 'TASK_NOT_FOUND', message: string) {
    super(message); this.name = 'TaskStoreError';
  }
}

export function classifyTaskSideEffect(name: string): TaskSideEffect {
  if (READ_TOOLS.has(name)) return 'none';
  if (name === 'replace_text' || name === 'apply_change_set' || name === 'propose_change_set') return 'file_write';
  if (name === 'run_powershell' || name === 'verify_change_set' || name === 'run_verification' || name === 'verify_changes') return 'command';
  if (name.startsWith('browser_')) return 'browser_interaction';
  return 'unknown';
}

export async function taskWorkspaceIdentity(root: unknown): Promise<{ root: string | null; fingerprint: string | null }> {
  if (root === null) return { root: null, fingerprint: null };
  taskText(root, 2_000);
  taskAssert(isAbsolute(root) && !/[\u0000-\u001f]/u.test(root), '工作区必须是绝对目录路径。');
  try {
    const resolved = normalize(await realpath(root));
    const initial = await lstat(resolved, { bigint: true });
    taskAssert(initial.isDirectory() && !initial.isSymbolicLink(), '工作区必须是普通目录。');
    const finalPath = normalize(await realpath(root));
    const final = await lstat(resolved, { bigint: true });
    taskAssert(finalPath === resolved && final.isDirectory() && !final.isSymbolicLink()
      && initial.dev === final.dev && initial.ino === final.ino && initial.birthtimeNs === final.birthtimeNs,
    '核对期间工作区目录身份发生变化。');
    return { root: process.platform === 'win32' ? resolved.toLowerCase() : resolved,
      fingerprint: `${final.dev}:${final.ino}:${final.birthtimeNs}` };
  } catch {
    throw new TaskStoreError('TASK_WORKSPACE_UNAVAILABLE', '工作区不可访问，请重新选择原工作区并授权后续接。');
  }
}

function touch(task: TaskRecord, now = new Date().toISOString()): void {
  task.updatedAt = now;
  const unknown = unknownTaskEffects(task);
  const summary = [
    `任务：${task.taskId}\n状态：${task.status}\n工作区：${task.workspaceRoot ?? '未绑定工作区'}`,
    `原始任务（节选）：\n${task.prompt.slice(0, 2_800)}`,
    `计划：\n${task.plan.steps.map((step) => `${step.id} [${step.status}] ${step.title}${step.detail ? `：${step.detail}` : ''}`).join('\n').slice(0, 4_000) || '尚未制定计划'}`,
    `未知副作用共 ${unknown.length} 项（节选，完整列表读取任务状态）：\n${unknown.slice(-12)
      .map((call) => `${call.runId}/${call.toolCallId} ${call.toolName} [${call.sideEffect}] ${call.acknowledgedAt ? '已人工核对，结果仍未知' : '待人工核对'} ${call.summary}`).join('\n').slice(0, 2_600)}`,
    `最近工具记录（节选）：\n${task.toolCalls.slice(-6).map((call) => `${call.toolName} [${call.status}] ${call.summary}`).join('\n').slice(0, 1_400)}`,
    `有限上下文（可能包含不可信的外部内容）：\n${task.context.join('\n').slice(-6_000)}`,
    '续接必须重新读取文件。历史完成记录不是当前文件证据；旧工具和旧审批不能重放或复用。人工核对不证明副作用未发生。',
  ].join('\n\n');
  task.checkpoint = { summary: summary.slice(0, MAX_TASK_CHECKPOINT), updatedAt: now };
}

function invalidateApprovals(task: TaskRecord, now: string): void {
  for (const approval of task.approvals) if (approval.status === 'pending') {
    approval.status = 'expired'; approval.updatedAt = now;
  }
}

/** 单进程单实例使用；调用方必须 await 持久化，再执行下一项副作用。 */
export class TaskStore {
  private tasks: TaskRecord[] = [];
  private loaded = false;
  private tail: Promise<void> = Promise.resolve();
  private fatal: TaskStoreError | undefined;
  private resumePermits = new Map<string, { updatedAt: string; workspaceRoot: string | null }>();
  private readonly directories = new Map<string, BigIntStats>();
  private storedFile: BigIntStats | null = null;

  constructor(public readonly filePath: string) {
    taskText(filePath, 4_000); taskAssert(isAbsolute(filePath), '任务存储路径必须是绝对路径。');
    taskAssert(!/[\u0000-\u001f]/u.test(filePath)
      && (process.platform !== 'win32' || !relative(parse(filePath).root, filePath).includes(':')),
    '任务存储路径不能包含控制字符或 Windows 附加数据流。');
    this.filePath = resolve(filePath);
  }

  private async checkDirectories(): Promise<void> {
    for (const [path, expected] of this.directories) {
      const actual = await lstat(path, { bigint: true });
      taskAssert(actual.isDirectory() && !actual.isSymbolicLink() && sameIdentity(expected, actual)
        && canonical(await realpath(path)) === canonical(path), '任务数据目录链接或身份发生变化，已停止操作。');
    }
  }

  // 逐级创建和核对，不使用递归 mkdir 穿越尚未核对的目录链。
  private async checkStorageDirectory(create: boolean): Promise<boolean> {
    const parent = resolve(dirname(this.filePath));
    let current = parse(parent).root;
    const parts = ['', ...relative(current, parent).split(/[\\/]/u).filter(Boolean)];
    for (const part of parts) {
      if (part) current = join(current, part);
      let stat: BigIntStats;
      try { stat = await lstat(current, { bigint: true }); }
      catch (error) {
        if (!missing(error) || this.directories.has(current)) throw error;
        await this.checkDirectories();
        if (!create) return false;
        try { await mkdir(current, { mode: 0o700 }); }
        catch (creationError) {
          if (!creationError || typeof creationError !== 'object' || !('code' in creationError)
            || creationError.code !== 'EEXIST') throw creationError;
        }
        stat = await lstat(current, { bigint: true });
      }
      taskAssert(stat.isDirectory() && !stat.isSymbolicLink()
        && canonical(await realpath(current)) === canonical(current), '任务数据目录不能经过符号链接或 junction。');
      const expected = this.directories.get(current);
      taskAssert(!expected || sameIdentity(expected, stat), '任务数据目录身份发生变化，已停止操作。');
      this.directories.set(current, stat);
    }
    await this.checkDirectories();
    return true;
  }

  private async checkFile(path: string, allowMissing = false): Promise<BigIntStats | null> {
    let stat: BigIntStats;
    try { stat = await lstat(path, { bigint: true }); }
    catch (error) { if (allowMissing && missing(error)) return null; throw error; }
    taskAssert(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1n
      && canonical(await realpath(path)) === canonical(path), '任务数据文件必须是无链接的普通文件。');
    return stat;
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const pending = this.tail.then(async () => {
      if (this.fatal) throw this.fatal;
      await this.load();
      return operation();
    });
    // 队列保持可等待；原请求仍拒绝，磁盘故障则通过 fatal 阻断后续请求。
    this.tail = pending.then(() => undefined, () => undefined);
    return pending;
  }

  private async load(): Promise<void> {
    if (this.loaded) return;
    let raw: string;
    try {
      if (!await this.checkStorageDirectory(false)) {
        taskAssert(!await this.checkStorageDirectory(false), '核对期间任务数据目录发生变化。');
        this.loaded = true; return;
      }
      const before = await this.checkFile(this.filePath, true);
      if (!before) {
        await this.checkDirectories();
        taskAssert(await this.checkFile(this.filePath, true) === null, '核对期间任务数据文件出现，拒绝初始化空存储。');
        this.loaded = true; return;
      }
      taskAssert(before.size <= BigInt(MAX_STORE_BYTES), '任务数据文件超过容量限制。');
      const file = await open(this.filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try {
        const stat = await file.stat({ bigint: true });
        taskAssert(stat.isFile() && stat.nlink === 1n && sameFile(before, stat), '打开后的任务数据文件身份发生变化。');
        await this.checkDirectories();
        taskAssert(sameFile(stat, await this.checkFile(this.filePath)), '任务数据文件路径与打开的文件不一致。');
        const bytes = Buffer.alloc(Number(stat.size));
        let offset = 0;
        while (offset < bytes.length) {
          const { bytesRead } = await file.read(bytes, offset, bytes.length - offset, offset);
          taskAssert(bytesRead > 0, '任务数据读取不完整。'); offset += bytesRead;
        }
        const after = await file.stat({ bigint: true });
        taskAssert(after.isFile() && after.nlink === 1n && sameFile(stat, after), '读取期间任务数据文件发生变化。');
        await this.checkDirectories();
        taskAssert(sameFile(after, await this.checkFile(this.filePath)), '读取后任务数据文件路径身份发生变化。');
        raw = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        this.storedFile = after;
      } finally { await file.close(); }
    } catch {
      this.fatal = new TaskStoreError('TASK_READ_FAILED', '任务存储读取失败，原文件已保留；停止运行并检查数据目录。');
      throw this.fatal;
    }
    let tasks: TaskRecord[];
    try {
      const document = taskObject(JSON.parse(raw), ['schemaVersion', 'tasks']);
      taskAssert(document.schemaVersion === TASK_SCHEMA_VERSION, '任务存储版本不兼容，不自动降级或覆盖。');
      taskAssert(Array.isArray(document.tasks) && document.tasks.length <= MAX_TASK_RECORDS, '任务存储列表无效。');
      for (const record of document.tasks) assertTaskRecord(record);
      tasks = document.tasks as TaskRecord[];
      this.assertDocument(tasks);
    } catch {
      this.fatal = new TaskStoreError('TASK_SCHEMA_INVALID', '任务存储损坏或版本不兼容，原数据已保留；必须先处理存储问题。');
      throw this.fatal;
    }
    const recovered = structuredClone(tasks);
    let changed = false;
    for (const task of recovered) if (task.status === 'running' || task.status === 'waiting_approval') {
      task.status = 'interrupted'; task.activeRunId = null;
      const now = new Date().toISOString(); invalidateApprovals(task, now); touch(task, now); changed = true;
    }
    if (changed) await this.persist(recovered);
    else this.tasks = tasks;
    this.loaded = true;
  }

  private assertDocument(tasks: TaskRecord[]): void {
    taskAssert(tasks.length <= MAX_TASK_RECORDS, '任务存储已达到容量限制，请先维护存储，不能丢弃历史。');
    const ids = new Set<string>(); const runs = new Set<string>(); let active = 0;
    for (const task of tasks) {
      assertTaskRecord(task);
      taskAssert(!ids.has(task.taskId), '任务标识重复。'); ids.add(task.taskId);
      for (const run of task.runIds) { taskAssert(!runs.has(run), '运行标识必须全局唯一。'); runs.add(run); }
      if (task.status === 'running' || task.status === 'waiting_approval') active++;
      taskAssert(task.workspaceRoot === null || isAbsolute(task.workspaceRoot), '保存的工作区路径必须是绝对路径。');
    }
    taskAssert(active <= 1, '同一时刻只能有一个活动任务。');
  }

  private async persist(tasks: TaskRecord[]): Promise<void> {
    this.assertDocument(tasks);
    const document: TaskStoreDocument = { schemaVersion: TASK_SCHEMA_VERSION, tasks };
    const bytes = Buffer.from(JSON.stringify(document, null, 2) + '\n', 'utf8');
    taskAssert(bytes.length <= MAX_STORE_BYTES, '任务存储超过容量限制，未删除任何历史。');
    const temporary = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await this.checkStorageDirectory(true);
      taskAssert(sameFile(this.storedFile, await this.checkFile(this.filePath, true)),
        '任务存储文件被外部更改，拒绝覆盖。');
      await this.checkDirectories();
      const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL
        | (constants.O_NOFOLLOW ?? 0), 0o600);
      let written: BigIntStats;
      try {
        const opened = await file.stat({ bigint: true });
        taskAssert(opened.isFile() && opened.nlink === 1n, '任务临时文件不是独占普通文件。');
        await this.checkDirectories();
        taskAssert(sameFile(opened, await this.checkFile(temporary)), '任务临时文件路径与打开身份不一致。');
        await file.writeFile(bytes); await file.sync();
        written = await file.stat({ bigint: true });
        taskAssert(written.isFile() && written.nlink === 1n && sameIdentity(opened, written)
          && written.size === BigInt(bytes.length), '任务临时文件写入期间身份或长度发生变化。');
        await this.checkDirectories();
        taskAssert(sameFile(written, await this.checkFile(temporary)), '任务临时文件写入后路径身份发生变化。');
      }
      finally { await file.close(); }
      await this.checkDirectories();
      taskAssert(sameFile(written, await this.checkFile(temporary))
        && sameFile(this.storedFile, await this.checkFile(this.filePath, true)), '任务替换前文件身份发生变化。');
      await this.checkDirectories();
      await rename(temporary, this.filePath);
      await this.checkDirectories();
      const installed = await this.checkFile(this.filePath);
      taskAssert(installed && sameIdentity(written, installed) && written.size === installed.size
        && written.mtimeNs === installed.mtimeNs, '任务替换后文件身份发生变化。');
      await this.checkDirectories();
      this.storedFile = installed;
    } catch {
      this.fatal = new TaskStoreError('TASK_WRITE_FAILED', '任务存储写入失败，停止运行；原文件和可能存在的临时文件已保留，请人工检查。');
      throw this.fatal;
    }
    this.tasks = tasks;
  }

  private find(tasks: TaskRecord[], id: unknown): TaskRecord {
    taskId(id); const task = tasks.find((item) => item.taskId === id);
    if (!task) throw new TaskStoreError('TASK_NOT_FOUND', '没有找到指定任务，不能混入其他任务的历史。');
    return task;
  }

  private active(task: TaskRecord, runId?: unknown): string {
    taskAssert((task.status === 'running' || task.status === 'waiting_approval') && task.activeRunId, '任务当前没有活动运行。');
    if (runId !== undefined) { taskId(runId); taskAssert(runId === task.activeRunId, '工具或审批属于其他运行。'); }
    return task.activeRunId;
  }

  async list(): Promise<TaskRecord[]> {
    return this.enqueue(async () => structuredClone(this.tasks).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)));
  }

  async get(id: string): Promise<TaskRecord> {
    return this.enqueue(async () => structuredClone(this.find(this.tasks, id)));
  }

  async startRun(id: string | undefined, prompt: string, workspaceRoot: string | null, runId: string): Promise<TaskRecord> {
    taskText(prompt, MAX_TASK_PROMPT); taskId(runId); if (id !== undefined) taskId(id);
    return this.enqueue(async () => {
      const identity = await taskWorkspaceIdentity(workspaceRoot); const root = identity.root;
      taskAssert(!this.tasks.some((task) => task.activeRunId), '已有活动任务，请先暂停或取消。');
      taskAssert(!this.tasks.some((task) => task.runIds.includes(runId)), '运行编号已经使用，续接必须创建新编号。');
      const next = structuredClone(this.tasks); const now = new Date().toISOString(); let task: TaskRecord;
      if (id === undefined) {
        task = { taskId: randomUUID(), prompt, workspaceRoot: root, workspaceIdentity: identity.fingerprint, plan: { steps: [], updatedAt: now },
          runIds: [runId], activeRunId: runId, status: 'running', context: [], checkpoint: { summary: '', updatedAt: now },
          toolCalls: [], approvals: [], createdAt: now, updatedAt: now };
        next.push(task);
      } else {
        task = this.find(next, id); const permit = this.resumePermits.get(id);
        taskAssert(RESUMABLE.has(task.status) && permit && permit.updatedAt === task.updatedAt
          && permit.workspaceRoot === root && task.workspaceRoot === root && task.workspaceIdentity === identity.fingerprint,
        '续接前必须重新授权原工作区、调用 prepareResume 并核对未知副作用。');
        taskAssert(task.prompt === prompt, '续接必须保留原始任务输入，新任务请创建独立记录。');
        task.runIds.push(runId); task.activeRunId = runId; task.status = 'running'; delete task.error;
      }
      touch(task, now); await this.persist(next);
      this.resumePermits.delete(task.taskId); return structuredClone(task);
    });
  }

  async recordTool(id: string, progress: TaskToolProgress): Promise<void> {
    const input = taskObject(progress, ['type', 'toolCallId', 'toolName', 'summary'],
      ['runId', 'sideEffect', 'status', 'isError', 'durationMs', 'sources']);
    taskAssert(input.type === 'started' || input.type === 'completed', '工具进度类型无效。');
    taskCallId(input.toolCallId); taskId(input.toolName); taskText(input.summary, 800, true);
    if (input.runId !== undefined) taskId(input.runId);
    if (input.sideEffect !== undefined) taskAssert(['none', 'file_write', 'command', 'browser_interaction', 'unknown'].includes(input.sideEffect as string), '工具副作用分类无效。');
    if (input.status !== undefined) taskAssert(['completed', 'unknown'].includes(input.status as string), '工具结果状态无效。');
    if (input.type === 'started') taskAssert(input.status !== 'completed' && input.isError === undefined && input.durationMs === undefined, '开始记录不能包含完成结果。');
    else taskAssert(typeof input.isError === 'boolean', '工具结束必须提供 isError。');
    if (input.durationMs !== undefined) taskAssert(Number.isSafeInteger(input.durationMs) && (input.durationMs as number) >= 0, '工具耗时无效。');
    if (input.sources !== undefined) {
      taskAssert(Array.isArray(input.sources) && input.sources.length <= 12, '工具来源格式无效。');
      for (const source of input.sources) {
        const entry = taskObject(source, ['path', 'startLine', 'endLine', 'sha256', 'excerpt']);
        taskText(entry.path, 512); taskText(entry.excerpt, 240, true);
        taskAssert(Number.isSafeInteger(entry.startLine) && (entry.startLine as number) > 0
          && Number.isSafeInteger(entry.endLine) && (entry.endLine as number) >= (entry.startLine as number)
          && typeof entry.sha256 === 'string' && /^[a-f0-9]{64}$/.test(entry.sha256), '工具来源行号或哈希无效。');
      }
    }
    const captured = structuredClone(progress);
    await this.enqueue(async () => {
      const next = structuredClone(this.tasks); const task = this.find(next, id);
      const runId = this.active(task, captured.runId); const now = new Date().toISOString();
      const existing = task.toolCalls.find((call) => call.runId === runId && call.toolCallId === captured.toolCallId);
      const classified = classifyTaskSideEffect(captured.toolName);
      const effect = classified === 'none' ? captured.sideEffect ?? classified
        : captured.sideEffect === 'none' || captured.sideEffect === undefined ? classified : captured.sideEffect;
      if (captured.type === 'started') {
        taskAssert(!task.toolCalls.some((call) => call.toolCallId === captured.toolCallId),
          '工具调用 ID 必须在任务全部运行内唯一，不能重复开始或复用历史 ID。');
        task.toolCalls.push({ runId, toolCallId: captured.toolCallId, toolName: captured.toolName,
          status: 'unknown', phase: 'started', sideEffect: effect, summary: captured.summary, startedAt: now });
      } else {
        taskAssert(existing && existing.phase === 'started' && existing.toolName === captured.toolName, '工具结束缺少匹配的开始记录或已结束。');
        taskAssert(captured.sideEffect === undefined || existing.sideEffect === effect, '工具结束不能改变已记录的副作用分类。');
        existing.phase = 'finished'; existing.finishedAt = now; existing.isError = captured.isError;
        existing.summary = captured.summary;
        existing.status = captured.status === 'unknown' || (captured.isError && existing.sideEffect !== 'none') ? 'unknown' : 'completed';
        if (captured.durationMs !== undefined) existing.durationMs = captured.durationMs;
      }
      touch(task, now); await this.persist(next);
    });
  }

  async recordApproval(id: string, type: TaskApprovalType, payload: unknown): Promise<void> {
    taskAssert(['approval.requested', 'approval.decided', 'command.approval.requested', 'command.approval.decided',
      'change-set.approval.requested', 'change-set.approval.decided'].includes(type), '审批事件类型无效。');
    assertTaskPayload(payload); taskId(payload.runId); taskId(payload.approvalId); taskCallId(payload.toolCallId);
    taskAssert(typeof payload.bindingDigest === 'string' && /^[a-f0-9]{64}$/.test(payload.bindingDigest), '审批必须有有效绑定摘要。');
    const requested = type.endsWith('.requested');
    if (requested) taskAssert(typeof payload.expiresAt === 'string' && Number.isFinite(Date.parse(payload.expiresAt)), '审批请求缺少有效到期时间。');
    else taskAssert(['approved', 'rejected', 'expired', 'cancelled'].includes(payload.decision as string), '审批决定无效。');
    const captured = structuredClone(payload);
    await this.enqueue(async () => {
      const next = structuredClone(this.tasks); const task = this.find(next, id);
      const runId = this.active(task, captured.runId); const now = new Date().toISOString();
      const existing = task.approvals.find((entry) => entry.runId === runId && entry.approvalId === captured.approvalId);
      if (requested) {
        taskAssert(!existing, '审批编号已使用，不能复用旧审批。');
        task.approvals.push({ runId, approvalId: captured.approvalId as string, toolCallId: captured.toolCallId as string,
          type, status: 'pending', payload: captured, createdAt: now, updatedAt: now });
      } else {
        taskAssert(existing && existing.status === 'pending' && existing.toolCallId === captured.toolCallId
          && existing.type.replace('.requested', '.decided') === type, '审批决定缺少匹配请求或已经失效。');
        taskAssert(existing.payload.bindingDigest === captured.bindingDigest, '审批绑定摘要与原请求不一致。');
        existing.status = captured.decision as 'approved' | 'rejected' | 'expired' | 'cancelled';
        existing.type = type; existing.payload = captured; existing.updatedAt = now;
      }
      task.status = task.approvals.some((entry) => entry.status === 'pending') ? 'waiting_approval' : 'running';
      touch(task, now); await this.persist(next);
    });
  }

  async updatePlan(id: string, steps: TaskPlanStep[]): Promise<void> {
    assertTaskSteps(steps); const captured = structuredClone(steps);
    await this.enqueue(async () => {
      const next = structuredClone(this.tasks); const task = this.find(next, id); this.active(task);
      assertTaskPlanEvidence(task, captured, true);
      const now = new Date().toISOString(); task.plan = { steps: captured, updatedAt: now };
      touch(task, now); await this.persist(next);
    });
  }

  async appendContext(id: string, text: string): Promise<void> {
    taskText(text, 100_000, true);
    await this.enqueue(async () => {
      const next = structuredClone(this.tasks); const task = this.find(next, id); this.active(task);
      const prefix = '[较早内容已截断]\n';
      const tail = text.length > MAX_TASK_CONTEXT ? `${prefix}${text.slice(-(MAX_TASK_CONTEXT - prefix.length))}` : text;
      task.context.push(tail);
      while (task.context.length > 24 || task.context.reduce((length, part) => length + part.length, 0) > MAX_TASK_CONTEXT) task.context.shift();
      touch(task); await this.persist(next);
    });
  }

  async finishRun(id: string, status: TaskFinishStatus, error?: string): Promise<void> {
    taskAssert(['paused', 'cancelled', 'interrupted', 'completed', 'failed'].includes(status), '结束状态无效。');
    if (error !== undefined) taskText(error, 2_000, true);
    await this.enqueue(async () => {
      const next = structuredClone(this.tasks); const task = this.find(next, id); this.active(task);
      if (status === 'completed') {
        assertTaskPlanEvidence(task, task.plan.steps);
        taskAssert(task.plan.steps.length > 0 && task.plan.steps.every((step) => step.status === 'completed'),
          '任务必须包含真实计划并完成全部步骤，模型回复不是完成证据。');
        taskAssert(unknownTaskEffects(task).length === 0 && !task.toolCalls.some((call) => call.runId === task.activeRunId
          && call.phase === 'started'), '工具尚未结束或仍有未知副作用，不能声明任务完成。');
      }
      const now = new Date().toISOString(); task.status = status; task.activeRunId = null;
      if (error !== undefined) task.error = error; else delete task.error;
      invalidateApprovals(task, now); touch(task, now); await this.persist(next); this.resumePermits.delete(id);
    });
  }

  async interruptActive(): Promise<void> {
    await this.enqueue(async () => {
      const next = structuredClone(this.tasks); let changed = false;
      for (const task of next) if (task.activeRunId) {
        const now = new Date().toISOString(); task.status = 'interrupted'; task.activeRunId = null;
        invalidateApprovals(task, now); touch(task, now); changed = true;
      }
      if (changed) await this.persist(next);
      this.resumePermits.clear();
    });
  }

  async prepareResume(id: string, workspaceRoot: string | null, acknowledgeUnknown: boolean): Promise<TaskRecord> {
    taskAssert(typeof acknowledgeUnknown === 'boolean', '续接必须明确提供人工核对标记。');
    return this.enqueue(async () => {
      taskAssert(!this.tasks.some((task) => task.activeRunId), '已有活动任务，暂时不能续接。');
      const next = structuredClone(this.tasks); const task = this.find(next, id);
      taskAssert(RESUMABLE.has(task.status), '只有暂停、取消、中断或失败的任务可以续接。');
      const identity = await taskWorkspaceIdentity(workspaceRoot); const root = identity.root;
      taskAssert(task.workspaceRoot === root && task.workspaceIdentity === identity.fingerprint,
        '所选工作区路径或目录身份与任务不一致，请重新选择并授权原工作区。');
      const unknown = unresolvedTaskEffects(task);
      taskAssert(unknown.length === 0 || acknowledgeUnknown, '存在未知副作用，请逐项人工核对后勾选确认；不会自动重放。');
      const now = new Date().toISOString();
      for (const call of unknown) call.acknowledgedAt = now;
      invalidateApprovals(task, now); touch(task, now); await this.persist(next);
      this.resumePermits.set(id, { updatedAt: task.updatedAt, workspaceRoot: root });
      return structuredClone(task);
    });
  }
}

export { TaskStore as JsonTaskStore };
