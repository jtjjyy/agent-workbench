import type { BigIntStats } from 'node:fs';
import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { EMPTY_WORKSPACE, type WorkspaceState } from '../../shared/workspace';

type RootFingerprint = { dev: bigint; ino: bigint };
const selectedRoots = new Map<string, RootFingerprint>();
const rootKey = (root: string) => process.platform === 'win32' ? root.toLowerCase() : root;

export function assertSelectedRootFingerprint(root: string, stat: BigIntStats): void {
  const selected = selectedRoots.get(rootKey(root));
  if (!selected || selected.dev !== stat.dev || selected.ino !== stat.ino) {
    throw new WorkspacePolicyError('工作区授权记录不存在或目录已被替换，请重新选择目录。');
  }
}

export class WorkspacePolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkspacePolicyError';
  }
}

export function sameCanonicalPath(left: string, right: string): boolean {
  const a = path.normalize(left);
  const b = path.normalize(right);
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

export function isInvalidPathSegment(segment: string): boolean {
  return !segment || segment === '.' || segment === '..'
    || /[\u0000-\u001f\u007f-\u009f<>:"|?*\u2028\u2029\u202a-\u202e\u2066-\u2069]/u.test(segment)
    || /[. ]$/u.test(segment)
    || /^(?:con|prn|aux|nul|clock\$|conin\$|conout\$|com[1-9\u00b9\u00b2\u00b3]|lpt[1-9\u00b9\u00b2\u00b3])(?:\.|$)/iu.test(segment);
}

// 同时供选择目录和工具执行使用；检查不是文件系统沙箱，也不能消除路径竞态。
export async function canonicalWorkspaceRoot(root: string, signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted();
  try {
    if (typeof root !== 'string' || !root || root.length > 4096
      || !path.isAbsolute(root) || root.startsWith('\\\\') || root.startsWith('//')
      || (process.platform === 'win32' && !/^[a-z]:[\\/]/iu.test(root))) {
      throw new WorkspacePolicyError('请选择本机磁盘上的普通目录，不接受网络或设备路径。');
    }
    const driveRoot = path.parse(root).root;
    const segments = root.slice(driveRoot.length).split(/[\\/]/u).filter(Boolean);
    if (!segments.length || segments.some(isInvalidPathSegment)) {
      throw new WorkspacePolicyError('不允许选择磁盘根目录或包含不安全名称的目录。');
    }
    const resolved = path.resolve(root);
    let current = driveRoot;
    for (const segment of ['', ...segments]) {
      signal?.throwIfAborted();
      if (segment) current = path.join(current, segment);
      const stat = await lstat(current);
      signal?.throwIfAborted();
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw new WorkspacePolicyError('工作区及其父目录必须是普通目录，不接受符号链接或目录联接。');
      }
      const canonical = await realpath(current);
      signal?.throwIfAborted();
      if (!sameCanonicalPath(canonical, current)) {
        throw new WorkspacePolicyError('目录的实际路径发生重定向，不能授权。');
      }
    }
    const canonical = await realpath(resolved);
    signal?.throwIfAborted();
    if (!sameCanonicalPath(canonical, resolved)) {
      throw new WorkspacePolicyError('目录的实际路径发生重定向，不能授权。');
    }
    return canonical;
  } catch (error) {
    signal?.throwIfAborted();
    if (error instanceof WorkspacePolicyError) throw error;
    throw new WorkspacePolicyError('工作区目录不可用，请重新选择可访问的本机普通目录。');
  }
}

export class WorkspaceSession {
  private state: WorkspaceState = { ...EMPTY_WORKSPACE };
  private selectionVersion = 0;
  private fingerprint: RootFingerprint | undefined;

  private releaseSelection(): void {
    if (this.state.root && selectedRoots.get(rootKey(this.state.root)) === this.fingerprint) {
      selectedRoots.delete(rootKey(this.state.root));
    }
    this.fingerprint = undefined;
    this.state = { ...EMPTY_WORKSPACE };
  }

  // root 只能来自主进程原生 dialog；这里不创建任何接受任意路径的 IPC。
  async select(root: string): Promise<WorkspaceState> {
    const version = ++this.selectionVersion;
    this.releaseSelection();
    const canonical = await canonicalWorkspaceRoot(root);
    const stat = await lstat(canonical, { bigint: true }).catch(() => {
      throw new WorkspacePolicyError('工作区目录不可用，请重新选择目录。');
    });
    await canonicalWorkspaceRoot(canonical);
    const finalStat = await lstat(canonical, { bigint: true }).catch(() => {
      throw new WorkspacePolicyError('工作区目录不可用，请重新选择目录。');
    });
    if (stat.dev !== finalStat.dev || stat.ino !== finalStat.ino
      || finalStat.isSymbolicLink() || !finalStat.isDirectory()) {
      throw new WorkspacePolicyError('工作区目录在选择时发生变化，请重新选择目录。');
    }
    if (version !== this.selectionVersion) {
      throw new WorkspacePolicyError('目录选择已被后续操作替代，请使用当前工作区。');
    }
    this.fingerprint = { dev: finalStat.dev, ino: finalStat.ino };
    selectedRoots.set(rootKey(canonical), this.fingerprint);
    this.state = { root: canonical, name: path.basename(canonical), dataEgressConsent: false };
    return this.snapshot();
  }

  read(): WorkspaceState {
    return this.snapshot();
  }

  setConsent(consent: boolean): WorkspaceState {
    if (typeof consent !== 'boolean') {
      throw new WorkspacePolicyError('外发同意必须是明确的布尔值。');
    }
    if (consent && !this.state.root) {
      throw new WorkspacePolicyError('请先选择工作区，再确认仓库内容外发同意。');
    }
    this.state = { ...this.state, dataEgressConsent: consent };
    return this.snapshot();
  }

  clear(): WorkspaceState {
    ++this.selectionVersion;
    this.releaseSelection();
    return this.snapshot();
  }

  snapshot(): WorkspaceState {
    return { ...this.state };
  }
}
