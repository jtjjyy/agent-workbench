import { createHash } from 'node:crypto';
import { CHANGE_SET_LIMITS, type ChangeIdentity, type ChangeOperation } from '../../shared/change-set';
import { decodeUtf8Text } from '../tools/readonly-tools';
import { WorkspacePolicyError } from '../workspace/workspace-session';

export const sha256 = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');
export const isHash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
export const clone = <T>(value: T): T => value === undefined ? value : JSON.parse(JSON.stringify(value)) as T;
export const isMissing = (error: unknown): boolean => !!error && typeof error === 'object'
  && 'code' in error && error.code === 'ENOENT';

export function plainObject(value: unknown, allowed: readonly string[], required = allowed): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    throw new WorkspacePolicyError('参数必须是普通数据对象。');
  }
  const keys = Reflect.ownKeys(value);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (keys.some((key) => typeof key !== 'string' || !allowed.includes(key))
    || required.some((key) => !Object.hasOwn(value, key))
    || Object.values(descriptors).some((entry) => !('value' in entry) || !entry.enumerable)) {
    throw new WorkspacePolicyError('参数包含缺失、额外或非普通数据字段。');
  }
  return value as Record<string, unknown>;
}

export function assertIdentity(value: ChangeIdentity): void {
  for (const field of ['runId', 'taskId', 'toolCallId'] as const) {
    if (typeof value[field] !== 'string' || !value[field].trim() || value[field].length > 256
      || /[\u0000-\u001f\u007f-\u009f]/u.test(value[field])) {
      throw new WorkspacePolicyError('任务、运行或工具调用标识无效。');
    }
  }
}

// 宁可拒绝包含疑似凭据的正文，也不将其加入审批、持久化或模型输出。
export function containsSecret(text: string): boolean {
  return /-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[A-Z0-9]{16})\b/u.test(text)
    || /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/u.test(text)
    || /(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|passwd|secret|authorization)\s*["']?\s*[:=]\s*["']?(?:Bearer\s+)?[A-Za-z0-9+/_=-]{12,}/iu.test(text)
    || /[a-z][a-z0-9+.-]*:\/\/[^\s/@]+:[^\s/@]+@/iu.test(text);
}

export function safeOutput(text: string): string {
  if (containsSecret(text)) return '[输出包含疑似凭据，已整体隐藏；请在本地脱敏后查看。]';
  return text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/gu, '')
    .slice(0, CHANGE_SET_LIMITS.outputLength);
}

export function assertSafeText(text: unknown): asserts text is string {
  if (typeof text !== 'string' || text.length > CHANGE_SET_LIMITS.textLength
    || Buffer.byteLength(text, 'utf8') > CHANGE_SET_LIMITS.fileBytes
    || decodeUtf8Text(Buffer.from(text, 'utf8'), undefined, true) !== text) {
    throw new WorkspacePolicyError('正文必须是可往返的 UTF-8 文本，最多三十二 KiB 和一万二千个 UTF-16 单元。');
  }
  if (containsSecret(text)) throw new WorkspacePolicyError('正文含疑似凭据，已拒绝加入变更集；请先移除密钥。');
}

export function parseOperations(value: unknown): ChangeOperation[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > CHANGE_SET_LIMITS.operations) {
    throw new WorkspacePolicyError('变更集必须包含一至二十项操作。');
  }
  const parsed: ChangeOperation[] = [];
  for (const item of value) {
    const data = plainObject(item, ['operation', 'path', 'toPath', 'beforeSha256', 'afterText'], ['operation', 'path']);
    const fields = data.operation === 'create' ? ['operation', 'path', 'afterText']
      : data.operation === 'update' ? ['operation', 'path', 'beforeSha256', 'afterText']
        : data.operation === 'delete' ? ['operation', 'path', 'beforeSha256']
          : data.operation === 'rename' ? ['operation', 'path', 'beforeSha256', 'toPath'] : null;
    if (!fields) throw new WorkspacePolicyError('仅支持 create、update、delete 和 rename。');
    plainObject(data, fields);
    for (const key of ['path', ...(data.operation === 'rename' ? ['toPath'] : [])]) {
      if (typeof data[key] !== 'string' || !data[key] || (data[key] as string).length > 512) {
        throw new WorkspacePolicyError('操作路径必须是有界工作区相对路径。');
      }
    }
    if (data.operation !== 'create' && !isHash(data.beforeSha256)) {
      throw new WorkspacePolicyError('修改、删除和重命名必须提供读取时的 beforeSha256。');
    }
    if (fields.includes('afterText')) assertSafeText(data.afterText);
    parsed.push({ ...data } as ChangeOperation);
  }
  return parsed;
}
