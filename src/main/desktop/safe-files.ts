import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath, rename, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, join, parse, relative, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { TextDecoder } from 'node:util';
import { DESKTOP_ERROR_MESSAGES, type DesktopErrorCode } from '../../shared/desktop';

export class DesktopServiceError extends Error {
  constructor(readonly code: DesktopErrorCode) {
    super(DESKTOP_ERROR_MESSAGES[code]);
    this.name = 'DesktopServiceError';
  }
}

export function safeDesktopError(error: unknown, fallback: DesktopErrorCode): DesktopErrorCode {
  return error instanceof DesktopServiceError ? error.code : fallback;
}

export function isMissing(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT');
}

export function isWithin(root: string, target: string): boolean {
  const path = relative(resolve(root), resolve(target));
  return path === '' || (!isAbsolute(path) && path !== '..' && !path.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`));
}

export async function assertSafePath(path: string, allowMissing = false): Promise<void> {
  const absolute = resolve(path);
  let current = parse(absolute).root;
  const parts = relative(current, absolute).split(/[\\/]/u).filter(Boolean);
  for (const [index, part] of parts.entries()) {
    current = join(current, part);
    try {
      const stat = await lstat(current);
      if (stat.isSymbolicLink() || (index < parts.length - 1 && !stat.isDirectory())
        || (!stat.isDirectory() && !stat.isFile()) || (stat.isFile() && stat.nlink !== 1)) {
        throw new DesktopServiceError('UNSAFE_PATH');
      }
      const actual = await realpath(current);
      const expected = resolve(current);
      if ((process.platform === 'win32' ? actual.toLowerCase() !== expected.toLowerCase() : actual !== expected)) {
        throw new DesktopServiceError('UNSAFE_PATH');
      }
    } catch (error) {
      if (allowMissing && isMissing(error)) return;
      throw error;
    }
  }
}

export async function readBounded(path: string, maxBytes: number): Promise<Buffer> {
  await assertSafePath(path);
  const before = await lstat(path);
  if (!before.isFile()) throw new DesktopServiceError('UNSAFE_PATH');
  if (before.size > maxBytes) throw new DesktopServiceError('BACKUP_TOO_LARGE');
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.dev !== before.dev || stat.ino !== before.ino) {
      throw new DesktopServiceError('UNSAFE_PATH');
    }
    if (stat.size > maxBytes) throw new DesktopServiceError('BACKUP_TOO_LARGE');
    // Read at most limit + 1 bytes even if another process grows the file while it is open.
    const bytes = Buffer.alloc(Math.min(stat.size + 1, maxBytes + 1));
    let length = 0;
    while (length < bytes.length) {
      const { bytesRead } = await handle.read(bytes, length, bytes.length - length, length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    const after = await handle.stat();
    if (length > maxBytes || after.size > maxBytes) throw new DesktopServiceError('BACKUP_TOO_LARGE');
    if (stat.size !== after.size || stat.mtimeMs !== after.mtimeMs || length !== stat.size) {
      throw new DesktopServiceError('DATA_READ_FAILED');
    }
    await assertSafePath(path);
    return bytes.subarray(0, length);
  } finally { await handle.close(); }
}

export function parseJson(bytes: Buffer): unknown {
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw new DesktopServiceError('INVALID_BACKUP'); }
}

export async function writePrivate(path: string, bytes: Buffer, replace = false): Promise<void> {
  await assertSafePath(path, true);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await assertSafePath(dirname(path));
  if (!replace) {
    const handle = await open(path, 'wx', 0o600);
    try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
    return;
  }
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writePrivate(temporary, bytes);
    await assertSafePath(path, true);
    await rename(temporary, path);
  } finally {
    try { await unlink(temporary); } catch { /* A failed cleanup must not disclose native errors. */ }
  }
}
