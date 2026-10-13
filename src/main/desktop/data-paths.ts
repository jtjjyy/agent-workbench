import { lstatSync, realpathSync } from 'node:fs';
import { isAbsolute, join, parse, relative, resolve } from 'node:path';
import { DesktopServiceError } from './safe-files';

// 仅用于主进程确定的系统目录；不接受渲染进程或备份包指定的目录。
export function canonicalDesktopRoot(path: string): string {
  return canonicalSystemPath(path, false);
}

// 旧版白名单文件可能分别被系统重定向，不能只解析它们的共同父目录。
export function canonicalLegacySystemPath(path: string): string {
  return canonicalSystemPath(path, true);
}

function canonicalSystemPath(path: string, allowFile: boolean): string {
  if (!isAbsolute(path)) throw new DesktopServiceError('UNSAFE_PATH');
  const absolute = resolve(path);
  let current = parse(absolute).root;
  const parts = relative(current, absolute).split(/[\\/]/u).filter(Boolean);
  for (const [index, part] of parts.entries()) {
    current = join(current, part);
    const stat = lstatSync(current);
    const regularFile = allowFile && index === parts.length - 1 && stat.isFile() && stat.nlink === 1;
    if (stat.isSymbolicLink() || (!stat.isDirectory() && !regularFile)) throw new DesktopServiceError('UNSAFE_PATH');
  }
  return realpathSync.native(absolute);
}

// appData is supplied by the main process; renderer input must never select these roots.
export function resolveDesktopDataDir(appData: string): string {
  if (!isAbsolute(appData)) throw new Error('桌面数据根目录必须为绝对路径');
  return join(resolve(appData), 'agent-workbench', 'data-v1');
}

export function resolveDesktopRuntimeDir(appData: string): string {
  if (!isAbsolute(appData)) throw new Error('桌面运行目录必须为绝对路径');
  return join(resolve(appData), 'agent-workbench', 'runtime');
}

export function legacyDesktopDataDirs(appData: string, previousUserData?: string): string[] {
  return [...new Set([previousUserData, join(appData, 'Agent Workbench'), join(appData, 'agent-workbench')]
    .filter((path): path is string => Boolean(path) && isAbsolute(path as string)).map((path) => resolve(path)))];
}
