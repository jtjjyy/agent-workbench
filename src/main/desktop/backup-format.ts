import { createHash } from 'node:crypto';
import { lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { TextDecoder } from 'node:util';
import { validateEventEnvelope, type EventEnvelope } from '../../shared/contracts';
import { validateModelSettings } from '../../shared/model-settings';
import {
  DESKTOP_BACKUP_FORMAT, DESKTOP_DATA_SCOPES, validateDesktopBackupRequest,
  type DesktopDataScope,
} from '../../shared/desktop';
import { assertSafePath, DesktopServiceError, isMissing, parseJson, readBounded } from './safe-files';
import { canonicalLegacySystemPath } from './data-paths';

export const MAX_BACKUP_BYTES = 64 * 1024 * 1024;
export const MAX_DATA_BYTES = 32 * 1024 * 1024;
export const MAX_BACKUP_FILES = 256;
export const MAX_FILE_BYTES = 8 * 1024 * 1024;

export type BackupFile = { path: string; bytes: number; sha256: string; content: string };
export interface DesktopArchive {
  format: typeof DESKTOP_BACKUP_FORMAT;
  schemaVersion: 1;
  dataSchemaVersion: 1;
  version: string;
  createdAt: string;
  platform: string;
  credentialPortability: 'same-machine-account';
  scopes: DesktopDataScope[];
  files: BackupFile[];
}

export type TaskDataValidator = (path: string, value: unknown) => boolean;
export type ChangeDataValidator = (path: string, value: unknown) => boolean;
export interface ArchiveValidators { validateTaskData?: TaskDataValidator; validateChangeData?: ChangeDataValidator }

export function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

export function onlyKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

export function scopeForPath(path: string): DesktopDataScope | null {
  if (path === 'settings/model-v1.json') return 'settings';
  if (path === 'events/conversation-v1.jsonl') return 'conversations';
  if (path === 'knowledge/memories-v1.json') return 'memories';
  if (path === 'skills/settings-v1.json') return 'skills';
  if (path === 'tasks/tasks-v1.json' || path === 'changes/change-sets.v1.json') return 'tasks';
  return null;
}

export function fileLimit(path: string): number {
  if (path === 'settings/model-v1.json') return 16 * 1024;
  if (path === 'events/conversation-v1.jsonl') return MAX_DATA_BYTES;
  if (path === 'tasks/tasks-v1.json' || path === 'changes/change-sets.v1.json') return MAX_DATA_BYTES;
  return MAX_FILE_BYTES;
}

export function digest(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export function validBase64(value: unknown): value is string {
  return typeof value === 'string' && value.length <= MAX_BACKUP_BYTES
    && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)
    && Buffer.from(value, 'base64').toString('base64') === value;
}

export async function collectFiles(root: string, scopes: DesktopDataScope[]): Promise<BackupFile[]> {
  return collectResolvedFiles(root, scopes, (path) => path);
}

// 仅由首次迁移调用；正常数据、用户备份与恢复仍不接受路径别名。
export async function collectLegacyFiles(root: string, scopes: DesktopDataScope[]): Promise<BackupFile[]> {
  return collectResolvedFiles(root, scopes, canonicalLegacySystemPath);
}

async function collectResolvedFiles(
  root: string, scopes: DesktopDataScope[], resolveSource: (path: string) => string,
): Promise<BackupFile[]> {
  const actualRoot = resolveSource(root);
  await assertSafePath(actualRoot);
  if (!(await lstat(actualRoot)).isDirectory()) throw new DesktopServiceError('UNSAFE_PATH');
  const paths = ['settings/model-v1.json', 'events/conversation-v1.jsonl',
    'knowledge/memories-v1.json', 'skills/settings-v1.json',
    'tasks/tasks-v1.json', 'changes/change-sets.v1.json']
    .filter((path) => scopes.includes(scopeForPath(path) as DesktopDataScope));
  if (scopes.includes('tasks')) {
    for (const directory of ['tasks', 'changes']) {
      try {
        const taskRoot = resolveSource(join(root, directory));
        await assertSafePath(taskRoot);
        if (!(await lstat(taskRoot)).isDirectory()) throw new DesktopServiceError('UNSAFE_PATH');
        for (const entry of await readdir(taskRoot, { withFileTypes: true })) {
          const path = `${directory}/${entry.name}`;
          if (scopeForPath(path) === 'tasks') {
            if (!entry.isFile() || entry.isSymbolicLink()) throw new DesktopServiceError('UNSAFE_PATH');
          } else if (!/^[A-Za-z0-9.-]+\.tmp$/u.test(entry.name)) {
            // Unknown task layouts must be added explicitly; never silently omit task records.
            throw new DesktopServiceError('INVALID_BACKUP');
          }
        }
      } catch (error) { if (!isMissing(error)) throw error; }
    }
  }
  const files: BackupFile[] = [];
  let total = 0;
  for (const path of paths.sort()) {
    let bytes: Buffer;
    try { bytes = await readBounded(resolveSource(join(root, ...path.split('/'))), fileLimit(path)); }
    catch (error) { if (isMissing(error)) continue; throw error; }
    total += bytes.length;
    if (total > MAX_DATA_BYTES || files.length >= MAX_BACKUP_FILES) throw new DesktopServiceError('BACKUP_TOO_LARGE');
    files.push({ path, bytes: bytes.length, sha256: digest(bytes), content: bytes.toString('base64') });
  }
  return files;
}

export function encodeArchive(version: string, scopes: DesktopDataScope[], files: BackupFile[]): Buffer {
  const archive: DesktopArchive = {
    format: DESKTOP_BACKUP_FORMAT, schemaVersion: 1, dataSchemaVersion: 1, version,
    createdAt: new Date().toISOString(), platform: process.platform,
    credentialPortability: 'same-machine-account', scopes: [...scopes], files,
  };
  const bytes = Buffer.from(`${JSON.stringify(archive)}\n`, 'utf8');
  if (bytes.length > MAX_BACKUP_BYTES) throw new DesktopServiceError('BACKUP_TOO_LARGE');
  return bytes;
}

export function validateFileContent(path: string, bytes: Buffer, validators: ArchiveValidators = {}): void {
  if (path === 'events/conversation-v1.jsonl') {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    const sequences = new Map<string, number>();
    const ids = new Set<string>();
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      const value: unknown = JSON.parse(line);
      const validation = validateEventEnvelope(value);
      if (!validation.ok) throw new DesktopServiceError('INVALID_BACKUP');
      const event = value as EventEnvelope;
      if (ids.has(event.eventId)
        || event.sequence !== (sequences.get(event.conversationId) ?? 0) + 1) {
        throw new DesktopServiceError('INVALID_BACKUP');
      }
      sequences.set(event.conversationId, event.sequence);
      ids.add(event.eventId);
    }
    return;
  }
  const value = parseJson(bytes);
  if (path === 'settings/model-v1.json') {
    if (!record(value) || !onlyKeys(value, ['schemaVersion', 'settings', 'encryptedApiKey'])
      || value.schemaVersion !== 1 || !validateModelSettings(value.settings)
      || (Object.hasOwn(value, 'encryptedApiKey') && (!validBase64(value.encryptedApiKey)
        || value.encryptedApiKey.length === 0 || value.encryptedApiKey.length > 4096))) {
      throw new DesktopServiceError('INVALID_BACKUP');
    }
    return;
  }
  if (scopeForPath(path) === 'tasks') {
    const valid = path.startsWith('tasks/') ? validators.validateTaskData?.(path, value)
      : validators.validateChangeData?.(path, value);
    if (!valid) {
      throw new DesktopServiceError('INVALID_BACKUP');
    }
    return;
  }
  if (path === 'skills/settings-v1.json') {
    if (!record(value) || !onlyKeys(value, ['enabled']) || !record(value.enabled)
      || Object.keys(value.enabled).length > 1024
      || Object.entries(value.enabled).some(([id, enabled]) => !/^[A-Za-z0-9_-]{1,128}$/u.test(id) || typeof enabled !== 'boolean')) {
      throw new DesktopServiceError('INVALID_BACKUP');
    }
    return;
  }
  if (path === 'knowledge/memories-v1.json') {
    const ids = new Set<string>();
    if (!Array.isArray(value) || value.length > 10000 || value.some((item) => {
      if (!record(item) || !onlyKeys(item, ['id', 'scope', 'content', 'projectKey', 'sourcePath',
        'sourceStartLine', 'sourceEndLine', 'sourceSha256', 'createdAt', 'updatedAt'])
        || typeof item.id !== 'string' || item.id.length > 128 || ids.has(item.id)
        || !['user', 'project'].includes(item.scope as string)
        || typeof item.content !== 'string' || item.content.length > 4000
        || typeof item.createdAt !== 'string' || !Number.isFinite(Date.parse(item.createdAt))
        || typeof item.updatedAt !== 'string' || !Number.isFinite(Date.parse(item.updatedAt))
        || (item.projectKey !== undefined && (typeof item.projectKey !== 'string' || !/^[a-f0-9]{32}$/u.test(item.projectKey)))
        || (item.scope === 'project' && item.projectKey === undefined)
        || (item.sourcePath !== undefined && (typeof item.sourcePath !== 'string' || item.sourcePath.length > 4096))
        || (item.sourceSha256 !== undefined && (typeof item.sourceSha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(item.sourceSha256)))
        || [item.sourceStartLine, item.sourceEndLine].some((line) => line !== undefined && (!Number.isSafeInteger(line) || (line as number) < 1))) return true;
      ids.add(item.id);
      return false;
    })) throw new DesktopServiceError('INVALID_BACKUP');
  }
}

