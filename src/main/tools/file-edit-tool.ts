import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open, type FileHandle } from 'node:fs/promises';
import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core';
import { Type } from 'typebox';
import {
  MAX_EDIT_FILE_BYTES, MAX_EDIT_TEXT_LENGTH,
  type ApplyFileEdit, type EditOutcome, type EditOutcomeStatus, type FileEditHandler, type FileEditProposal,
} from '../../shared/file-edit';
import type { SourceEvidence, WorkspaceState } from '../../shared/workspace';
import { WorkspacePolicyError } from '../workspace/workspace-session';
import {
  assertBoundedTextTarget, checkedPath, createWorkspaceFileContext, decodeUtf8Text,
  readBoundedTextFile, sameFileSnapshot, sameIdentity, samePathIdentity,
  type BoundedTextFile, type WorkspaceFileContext,
} from './readonly-tools';

type ReplaceParameters = { path: string; oldText: string; newText: string };
type EditDetails = {
  status: EditOutcomeStatus;
  summary: string;
  sources: SourceEvidence[];
  path?: string;
  beforeSha256?: string;
  afterSha256?: string;
};
type PreparedEdit = {
  context: WorkspaceFileContext;
  before: BoundedTextFile;
  afterBytes: Buffer;
  proposal: FileEditProposal;
};

const READ_OPTIONS = {
  maxBytes: MAX_EDIT_FILE_BYTES, maxTextLength: MAX_EDIT_TEXT_LENGTH, rejectHardLinks: true, preserveBom: true,
} as const;
const SUMMARIES: Record<EditOutcomeStatus, string> = {
  applied: '已写入批准的修改，并在同步后复查路径身份与完整字节哈希；取消不代表回滚。',
  rejected: '本次修改未获批准，未调用文件写入。',
  expired: '修改审批已过期，未调用文件写入。',
  cancelled: '本次修改在写入前已取消，未调用文件写入。',
  conflict: '工作区、父目录链、文件身份或字节快照已变化，未调用文件写入。',
  failed: '文件修改无法安全完成，未调用文件写入。',
  unknown: '写入开始后无法确认完整结果，文件可能已经部分或全部改变；停止任务并人工检查，不重放或自动回滚。',
};
const schema = Type.Object({
  path: Type.String({ minLength: 1, maxLength: 512, description: '工作区内已有白名单文本文件的相对路径。' }),
  oldText: Type.String({ minLength: 1, maxLength: MAX_EDIT_TEXT_LENGTH,
    description: '区分大小写的非空字面片段，必须只出现一次，包含重叠匹配检查。' }),
  newText: Type.String({ maxLength: MAX_EDIT_TEXT_LENGTH,
    description: '替换后的字面片段；允许空字符串表示删除，但不能与旧片段相同。' }),
}, { additionalProperties: false });

function strictParameters(input: unknown): ReplaceParameters {
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) {
    throw new WorkspacePolicyError('替换参数必须是普通对象。');
  }
  const keys = Reflect.ownKeys(input);
  if (keys.length !== 3 || keys.some((key) => typeof key !== 'string'
    || !['path', 'oldText', 'newText'].includes(key))) {
    throw new WorkspacePolicyError('替换参数必须且只能包含 path、oldText 和 newText。');
  }
  const descriptors = Object.getOwnPropertyDescriptors(input);
  if (Object.values(descriptors).some((descriptor) => !('value' in descriptor)
    || !descriptor.enumerable || typeof descriptor.value !== 'string')) {
    throw new WorkspacePolicyError('替换参数必须是可枚举的普通字符串字段，不接受访问器或类型转换。');
  }
  const params = input as ReplaceParameters;
  if (!params.path || params.path.length > 512) {
    throw new WorkspacePolicyError('请提供不超过五百一十二个 UTF-16 单元的工作区相对路径。');
  }
  if (!params.oldText || params.oldText.length > MAX_EDIT_TEXT_LENGTH
    || params.newText.length > MAX_EDIT_TEXT_LENGTH) {
    throw new WorkspacePolicyError('旧片段必须非空，前后片段各最多一万二千个 UTF-16 单元。');
  }
  if (params.oldText === params.newText) {
    throw new WorkspacePolicyError('替换前后片段相同，已拒绝没有变化的修改。');
  }
  return { path: params.path, oldText: params.oldText, newText: params.newText };
}

function outcome(status: EditOutcomeStatus): EditOutcome {
  return { status, summary: SUMMARIES[status] };
}

