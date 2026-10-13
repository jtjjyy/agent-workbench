import { randomUUID } from 'node:crypto';
import {
  CHANGE_SET_LIMITS, CHANGE_SET_VERSION, type ChangeApprovalDecision, type ChangeDelivery,
  type ChangeIdentity, type ChangeSetOutcome, type ChangeSetRecord, type DecideChangeSetRequest,
  type DecideChangeSetResult, type PendingChangeSet, type PublishChangeSet,
  type VerificationOutcome, type VerificationPolicy, type VerificationRecord,
} from '../../shared/change-set';
import type { WorkspaceState } from '../../shared/workspace';
import { MAX_COMMAND_LENGTH, MAX_COMMAND_TIMEOUT_MS } from '../../shared/command';
import type { CommandApprovals } from '../agent/command-approvals';
import { executePowerShell, type CommandExecutionResult } from '../tools/command-executor';
import { createWorkspaceFileContext, readBoundedTextFile, type WorkspaceFileContext } from '../tools/readonly-tools';
import { sameCanonicalPath, WorkspacePolicyError } from '../workspace/workspace-session';
import { absentTarget, applyChange, preflight, prepareChanges, resultFor, rootIdentity, TEXT_OPTIONS } from './change-set-files';
import { assertIdentity, clone, containsSecret, plainObject, safeOutput, sha256 } from './change-set-policy';
import { ChangeSetStore, type ChangeSetJournal } from './change-set-store';

type Pending = {
  view: PendingChangeSet;
  signal: AbortSignal;
  published: boolean;
  consumed: boolean;
  resolve: (decision: ChangeApprovalDecision) => void;
};
export type VerificationApprovalPublisher = Parameters<CommandApprovals['request']>[4];
const sameScope = (record: { taskId: string; workspaceRoot: string; rootIdentity: string }, taskId: string,
  context: WorkspaceFileContext) => record.taskId === taskId && sameCanonicalPath(record.workspaceRoot, context.root)
    && record.rootIdentity === rootIdentity(context);
const scopeKey = (taskId: string, context: WorkspaceFileContext) => sha256(JSON.stringify([taskId,
  process.platform === 'win32' ? context.root.toLowerCase() : context.root, rootIdentity(context)]));
const currentGeneration = (records: ChangeSetRecord[]) => Math.max(0, ...records.map((record) => record.generation));
const scopeRecords = (data: ChangeSetJournal, taskId: string, context: WorkspaceFileContext) =>
  data.changeSets.filter((record) => sameScope(record, taskId, context));
const summaryFor = (record: ChangeSetRecord): string => record.status === 'applied'
  ? '本批所有操作已应用；交付仍需核对当前哈希和验证证据。'
  : `变更集状态：${record.status}；保留逐项结果，不保证原子性，不自动回滚。`;

export class ChangeSetService {
  private readonly store: ChangeSetStore;
  private readonly policy: Readonly<VerificationPolicy>;
  private pending: Pending | undefined;
  private busy = false;
  private readonly workspaces = new Map<string, WorkspaceState>();

  constructor(baseDir: string, policy: VerificationPolicy = { allowVerification: false }) {
    this.store = new ChangeSetStore(baseDir);
    this.policy = Object.freeze({ allowVerification: policy.allowVerification === true });
  }

  get verificationPolicy(): Readonly<VerificationPolicy> { return this.policy; }

  async bindWorkspace(taskId: string, workspace: WorkspaceState, signal?: AbortSignal): Promise<void> {
    if (typeof taskId !== 'string' || !taskId.trim() || taskId.length > 256) {
      throw new WorkspacePolicyError('任务标识无效。');
    }
    await createWorkspaceFileContext(workspace, signal);
    this.workspaces.set(taskId, { ...workspace });
  }

  async readPendingChangeSet(): Promise<PendingChangeSet | null> { return this.readPending(); }
  async decideChangeSet(request: DecideChangeSetRequest): Promise<DecideChangeSetResult> { return this.decide(request); }
  readChangeSets(taskId?: string): Promise<ChangeSetRecord[]> { return this.list(taskId); }

