import { randomUUID } from 'node:crypto';
import { lstat, mkdir, open, realpath, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import {
  CHANGE_SET_LIMITS, CHANGE_SET_VERSION, type ChangeSetRecord, type VerificationRecord,
} from '../../shared/change-set';
import { clone, containsSecret, isHash, isMissing, plainObject } from './change-set-policy';
import { sameCanonicalPath } from '../workspace/workspace-session';

export interface ChangeSetJournal {
  version: typeof CHANGE_SET_VERSION;
  generation: number;
  repairAttempts: Record<string, number>;
  changeSets: ChangeSetRecord[];
  verifications: VerificationRecord[];
}

export const CHANGE_SET_STORE_FILENAME = 'change-sets.v1.json';

export function isChangeSetJournal(input: unknown): input is ChangeSetJournal {
  try { return validateJournal(input); } catch { return false; }
}

function validateJournal(input: unknown): input is ChangeSetJournal {
  plainObject(input, ['version', 'generation', 'repairAttempts', 'changeSets', 'verifications']);
  const data = input as ChangeSetJournal;
  const dense = (value: unknown): value is unknown[] => Array.isArray(value)
    && Object.getPrototypeOf(value) === Array.prototype
    && Reflect.ownKeys(value).length === value.length + 1
    && Array.from({ length: value.length }, (_, index) => Object.getOwnPropertyDescriptor(value, String(index)))
      .every((entry) => !!entry && entry.enumerable && 'value' in entry);
  const bounded = (value: unknown, max = 256): value is string => typeof value === 'string'
    && !!value && value.length <= max && !/[\u0000-\u001f\u007f-\u009f]/u.test(value);
  const identity = (value: ChangeSetRecord | VerificationRecord) => bounded(value.id)
    && bounded(value.runId) && bounded(value.taskId) && bounded(value.toolCallId)
    && bounded(value.workspaceRoot, 4096) && bounded(value.rootIdentity)
    && Number.isSafeInteger(value.generation) && value.generation >= 0;
  const date = (value: unknown) => typeof value === 'string' && value.length <= 40
    && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
  const relative = (value: unknown): value is string => bounded(value, 512)
    && !value.includes('\\') && !value.includes(':') && !path.posix.isAbsolute(value)
    && value.split('/').length <= 8
    && value.split('/').every((part) => !!part && part !== '.' && part !== '..');
  const statuses = ['pending', 'applying', 'applied', 'partial', 'conflict', 'failed', 'unknown', 'rejected', 'expired', 'cancelled'];
  const itemStatuses = ['pending', 'not_applied', 'applied', 'conflict', 'failed', 'unknown'];
  if (data.version !== CHANGE_SET_VERSION || !Number.isSafeInteger(data.generation) || data.generation < 0
    || !dense(data.changeSets) || data.changeSets.length > CHANGE_SET_LIMITS.records
    || !dense(data.verifications) || data.verifications.length > CHANGE_SET_LIMITS.verificationRecords
    || !data.repairAttempts || typeof data.repairAttempts !== 'object' || Array.isArray(data.repairAttempts)
    || Object.entries(data.repairAttempts).some(([key, value]) => !isHash(key)
      || !Number.isInteger(value) || value < 0 || value > CHANGE_SET_LIMITS.repairAttempts)) return false;
  plainObject(data.repairAttempts, Object.keys(data.repairAttempts));
  if (Object.keys(data.repairAttempts).length > CHANGE_SET_LIMITS.records) return false;
  const ids = new Set<string>();
  for (const record of data.changeSets) {
    plainObject(record, ['id', 'version', 'runId', 'taskId', 'toolCallId', 'workspaceRoot', 'rootIdentity',
      'bindingDigest', 'approvalId', 'createdAt', 'expiresAt', 'updatedAt', 'generation', 'status', 'operations']);
    if (!record || !identity(record) || record.version !== CHANGE_SET_VERSION || !statuses.includes(record.status)
      || !bounded(record.approvalId) || !isHash(record.bindingDigest) || !date(record.createdAt)
      || !date(record.expiresAt) || !date(record.updatedAt) || !dense(record.operations)
      || record.operations.length < 1 || record.operations.length > CHANGE_SET_LIMITS.operations
      || ids.has(record.id) || record.generation > data.generation) return false;
    ids.add(record.id);
    const paths = new Set<string>();
    for (const item of record.operations) {
      plainObject(item, ['operation', 'path', 'toPath', 'beforeSha256', 'afterSha256', 'status', 'summary'],
        ['operation', 'path', 'beforeSha256', 'afterSha256', 'status', 'summary']);
      if (!item || !['create', 'update', 'delete', 'rename'].includes(item.operation)
        || !relative(item.path) || (item.operation === 'rename' ? !relative(item.toPath) : Object.hasOwn(item, 'toPath'))
        || (item.beforeSha256 !== null && !isHash(item.beforeSha256))
        || (item.afterSha256 !== null && !isHash(item.afterSha256))
        || !itemStatuses.includes(item.status) || !bounded(item.summary, 1024)
        || (item.operation === 'create' ? item.beforeSha256 !== null : !isHash(item.beforeSha256))
        || (item.operation === 'delete' ? item.afterSha256 !== null : !isHash(item.afterSha256))
        || (item.operation === 'rename' && item.beforeSha256 !== item.afterSha256)) return false;
      for (const candidate of [item.path, ...(item.toPath ? [item.toPath] : [])]) {
        const key = process.platform === 'win32' ? candidate.toLowerCase() : candidate;
        if (paths.has(key)) return false;
        paths.add(key);
      }
    }
    if (record.status === 'applied' && record.operations.some((item) => item.status !== 'applied')) return false;
    if (record.status === 'pending' && record.operations.some((item) => item.status !== 'pending')) return false;
    if (['rejected', 'expired', 'cancelled'].includes(record.status)
      && record.operations.some((item) => !['not_applied', 'conflict'].includes(item.status))) return false;
    if (record.status === 'partial' && (!record.operations.some((item) => item.status === 'applied')
      || record.operations.every((item) => item.status === 'applied'))) return false;
  }
  for (const record of data.verifications) {
    plainObject(record, ['id', 'runId', 'taskId', 'toolCallId', 'workspaceRoot', 'rootIdentity', 'generation',
      'snapshotDigest', 'command', 'timeoutMs', 'attempt', 'repairAttempt', 'startedAt', 'completedAt', 'status', 'exitCode', 'output'],
    ['id', 'runId', 'taskId', 'toolCallId', 'workspaceRoot', 'rootIdentity', 'generation', 'snapshotDigest', 'command',
      'timeoutMs', 'attempt', 'repairAttempt', 'startedAt', 'status', 'exitCode', 'output']);
    if (!record || !identity(record) || ids.has(record.id) || !isHash(record.snapshotDigest)
      || !['running', 'passed', 'failed', 'cancelled', 'timed_out', 'unknown', 'rejected', 'expired'].includes(record.status)
      || !bounded(record.command, 8000) || !Number.isSafeInteger(record.timeoutMs) || record.timeoutMs < 1000
      || record.timeoutMs > 120000 || !date(record.startedAt)
      || (record.completedAt !== undefined && !date(record.completedAt))
      || !Number.isSafeInteger(record.attempt) || record.attempt < 1
      || !Number.isSafeInteger(record.repairAttempt) || record.repairAttempt < 0
      || record.repairAttempt > CHANGE_SET_LIMITS.repairAttempts
      || (record.exitCode !== null && !Number.isSafeInteger(record.exitCode))
      || typeof record.output !== 'string' || record.output.length > CHANGE_SET_LIMITS.outputLength
      || record.generation > data.generation
      || (record.status === 'passed' && record.exitCode !== 0)
      || (record.status === 'running' ? record.completedAt !== undefined || record.exitCode !== null
        : !date(record.completedAt))) return false;
    ids.add(record.id);
  }
  const serialized = JSON.stringify(data);
  return Buffer.byteLength(serialized, 'utf8') <= CHANGE_SET_LIMITS.storeBytes && !containsSecret(serialized);
}

// 单实例串行写入；不裁剪历史，达到容量时明确停止，避免丢失交付证据。
export class ChangeSetStore {
  private data: ChangeSetJournal | undefined;
  private queue: Promise<void> = Promise.resolve();
  private failure = false;
  private readonly filename: string;
  private readonly baseDir: string;
  private directoryIdentity: string | undefined;
  constructor(baseDir: string) {
    if (!path.isAbsolute(baseDir)) throw new Error('变更集存储必须使用本机绝对数据目录。');
    this.baseDir = path.resolve(baseDir);
    this.filename = path.join(this.baseDir, CHANGE_SET_STORE_FILENAME);
  }

  private async checkDirectory(create: boolean): Promise<void> {
    const root = path.parse(this.baseDir).root;
    let current = root;
    const identities: string[] = [];
    for (const part of ['', ...this.baseDir.slice(root.length).split(path.sep)]) {
      if (part) current = path.join(current, part);
      let stat;
      try { stat = await lstat(current, { bigint: true }); }
      catch (error) {
        if (!create || !isMissing(error)) throw error;
        await mkdir(current, { mode: 0o700 });
        stat = await lstat(current, { bigint: true });
      }
      if (!stat.isDirectory() || stat.isSymbolicLink() || !sameCanonicalPath(await realpath(current), current)) {
        throw new Error('invalid data directory');
      }
      identities.push(`${current}:${stat.dev}:${stat.ino}:${stat.birthtimeNs}`);
    }
    const identity = JSON.stringify(identities);
    if (this.directoryIdentity !== undefined && this.directoryIdentity !== identity) {
      throw new Error('data directory changed');
    }
    this.directoryIdentity = identity;
  }

  private async load(): Promise<ChangeSetJournal> {
    if (this.failure) throw new Error('变更集存储已失败，必须修复存储并重新启动后继续。');
    if (this.data) return this.data;
    let data: ChangeSetJournal;
    let initiallyMissing = true;
    try {
      await this.checkDirectory(false);
      const stat = await lstat(this.filename, { bigint: true });
      initiallyMissing = false;
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n || stat.size > BigInt(CHANGE_SET_LIMITS.storeBytes)) {
        throw new Error('invalid store');
      }
      const handle = await open(this.filename, 'r');
      let parsed: unknown;
      try {
        await this.checkDirectory(false);
        const opened = await handle.stat({ bigint: true });
        if (opened.dev !== stat.dev || opened.ino !== stat.ino || opened.size !== stat.size
          || opened.mtimeNs !== stat.mtimeNs || opened.ctimeNs !== stat.ctimeNs || opened.nlink !== 1n) throw new Error('unstable store');
        const bytes = Buffer.alloc(Number(opened.size));
        let offset = 0;
        while (offset < bytes.length) {
          const read = await handle.read(bytes, offset, bytes.length - offset, offset);
          if (!read.bytesRead) throw new Error('short store read');
          offset += read.bytesRead;
        }
        const after = await handle.stat({ bigint: true });
        const finalPath = await lstat(this.filename, { bigint: true });
        if (after.dev !== stat.dev || after.ino !== stat.ino || after.size !== stat.size
          || after.mtimeNs !== stat.mtimeNs || after.ctimeNs !== stat.ctimeNs
          || finalPath.dev !== stat.dev || finalPath.ino !== stat.ino || finalPath.isSymbolicLink()) throw new Error('unstable store');
        await this.checkDirectory(false);
        parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
      } finally { await handle.close(); }
      if (!isChangeSetJournal(parsed)) throw new Error('invalid store');
      data = parsed;
    } catch (error) {
      if (!initiallyMissing || !isMissing(error)) {
        this.failure = true;
        throw new Error('变更集存储损坏、版本不兼容或不可读取；已停止操作，原文件保留。');
      }
      data = { version: CHANGE_SET_VERSION, generation: 0, repairAttempts: {}, changeSets: [], verifications: [] };
    }
    let interrupted = false;
    for (const record of data.changeSets) {
      if (record.status === 'pending' || record.status === 'applying') {
        const applying = record.status === 'applying';
        record.status = applying ? 'unknown' : 'cancelled';
        record.updatedAt = new Date().toISOString();
        for (const item of record.operations) {
          if (item.status === 'pending') {
            item.status = 'not_applied';
            item.summary = '进程已中断，此项未开始；旧审批不能复用。';
          }
        }
        interrupted = true;
      }
    }
    for (const record of data.verifications) {
      if (record.status === 'running') {
        record.status = 'unknown';
        record.completedAt = new Date().toISOString();
        record.output = '进程已中断，命令结果未知；不自动重放。';
        interrupted = true;
      }
    }
    if (interrupted) await this.persist(data);
    this.data = data;
    return data;
  }

  private async persist(data: ChangeSetJournal): Promise<void> {
    let temporary: string | undefined;
    try {
      if (!isChangeSetJournal(data)) throw new Error('invalid journal');
      const body = JSON.stringify(data);
      if (Buffer.byteLength(body, 'utf8') > CHANGE_SET_LIMITS.storeBytes) throw new Error('store full');
      await this.checkDirectory(true);
      try {
        const target = await lstat(this.filename, { bigint: true });
        if (!target.isFile() || target.isSymbolicLink() || target.nlink !== 1n) throw new Error('invalid target');
      } catch (error) { if (!isMissing(error)) throw error; }
      temporary = path.join(this.baseDir, `.change-sets-${randomUUID()}.tmp`);
      const handle = await open(temporary, 'wx', 0o600);
      let writtenIdentity: string;
      try {
        await this.checkDirectory(false);
        const opened = await handle.stat({ bigint: true });
        if (!opened.isFile() || opened.nlink !== 1n) throw new Error('invalid temporary');
        writtenIdentity = `${opened.dev}:${opened.ino}:${opened.birthtimeNs}`;
        await handle.writeFile(body, 'utf8');
        await handle.sync();
      }
      finally { await handle.close(); }
      await this.checkDirectory(false);
      const written = await lstat(temporary, { bigint: true });
      if (!written.isFile() || written.isSymbolicLink() || written.nlink !== 1n
        || `${written.dev}:${written.ino}:${written.birthtimeNs}` !== writtenIdentity!) {
        throw new Error('temporary changed');
      }
      await rename(temporary, this.filename);
      temporary = undefined;
      await this.checkDirectory(false);
      const saved = await lstat(this.filename, { bigint: true });
      if (!saved.isFile() || saved.isSymbolicLink() || saved.nlink !== 1n
        || `${saved.dev}:${saved.ino}:${saved.birthtimeNs}` !== writtenIdentity!) throw new Error('saved store changed');
    } catch {
      this.failure = true;
      throw new Error('变更集记录无法安全持久化，已停止后续操作；已发生的文件变化不会自动回滚。');
    } finally {
      if (temporary) {
        try { await this.checkDirectory(false); await unlink(temporary); } catch { /* Preserve uncertain paths for inspection. */ }
      }
    }
  }

  private serial<T>(action: () => Promise<T>): Promise<T> {
    const next = this.queue.then(action);
    this.queue = next.then(() => {}, () => {});
    return next;
  }

  read(): Promise<ChangeSetJournal> {
    return this.serial(async () => clone(await this.load()));
  }

  update<T>(edit: (draft: ChangeSetJournal) => T): Promise<T> {
    return this.serial(async () => {
      const draft = clone(await this.load());
      const result = edit(draft);
      await this.persist(draft);
      this.data = draft;
      return clone(result);
    });
  }
}