function toolResult(edit: EditOutcome, proposal?: FileEditProposal): AgentToolResult<EditDetails> {
  if (!Object.prototype.hasOwnProperty.call(SUMMARIES, edit.status)) {
    throw new Error('审批处理器返回了不支持的修改结果。');
  }
  // 处理器摘要和提案正文不进入模型结果，避免日志错误或 Diff 内容泄漏。
  const summary = SUMMARIES[edit.status];
  const details: EditDetails = { status: edit.status, summary, sources: [] };
  const blocks = [summary];
  if (proposal) {
    Object.assign(details, { path: proposal.path, beforeSha256: proposal.beforeSha256,
      afterSha256: proposal.afterSha256 });
    blocks.push(`相对路径：${JSON.stringify(proposal.path)}`,
      `修改前 SHA-256：${proposal.beforeSha256}`, `修改后 SHA-256：${proposal.afterSha256}`);
  }
  return { content: [{ type: 'text', text: blocks.join('\n') }], details, isError: edit.status !== 'applied' };
}

async function prepareEdit(workspace: WorkspaceState, input: unknown, signal: AbortSignal): Promise<PreparedEdit> {
  signal.throwIfAborted();
  const params = strictParameters(input);
  const context = await createWorkspaceFileContext(workspace, signal);
  const before = await readBoundedTextFile(context, params.path, READ_OPTIONS);
  const index = before.text.indexOf(params.oldText);
  if (index < 0 || before.text.indexOf(params.oldText, index + 1) !== -1) {
    throw new WorkspacePolicyError('旧片段必须在完整正文中恰好出现一次；零匹配、多匹配和重叠匹配均拒绝修改。');
  }
  const afterText = before.text.slice(0, index) + params.newText + before.text.slice(index + params.oldText.length);
  if (afterText.length > MAX_EDIT_TEXT_LENGTH) {
    throw new WorkspacePolicyError('修改后的完整正文超过一万二千个 UTF-16 单元。');
  }
  if (before.text.startsWith('\ufeff') !== afterText.startsWith('\ufeff')) {
    throw new WorkspacePolicyError('不允许替换片段改变文件的 UTF-8 BOM 边界。');
  }
  const afterBytes = Buffer.from(afterText, 'utf8');
  if (afterBytes.length > MAX_EDIT_FILE_BYTES) {
    throw new WorkspacePolicyError('修改后的原始字节超过三十二 KiB。');
  }
  if (decodeUtf8Text(afterBytes, signal, true) !== afterText) {
    throw new WorkspacePolicyError('修改会产生不可往返的 UTF-8 文本或改变 BOM 边界，已拒绝修改。');
  }
  if (before.bytes.equals(afterBytes)) {
    throw new WorkspacePolicyError('修改前后原始字节相同，已拒绝没有变化的修改。');
  }
  const proposal: FileEditProposal = Object.freeze({ path: before.relative, beforeText: before.text,
    afterText, beforeSha256: before.sha256, afterSha256: createHash('sha256').update(afterBytes).digest('hex') });
  return { context, before, afterBytes, proposal };
}