  private async exclusive<T>(action: () => Promise<T>): Promise<T> {
    if (this.busy) throw new WorkspacePolicyError('已有变更、验证或交付核对正在进行，请等待完成。');
    this.busy = true;
    try { return await action(); } finally { this.busy = false; }
  }

  private settle(pending: Pending, decision: ChangeApprovalDecision): void {
    if (pending.consumed) return;
    pending.consumed = true;
    pending.resolve(decision);
  }

  readPending(): PendingChangeSet | null {
    const pending = this.pending;
    if (!pending || !pending.published || pending.consumed) return null;
    if (pending.signal.aborted) { this.settle(pending, 'cancelled'); return null; }
    if (Date.now() >= Date.parse(pending.view.expiresAt)) { this.settle(pending, 'expired'); return null; }
    return clone(pending.view);
  }

  decide(input: DecideChangeSetRequest): DecideChangeSetResult {
    let request: Record<string, unknown>;
    try { request = plainObject(input, ['runId', 'taskId', 'toolCallId', 'id', 'approvalId', 'bindingDigest', 'decision']); }
    catch { return { ok: false, code: 'APPROVAL_UNAVAILABLE' }; }
    const pending = this.pending;
    if (!pending || !this.readPending()
      || !['runId', 'taskId', 'toolCallId', 'id', 'approvalId', 'bindingDigest'].every((key) =>
        request[key] === pending.view[key as keyof PendingChangeSet])
      || (request.decision !== 'approved' && request.decision !== 'rejected')) {
      return { ok: false, code: 'APPROVAL_UNAVAILABLE' };
    }
    // 第一次决定同步消费，重复点击不能重复应用。
    this.settle(pending, request.decision);
    return { ok: true };
  }

  async list(taskId?: string): Promise<ChangeSetRecord[]> {
    const data = await this.store.read();
    return data.changeSets.filter((record) => taskId === undefined || record.taskId === taskId);
  }

