import { constants } from 'node:fs';
import { link, open, unlink, type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { CHANGE_SET_LIMITS, type ChangeItemResult, type ChangeOperation, type ChangePreview } from '../../shared/change-set';
import {
  assertBoundedTextTarget, checkedPath, readBoundedTextFile, sameFileSnapshot,
  sameIdentity, samePathIdentity, type BoundedTextFile, type CheckedPath, type WorkspaceFileContext,
} from '../tools/readonly-tools';
import { sameCanonicalPath, WorkspacePolicyError } from '../workspace/workspace-session';
import { assertSafeText, isMissing, parseOperations, sha256 } from './change-set-policy';

export const TEXT_OPTIONS = {
  maxBytes: CHANGE_SET_LIMITS.fileBytes, maxTextLength: CHANGE_SET_LIMITS.textLength,
  rejectHardLinks: true, preserveBom: true,
} as const;

interface AbsentTarget {
  absolute: string;
  relative: string;
  parent: CheckedPath;
}
export interface PreparedChange {
  preview: ChangePreview;
  before?: BoundedTextFile;
  target?: AbsentTarget;
  afterBytes?: Buffer;
}

export function rootIdentity(context: WorkspaceFileContext): string {
  return `${context.rootStat.dev}:${context.rootStat.ino}`;
}

export async function absentTarget(context: WorkspaceFileContext, relative: string): Promise<AbsentTarget> {
  // checkedPath 在 lstat 前检查完整路径的敏感名称、深度、设备名和越界。
  try {
    await checkedPath(context, relative);
  } catch (error) {
    if (!isMissing(error)) throw error;
    const segments = relative.split(/[\\/]/u);
    const parentRelative = segments.slice(0, -1).join('/') || '.';
    const parent = await checkedPath(context, parentRelative);
    if (!parent.stat.isDirectory()) throw new WorkspacePolicyError('目标父目录必须已存在且为普通目录。');
    const normalized = segments.join('/');
    // 沿用只读工具的扩展名白名单，不在此复制另一套白名单。
    assertBoundedTextTarget({ ...parent, relative: normalized,
      stat: { ...parent.stat, size: 0n, nlink: 1n, isFile: () => true } }, TEXT_OPTIONS);
    // 父目录存在后，再检查最终目标不存在，拒绝悬空链接和已存在文件。
    try { await checkedPath(context, normalized); }
    catch (lastError) {
      if (isMissing(lastError)) return { relative: normalized, parent,
        absolute: path.join(parent.absolute, segments[segments.length - 1]) };
      throw lastError;
    }
  }
  throw new WorkspacePolicyError('新建或重命名目标已存在，不能覆盖。');
}

async function checkAbsent(context: WorkspaceFileContext, before: AbsentTarget): Promise<AbsentTarget> {
  const current = await absentTarget(context, before.relative);
  if (!sameCanonicalPath(before.absolute, current.absolute) || !samePathIdentity(before.parent, current.parent)) {
    throw new WorkspacePolicyError('目标父目录链或工作区身份已变化。');
  }
  return current;
}

export async function prepareChanges(context: WorkspaceFileContext, input: unknown): Promise<PreparedChange[]> {
  const operations: ChangeOperation[] = parseOperations(input);
  const prepared: PreparedChange[] = [];
  const touched = new Set<string>();
  let bytes = 0;
  for (const operation of operations) {
    context.signal?.throwIfAborted();
    const before = operation.operation === 'create' ? undefined
      : await readBoundedTextFile(context, operation.path, TEXT_OPTIONS);
    if (before) {
      assertSafeText(before.text);
      if (operation.operation !== 'create' && before.sha256 !== operation.beforeSha256) {
        throw new WorkspacePolicyError('beforeSha256 与当前完整文件不一致，不能生成审批。');
      }
    }
    const target = operation.operation === 'create' ? await absentTarget(context, operation.path)
      : operation.operation === 'rename' ? await absentTarget(context, operation.toPath) : undefined;
    const relative = before?.relative ?? target!.relative;
    for (const candidate of [relative, ...(operation.operation === 'rename' ? [target!.relative] : [])]) {
      const key = process.platform === 'win32' ? candidate.toLowerCase() : candidate;
      if (touched.has(key)) throw new WorkspacePolicyError('同一批次不得重复使用源路径或目标路径；请拆分依赖操作。');
      touched.add(key);
    }
    const afterText = operation.operation === 'create' || operation.operation === 'update' ? operation.afterText
      : operation.operation === 'rename' ? before!.text : null;
    const afterBytes = afterText === null ? undefined : Buffer.from(afterText, 'utf8');
    if (operation.operation === 'update' && before!.bytes.equals(afterBytes!)) {
      throw new WorkspacePolicyError('修改前后内容相同，已拒绝无变化操作。');
    }
    bytes += (before?.bytes.length ?? 0) + (afterBytes?.length ?? 0);
    if (bytes > CHANGE_SET_LIMITS.batchBytes) throw new WorkspacePolicyError('前后正文合计超过五百一十二 KiB。');
    prepared.push({ before, target, afterBytes, preview: {
      operation: operation.operation, path: relative,
      ...(operation.operation === 'rename' ? { toPath: target!.relative } : {}),
      beforeSha256: before?.sha256 ?? null, afterSha256: afterBytes ? sha256(afterBytes) : null,
      beforeText: before?.text ?? null, afterText,
    } });
  }
  return prepared;
}

export function resultFor(change: PreparedChange, status: ChangeItemResult['status']): ChangeItemResult {
  const { beforeText: _before, afterText: _after, ...hashes } = change.preview;
  const summaries: Record<ChangeItemResult['status'], string> = {
    pending: '等待本次完整变更审批。', not_applied: '未开始此项操作。',
    applied: '已应用并复读确认当前文件哈希或路径不存在。',
    conflict: '路径、目录身份或原始内容已变化，未开始此项操作。',
    failed: '操作未能开始，未确认有文件变化。',
    unknown: '操作开始后结果无法完全确认；请人工核对，不自动重放或回滚。',
  };
  return { ...hashes, status, summary: summaries[status] };
}

export async function preflight(context: WorkspaceFileContext, change: PreparedChange, handle?: FileHandle): Promise<void> {
  context.signal?.throwIfAborted();
  if (change.before) {
    const current = await readBoundedTextFile(context, change.preview.path, TEXT_OPTIONS, handle);
    if (!samePathIdentity(change.before, current) || !sameFileSnapshot(change.before.stat, current.stat)
      || current.sha256 !== change.preview.beforeSha256 || !current.bytes.equals(change.before.bytes)) {
      throw new WorkspacePolicyError('审批后的文件快照或路径身份已变化。');
    }
  }
  if (change.target) await checkAbsent(context, change.target);
}

const openFlags = (mode: number) => mode | (process.platform === 'win32' ? 0
  : (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));

async function assertFinal(context: WorkspaceFileContext, change: PreparedChange, handle?: FileHandle): Promise<void> {
  const finalContext = { ...context, signal: undefined };
  const operation = change.preview.operation;
  if (operation === 'delete' || operation === 'rename') await absentTarget(finalContext, change.preview.path);
  if (operation !== 'delete') {
    const final = await readBoundedTextFile(finalContext, change.preview.toPath ?? change.preview.path, TEXT_OPTIONS, handle);
    if (final.sha256 !== change.preview.afterSha256 || !final.bytes.equals(change.afterBytes!)) {
      throw new WorkspacePolicyError('操作后完整字节与批准内容不一致。');
    }
    if (change.before && operation === 'update' && !samePathIdentity(change.before, final)) {
      throw new WorkspacePolicyError('写入后的文件身份发生变化。');
    }
    if (change.target) {
      const parent = await checkedPath(finalContext, change.target.parent.relative);
      if (!samePathIdentity(change.target.parent, parent)) throw new WorkspacePolicyError('操作后的父目录身份变化。');
    }
  }
}

export async function applyChange(context: WorkspaceFileContext, change: PreparedChange,
  expiresAt?: number): Promise<ChangeItemResult> {
  const assertActive = () => {
    context.signal?.throwIfAborted();
    if (expiresAt !== undefined && Date.now() >= expiresAt) throw new WorkspacePolicyError('审批已过期，不能开始下一次文件操作。');
  };
  let handle: FileHandle | undefined;
  let mutationAttempted = false;
  let outcome = resultFor(change, 'failed');
  try {
    await preflight(context, change);
    const operation = change.preview.operation;
    if (operation === 'update') {
      handle = await open(change.before!.absolute, openFlags(constants.O_RDWR));
      await preflight(context, change, handle);
      const currentPath = await checkedPath(context, change.preview.path);
      const currentStat = await handle.stat({ bigint: true });
      if (!sameFileSnapshot(change.before!.stat, currentStat)
        || !sameFileSnapshot(currentStat, currentPath.stat) || !samePathIdentity(change.before!, currentPath)) {
        throw new WorkspacePolicyError('写入前最后复查不一致。');
      }
      assertActive();
      if (change.afterBytes!.length) {
        mutationAttempted = true;
        const written = await handle.write(change.afterBytes!, 0, change.afterBytes!.length, 0);
        if (written.bytesWritten !== change.afterBytes!.length) throw new WorkspacePolicyError('正文发生短写。');
      }
      if (change.afterBytes!.length < change.before!.bytes.length) {
        assertActive();
        const target = await checkedPath(context, change.preview.path);
        const stat = await handle.stat({ bigint: true });
        assertBoundedTextTarget(target, TEXT_OPTIONS);
        if (!samePathIdentity(change.before!, target) || !sameIdentity(stat, target.stat)
          || stat.size !== BigInt(change.before!.bytes.length)) throw new WorkspacePolicyError('截尾前身份或长度已变化。');
        const retained = Buffer.alloc(change.afterBytes!.length);
        const read = await handle.read(retained, 0, retained.length, 0);
        if (read.bytesRead !== retained.length || !retained.equals(change.afterBytes!)) {
          throw new WorkspacePolicyError('截尾前保留正文与批准内容不同。');
        }
        assertActive();
        mutationAttempted = true;
        await handle.truncate(change.afterBytes!.length);
      }
      await handle.sync();
    } else if (operation === 'create') {
      await checkAbsent(context, change.target!);
      assertActive();
      mutationAttempted = true;
      handle = await open(change.target!.absolute, openFlags(constants.O_RDWR | constants.O_CREAT | constants.O_EXCL), 0o600);
      const createdPath = await checkedPath(context, change.target!.relative);
      const createdStat = await handle.stat({ bigint: true });
      assertBoundedTextTarget(createdPath, TEXT_OPTIONS);
      if (!sameIdentity(createdStat, createdPath.stat) || createdStat.size !== 0n) {
        throw new WorkspacePolicyError('新建文件身份未确认。');
      }
      const parent = await checkedPath(context, change.target!.parent.relative);
      if (!samePathIdentity(change.target!.parent, parent)) throw new WorkspacePolicyError('新建时父目录链发生变化。');
      assertActive();
      if (change.afterBytes!.length) {
        const written = await handle.write(change.afterBytes!, 0, change.afterBytes!.length, 0);
        if (written.bytesWritten !== change.afterBytes!.length) throw new WorkspacePolicyError('新建正文发生短写。');
      }
      await handle.sync();
    } else if (operation === 'delete') {
      await preflight(context, change);
      assertActive();
      mutationAttempted = true;
      await unlink(change.before!.absolute);
    } else {
      await preflight(context, change);
      assertActive();
      // 原生 rename 可能覆盖竞态中新建的目标；link + unlink 保证目标排他创建。
      // 两步之间可能同时存在两个名称，失败时保留真实状态，不自动清理。
      mutationAttempted = true;
      await link(change.before!.absolute, change.target!.absolute);
      const source = await readBoundedTextFile(context, change.preview.path, { ...TEXT_OPTIONS, rejectHardLinks: false });
      const destination = await readBoundedTextFile(context, change.target!.relative, { ...TEXT_OPTIONS, rejectHardLinks: false });
      const parent = await checkedPath(context, change.target!.parent.relative);
      if (!samePathIdentity(change.before!, source) || !sameIdentity(source.stat, destination.stat)
        || !samePathIdentity(change.target!.parent, parent) || source.stat.nlink !== 2n
        || destination.stat.nlink !== 2n || source.sha256 !== change.preview.beforeSha256
        || destination.sha256 !== change.preview.afterSha256) throw new WorkspacePolicyError('重命名中间状态不一致。');
      assertActive();
      const finalSource = await checkedPath(context, change.preview.path);
      if (!sameFileSnapshot(source.stat, finalSource.stat) || !samePathIdentity(source, finalSource)) {
        throw new WorkspacePolicyError('移除旧名称前源文件发生变化。');
      }
      assertActive();
      await unlink(change.before!.absolute);
    }
    await assertFinal(context, change, handle);
    outcome = resultFor(change, 'applied');
  } catch (error) {
    outcome = resultFor(change, mutationAttempted ? 'unknown'
      : context.signal?.aborted ? 'not_applied'
        : error instanceof WorkspacePolicyError || isMissing(error) ? 'conflict' : 'failed');
  } finally {
    if (handle) {
      try { await handle.close(); }
      catch { outcome = resultFor(change, mutationAttempted ? 'unknown' : 'failed'); }
    }
  }
  return outcome;
}