export function decodeArchive(bytes: Buffer, validators: ArchiveValidators = {}): DesktopArchive {
  try {
    if (bytes.length > MAX_BACKUP_BYTES) throw new DesktopServiceError('BACKUP_TOO_LARGE');
    const value = parseJson(bytes);
    if (!record(value) || !onlyKeys(value, ['format', 'schemaVersion', 'dataSchemaVersion', 'version',
      'createdAt', 'platform', 'credentialPortability', 'scopes', 'files'])
      || value.format !== DESKTOP_BACKUP_FORMAT || value.schemaVersion !== 1 || value.dataSchemaVersion !== 1
      || typeof value.version !== 'string' || !/^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][A-Za-z0-9.-]+)?$/u.test(value.version)
      || typeof value.createdAt !== 'string' || !Number.isFinite(Date.parse(value.createdAt))
      || !['win32', 'darwin', 'linux'].includes(value.platform as string)
      || value.credentialPortability !== 'same-machine-account'
      || !validateDesktopBackupRequest({ scopes: value.scopes })
      || !Array.isArray(value.files) || value.files.length > MAX_BACKUP_FILES) {
      throw new DesktopServiceError('INVALID_BACKUP');
    }
    const scopes = value.scopes as DesktopDataScope[];
    const paths = new Set<string>();
    let total = 0;
    for (const file of value.files) {
      if (!record(file) || !onlyKeys(file, ['path', 'bytes', 'sha256', 'content'])
        || typeof file.path !== 'string' || !scopeForPath(file.path)
        || !scopes.includes(scopeForPath(file.path) as DesktopDataScope) || paths.has(file.path.toLowerCase())
        || !Number.isSafeInteger(file.bytes) || (file.bytes as number) < 0
        || (file.bytes as number) > fileLimit(file.path)
        || typeof file.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(file.sha256)
        || !validBase64(file.content)) throw new DesktopServiceError('INVALID_BACKUP');
      const content = Buffer.from(file.content, 'base64');
      total += content.length;
      if (total > MAX_DATA_BYTES) throw new DesktopServiceError('BACKUP_TOO_LARGE');
      if (content.length !== file.bytes || digest(content) !== file.sha256) throw new DesktopServiceError('INVALID_BACKUP');
      validateFileContent(file.path, content, validators);
      paths.add(file.path.toLowerCase());
    }
    return value as unknown as DesktopArchive;
  } catch (error) {
    if (error instanceof DesktopServiceError) throw error;
    throw new DesktopServiceError('INVALID_BACKUP');
  }
}

export const ALL_DATA_SCOPES = [...DESKTOP_DATA_SCOPES];