  request(workspace: WorkspaceState, identity: ChangeIdentity, operations: unknown, signal: AbortSignal,
    publish?: PublishChangeSet): Promise<ChangeSetOutcome> {
    return this.exclusive(async () => {
      assertIdentity(identity);
      const context = await createWorkspaceFileContext(workspace, signal);
      this.workspaces.set(identity.taskId, { ...workspace });
      const prepared = await prepareChanges(context, operations);
      const state = await this.store.read();
      const history = scopeRecords(state, identity.taskId, context);
      if (history.some((record) => ['pending', 'applying', 'partial', 'unknown'].includes(record.status))) {
        throw new WorkspacePolicyError('此任务有未解决的审批或部分/未知应用，必须先人工核对。');
      }
      const verification = state.verifications.filter((record) => sameScope(record, identity.taskId, context)).at(-1);
      const repair = verification?.status === 'failed' && verification.generation === currentGeneration(history);
      const key = scopeKey(identity.taskId, context);
      if (repair && (state.repairAttempts[key] ?? 0) >= CHANGE_SET_LIMITS.repairAttempts) {
        throw new WorkspacePolicyError('已达到三次失败修复上限，请人工处理后启动新任务。');
      }
      const id = randomUUID();
      const approvalId = randomUUID();
      const createdAt = new Date().toISOString();
      const expiresAt = new Date(Date.now() + CHANGE_SET_LIMITS.approvalTtlMs).toISOString();
      const hashes = prepared.map((change) => resultFor(change, 'pending'));
      const bindingDigest = sha256(JSON.stringify({ operation: 'propose_change_set', ...identity,
        workspaceRoot: context.root, rootIdentity: rootIdentity(context), id, approvalId, expiresAt,
        operations: hashes.map(({ status: _status, summary: _summary, ...hashes }) => hashes) }));
      let record: ChangeSetRecord = { ...identity, id, version: CHANGE_SET_VERSION,
        workspaceRoot: context.root, rootIdentity: rootIdentity(context), approvalId, bindingDigest,
        createdAt, expiresAt, updatedAt: createdAt, generation: currentGeneration(history),
        status: 'pending', operations: hashes };
      await this.store.update((draft) => { draft.changeSets.push(record); });
      const emit = async (type: Parameters<PublishChangeSet>[0], decision?: ChangeApprovalDecision) => {
        await publish?.(type, { ...identity, id, approvalId, bindingDigest, expiresAt,
          status: record.status, generation: record.generation, ...(decision ? { decision } : {}) });
      };
      const save = async () => {
        record.updatedAt = new Date().toISOString();
        await this.store.update((draft) => {
          const index = draft.changeSets.findIndex((entry) => entry.id === id);
          draft.changeSets[index] = clone(record);
        });
      };
      let resolve!: Pending['resolve'];
      const decisionPromise = new Promise<ChangeApprovalDecision>((yes) => { resolve = yes; });
      const pending: Pending = { view: { ...identity, id, workspaceRoot: context.root,
        rootIdentity: rootIdentity(context), approvalId, bindingDigest, expiresAt,
        operations: prepared.map((entry) => entry.preview) }, signal, published: false, consumed: false, resolve };
      this.pending = pending;
      const onAbort = () => this.settle(pending, 'cancelled');
      signal.addEventListener('abort', onAbort, { once: true });
      const timer = setTimeout(() => this.settle(pending, 'expired'), CHANGE_SET_LIMITS.approvalTtlMs);
      try {
        // 先使本地预览可读取，publish 失败则最终撤销，绝不进入应用阶段。
        pending.published = true;
        await emit('change-set.approval.requested');
        if (signal.aborted) onAbort();
        let decision = await decisionPromise;
        if (decision === 'approved' && signal.aborted) decision = 'cancelled';
        if (decision === 'approved' && Date.now() >= Date.parse(expiresAt)) decision = 'expired';
        await emit('change-set.approval.decided', decision);
        if (decision !== 'approved') {
          record.status = decision;
          record.operations = prepared.map((change) => resultFor(change, 'not_applied'));
          await save();
        } else {
          let conflict = false;
          // 全部 preflight 在第一次副作用之前完成；任何失败则整个批次不开始。
          for (let index = 0; index < prepared.length; ++index) {
            try { await preflight(context, prepared[index]); }
            catch {
              record.operations[index] = resultFor(prepared[index], signal.aborted ? 'not_applied' : 'conflict');
              conflict = true;
            }
          }
          if (conflict || signal.aborted || Date.now() >= Date.parse(expiresAt)) {
            record.status = signal.aborted ? 'cancelled' : conflict ? 'conflict' : 'expired';
            record.operations = record.operations.map((entry, index) => entry.status === 'pending'
              ? resultFor(prepared[index], 'not_applied') : entry);
            await save();
          } else {
            await this.store.update((draft) => {
              record.generation = ++draft.generation;
              record.status = 'applying';
              if (repair) draft.repairAttempts[key] = (draft.repairAttempts[key] ?? 0) + 1;
              draft.changeSets[draft.changeSets.findIndex((entry) => entry.id === id)] = clone(record);
            });
            await emit('change-set.applying');
            for (let index = 0; index < prepared.length; ++index) {
              if (signal.aborted || Date.now() >= Date.parse(expiresAt)) break;
              // 先写 unknown 检查点，进程在副作用之后崩溃也不会记成未开始。
              record.operations[index] = resultFor(prepared[index], 'unknown');
              await save();
              if (signal.aborted || Date.now() >= Date.parse(expiresAt)) {
                record.operations[index] = resultFor(prepared[index], 'not_applied');
                await save();
                break;
              }
              record.operations[index] = await applyChange(context, prepared[index], Date.parse(expiresAt));
              await save();
              if (record.operations[index].status !== 'applied') break;
            }
            record.operations = record.operations.map((entry, index) => entry.status === 'pending'
              ? resultFor(prepared[index], 'not_applied') : entry);
            const applied = record.operations.filter((entry) => entry.status === 'applied').length;
            record.status = record.operations.some((entry) => entry.status === 'unknown') ? 'unknown'
              : applied === prepared.length ? 'applied' : applied > 0 ? 'partial'
                : signal.aborted ? 'cancelled'
                  : Date.now() >= Date.parse(expiresAt) ? 'expired'
                  : record.operations.some((entry) => entry.status === 'conflict') ? 'conflict' : 'failed';
            await save();
          }
        }
        await emit('change-set.completed');
        return { status: record.status, summary: summaryFor(record), changeSet: clone(record) };
      } catch (error) {
        if (record.status === 'pending') {
          record.status = signal.aborted ? 'cancelled' : 'failed';
          record.operations = prepared.map((change) => resultFor(change, 'not_applied'));
          await save();
        } else if (record.status === 'applying') {
          record.status = record.operations.some((entry) => entry.status === 'unknown') ? 'unknown'
            : record.operations.some((entry) => entry.status === 'applied') ? 'partial' : 'failed';
          await save();
        }
        throw error;
      } finally {
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        this.settle(pending, 'cancelled');
        if (this.pending === pending) this.pending = undefined;
      }
    });
  }