async function applyEdit(prepared: PreparedEdit, signal: AbortSignal): Promise<EditOutcome> {
  const { before, afterBytes, proposal } = prepared;
  const context = { ...prepared.context, signal };
  let handle: FileHandle | undefined;
  let mutationAttempted = false;
  let phase: 'checking' | 'opening' = 'checking';
  let result = outcome('failed');
  try {
    signal.throwIfAborted();
    const target = await checkedPath(context, proposal.path);
    assertBoundedTextTarget(target, READ_OPTIONS);
    if (!samePathIdentity(before, target) || !sameFileSnapshot(before.stat, target.stat)) {
      throw new WorkspacePolicyError('审批期间路径或文件快照发生变化。');
    }
    signal.throwIfAborted();
    // O_RDWR 等价于 r+：不创建、不跟随最终符号链接（POSIX）、不预先截断。
    const flags = constants.O_RDWR | (process.platform === 'win32' ? 0
      : (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    phase = 'opening';
    handle = await open(target.absolute, flags);
    phase = 'checking';
    const verified = await readBoundedTextFile(context, proposal.path, READ_OPTIONS, handle);
    if (!samePathIdentity(before, verified) || !sameFileSnapshot(before.stat, verified.stat)
      || verified.sha256 !== proposal.beforeSha256 || !verified.bytes.equals(before.bytes)) {
      throw new WorkspacePolicyError('审批期间原始字节或文件身份发生变化。');
    }
    const lastPath = await checkedPath(context, proposal.path);
    const lastStat = await handle.stat({ bigint: true });
    assertBoundedTextTarget(lastPath, READ_OPTIONS);
    assertBoundedTextTarget({ ...lastPath, stat: lastStat }, READ_OPTIONS);
    if (!samePathIdentity(before, lastPath) || !sameFileSnapshot(verified.stat, lastStat)
      || !sameFileSnapshot(lastStat, lastPath.stat)) {
      throw new WorkspacePolicyError('文件在写入前的最后复查中发生变化。');
    }
    signal.throwIfAborted();
    if (afterBytes.length) {
      // 单次有界写调用；短写或异常后不补写、不重试，保守判为 unknown。
      mutationAttempted = true;
      const written = await handle.write(afterBytes, 0, afterBytes.length, 0);
      if (written.bytesWritten !== afterBytes.length) {
        throw new WorkspacePolicyError('完整正文未一次写完。');
      }
    }
    if (afterBytes.length < before.bytes.length) {
      signal.throwIfAborted();
      const truncatePath = await checkedPath(context, proposal.path);
      const truncateStat = await handle.stat({ bigint: true });
      assertBoundedTextTarget(truncatePath, READ_OPTIONS);
      assertBoundedTextTarget({ ...truncatePath, stat: truncateStat }, READ_OPTIONS);
      if (!samePathIdentity(before, truncatePath) || !sameIdentity(truncatePath.stat, truncateStat)
        || truncateStat.size !== BigInt(before.bytes.length)) {
        throw new WorkspacePolicyError('截尾前路径、身份或长度发生变化。');
      }
      const retained = Buffer.alloc(afterBytes.length);
      const retainedRead = await handle.read(retained, 0, retained.length, 0);
      if (retainedRead.bytesRead !== retained.length || !retained.equals(afterBytes)) {
        throw new WorkspacePolicyError('截尾前将保留的目标字节与批准内容不一致。');
      }
      signal.throwIfAborted();
      mutationAttempted = true;
      await handle.truncate(afterBytes.length);
    }
    // 正文和长度已写完后，即使取消也完成有限的同步与复读，以区分 applied 和 unknown。
    await handle.sync();
    const final = await readBoundedTextFile({ ...context, signal: undefined }, proposal.path, READ_OPTIONS, handle);
    if (!samePathIdentity(before, final) || final.sha256 !== proposal.afterSha256
      || !final.bytes.equals(afterBytes)) {
      throw new WorkspacePolicyError('写入后不能确认已批准的字节和路径身份。');
    }
    result = outcome('applied');
  } catch (error) {
    result = outcome(mutationAttempted ? 'unknown' : signal.aborted ? 'cancelled'
      : error instanceof WorkspacePolicyError || phase === 'checking' ? 'conflict' : 'failed');
  } finally {
    if (handle) {
      try { await handle.close(); }
      catch { result = outcome(mutationAttempted ? 'unknown' : 'failed'); }
    }
  }
  return result;
}

export function createFileEditTool(workspace: WorkspaceState, onEdit: FileEditHandler): AgentTool {
  const selected = { ...workspace };
  return {
    name: 'replace_text', label: '替换文本', parameters: schema,
    description: '对工作区内已有 UTF-8 白名单普通文件提出唯一字面片段替换，须经用户审批。前后文件各最多三十二 KiB、完整正文各最多一万二千个 UTF-16 单元；不允许链接、新建或无变化修改。仅返回摘要、相对路径与前后哈希，不返回全文。',
    executionMode: 'sequential', replay: 'never',
    execute: async (_sdkId, input, runSignal) => {
      const signal = runSignal ?? new AbortController().signal;
      let prepared: PreparedEdit;
      try {
        prepared = await prepareEdit(selected, input, signal);
      } catch (error) {
        const result = toolResult(outcome(signal.aborted ? 'cancelled' : 'failed'));
        if (!signal.aborted && error instanceof WorkspacePolicyError) {
          result.details.summary = error.message;
          result.content = [{ type: 'text', text: error.message }];
        }
        return result;
      }
      let available = true;
      let consumed = false;
      const apply: ApplyFileEdit = async (applySignal) => {
        if (!available || consumed) return outcome('failed');
        consumed = true;
        return applyEdit(prepared, AbortSignal.any([signal, applySignal]));
      };
      // 主运行时绑定应用工具 ID，负责审批和日志；其错误必须原样传播并中止任务。
      try {
        const result = await onEdit(prepared.proposal, apply, signal);
        return toolResult(result, prepared.proposal);
      } finally {
        available = false;
      }
    },
  };
}