  private async delivery(taskId: string, workspace: WorkspaceState, signal?: AbortSignal): Promise<ChangeDelivery> {
    const context = await createWorkspaceFileContext(workspace, signal);
    const data = await this.store.read();
    const records = scopeRecords(data, taskId, context);
    const expected = new Map<string, { path: string; sha256: string | null; uncertain: boolean }>();
    const set = (relative: string, hash: string | null, uncertain: boolean) => {
      expected.set(process.platform === 'win32' ? relative.toLowerCase() : relative,
        { path: relative, sha256: hash, uncertain });
    };
    for (const record of records) {
      for (const item of record.operations) {
        if (item.status !== 'applied' && item.status !== 'unknown') continue;
        set(item.path, item.operation === 'rename' ? null : item.afterSha256, item.status === 'unknown');
        if (item.toPath) set(item.toPath, item.afterSha256, item.status === 'unknown');
      }
    }
    const files: ChangeDelivery['files'] = [];
    for (const item of expected.values()) {
      let actualSha256: string | null = null;
      let readable = true;
      try { actualSha256 = (await readBoundedTextFile(context, item.path, TEXT_OPTIONS)).sha256; }
      catch {
        signal?.throwIfAborted();
        try { await absentTarget(context, item.path); }
        catch { signal?.throwIfAborted(); readable = false; }
      }
      files.push({ path: item.path, expectedSha256: item.sha256, actualSha256,
        status: !readable || item.uncertain ? 'unknown'
          : actualSha256 === item.sha256 ? 'current' : 'conflict' });
    }
    const generation = currentGeneration(records);
    const digest = sha256(JSON.stringify(files.map((file) => [file.path, file.actualSha256, file.status])));
    const allEvidence = data.verifications.filter((record) => sameScope(record, taskId, context));
    const evidence = allEvidence.filter((record) => record.generation === generation && record.snapshotDigest === digest);
    const unresolved = records.some((record) => ['pending', 'applying', 'partial', 'unknown'].includes(record.status));
    const hashesCurrent = files.length > 0 && files.every((file) => file.status === 'current');
    const latest = evidence.filter((record) => !['rejected', 'expired'].includes(record.status)).at(-1);
    const verification = !this.policy.allowVerification || !latest ? 'not_run'
      : latest.status === 'passed' && latest.exitCode === 0 && hashesCurrent && !unresolved ? 'passed' : 'failed';
    const risks: string[] = [];
    if (unresolved) risks.push('存在未完成审批、部分应用或未知结果，须人工核对。');
    if (!hashesCurrent) risks.push('交付文件为空、哈希不符或文件无法安全读取。');
    if (allEvidence.length && !evidence.length) risks.push('旧验证证据因变更代次或当前文件哈希变化而失效。');
    if (data.changeSets.some((record) => record.taskId === taskId && !sameScope(record, taskId, context))) {
      risks.push('此任务还包含其他工作区或旧目录身份的记录，不能混入当前交付。');
    }
    risks.push('多文件操作不保证原子性，不自动回滚；验证命令不是操作系统沙箱。');
    return { taskId, workspaceRoot: context.root, generation, createdAt: new Date().toISOString(),
      changeSets: records, files, verification, evidence,
      verificationReason: !this.policy.allowVerification ? '验证策略暂停：未运行验证，不得宣称通过。'
        : !latest ? '没有与当前变更代次和文件哈希绑定的有效验证。'
          : verification === 'passed' ? '当前代次的批准命令退出码为零，交付文件哈希一致。'
            : '当前验证失败、未完成或交付现状已变化。',
      risks, canComplete: hashesCurrent && !unresolved && verification === 'passed'
        && !data.changeSets.some((record) => record.taskId === taskId && !sameScope(record, taskId, context)) };
  }

  getDelivery(taskId: string, workspace?: WorkspaceState, signal?: AbortSignal): Promise<ChangeDelivery> {
    return this.exclusive(async () => {
      const selected = workspace ?? this.workspaces.get(taskId);
      if (!selected) throw new WorkspacePolicyError('尚未绑定本次已授权工作区，无法核对交付；请显式提供 workspace。');
      const report = await this.delivery(taskId, selected, signal);
      this.workspaces.set(taskId, { ...selected });
      return report;
    });
  }

  deliver(workspace: WorkspaceState, context: ChangeIdentity, signal?: AbortSignal): Promise<ChangeDelivery> {
    assertIdentity(context);
    return this.getDelivery(context.taskId, workspace, signal);
  }

  async recordVerification(id: string, result: CommandExecutionResult): Promise<VerificationRecord> {
    if (!this.policy.allowVerification) throw new WorkspacePolicyError('验证策略暂停，不能写入通过或失败证据。');
    return this.store.update((draft) => {
      const record = draft.verifications.find((entry) => entry.id === id);
      if (!record || record.status !== 'running') throw new WorkspacePolicyError('没有可完成的本次验证记录。');
      record.status = result.status === 'completed' && result.exitCode === 0 ? 'passed'
        : result.status === 'completed' ? 'failed' : result.status;
      record.exitCode = result.exitCode;
      record.output = safeOutput(result.output);
      record.completedAt = new Date().toISOString();
      return record;
    });
  }

  runVerification(workspace: WorkspaceState, identity: ChangeIdentity, command: string, timeoutMs: number,
    signal: AbortSignal, approvals: CommandApprovals, publish: VerificationApprovalPublisher): Promise<VerificationOutcome> {
    // 在读取参数、审批及子进程创建之前判断；请求参数不能更改策略。
    if (!this.policy.allowVerification) return Promise.resolve({ status: 'not_run', summary: '验证策略暂停：未运行验证。' });
    return this.exclusive(async () => {
      assertIdentity(identity);
      if (typeof command !== 'string' || !command.trim() || command.length > MAX_COMMAND_LENGTH
        || /[\u0000-\u001f\u007f-\u009f]/u.test(command) || containsSecret(command)
        || !Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > MAX_COMMAND_TIMEOUT_MS) {
        throw new WorkspacePolicyError('验证需要有界、无凭据的具体单行命令及有效超时。');
      }
      if (/\bgit\b[\s\S]*\b(?:commit|push)\b/iu.test(command)) {
        throw new WorkspacePolicyError('验证工具不能用于 Git 提交或推送。');
      }
      const context = await createWorkspaceFileContext(workspace, signal);
      const before = await this.delivery(identity.taskId, workspace, signal);
      if (!before.files.length || before.files.some((file) => file.status !== 'current')
        || before.changeSets.some((record) => ['pending', 'applying', 'partial', 'unknown'].includes(record.status))) {
        throw new WorkspacePolicyError('变更集尚未完整应用或交付哈希不符，不能验证。');
      }
      const data = await this.store.read();
      const attempts = data.verifications.filter((record) => sameScope(record, identity.taskId, context));
      const generationEvidence = attempts.filter((record) => record.generation === before.generation);
      if (generationEvidence.some((record) => ['failed', 'running', 'unknown', 'cancelled', 'timed_out'].includes(record.status))) {
        throw new WorkspacePolicyError('当前代次已失败或结果未知；先提出修复或人工核对，不能重复执行。');
      }
      const id = randomUUID();
      const snapshotDigest = sha256(JSON.stringify(before.files.map((file) => [file.path, file.actualSha256, file.status])));
      const record: VerificationRecord = { ...identity, id, workspaceRoot: context.root,
        rootIdentity: rootIdentity(context), generation: before.generation, snapshotDigest,
        command, timeoutMs, attempt: attempts.filter((entry) => !['rejected', 'expired'].includes(entry.status)).length + 1,
        repairAttempt: data.repairAttempts[scopeKey(identity.taskId, context)] ?? 0,
        startedAt: new Date().toISOString(), status: 'running', exitCode: null, output: '' };
      await this.store.update((draft) => { draft.verifications.push(record); });
      let executed = false;
      let approvalDecision: string | undefined;
      let result: CommandExecutionResult;
      try {
        result = await approvals.request({ runId: identity.runId, toolCallId: identity.toolCallId,
          workspaceRoot: context.root, operation: 'run_verification',
          bindingInput: JSON.stringify({ taskId: identity.taskId, generation: record.generation, snapshotDigest,
            rootIdentity: record.rootIdentity, command, timeoutMs }) }, command, timeoutMs, signal,
        async (type, payload) => {
          if ('decision' in payload) approvalDecision = payload.decision;
          await publish(type, payload);
        }, async (executionSignal) => {
          if (approvalDecision !== 'approved' || Date.now() - Date.parse(record.startedAt) >= 60_000) {
            throw new WorkspacePolicyError('本次命令审批不可用或已过期。');
          }
          const now = await this.delivery(identity.taskId, workspace, executionSignal);
          const nowDigest = sha256(JSON.stringify(now.files.map((file) => [file.path, file.actualSha256, file.status])));
          if (nowDigest !== snapshotDigest || now.generation !== record.generation
            || now.files.some((file) => file.status !== 'current')) throw new WorkspacePolicyError('命令审批期间变更现状变化。');
          executionSignal.throwIfAborted();
          if (Date.now() - Date.parse(record.startedAt) >= CHANGE_SET_LIMITS.approvalTtlMs) {
            throw new WorkspacePolicyError('核对完成时命令审批已过期，未执行命令。');
          }
          executed = true;
          return executePowerShell(command, context.root, timeoutMs, executionSignal);
        });
      } catch {
        result = { status: executed ? 'unknown' : signal.aborted ? 'cancelled' : 'failed',
          exitCode: null, output: '', summary: '验证无法完成；已执行命令的副作用不会自动回滚。' };
      }
      if (!executed && (approvalDecision === 'rejected' || approvalDecision === 'expired')) {
        const finished = await this.store.update((draft) => {
          const target = draft.verifications.find((entry) => entry.id === id)!;
          target.status = approvalDecision === 'expired' ? 'expired' : 'rejected';
          target.completedAt = new Date().toISOString();
          return target;
        });
        return { status: finished.status, summary: '命令未获有效批准，未运行验证。', verification: finished };
      }
      const finished = await this.recordVerification(id, result);
      // 保留失败输出供模型分析；调用方不得把它替换成通用工具错误。
      return { status: finished.status, summary: finished.status === 'passed'
        ? '批准命令退出码为零；交付时仍需重新核对文件。' : '验证未通过，请分析脱敏输出和实际退出码。', verification: finished };
    });
  }
}
