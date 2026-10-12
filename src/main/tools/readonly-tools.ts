import { createHash } from 'node:crypto';
import { constants, type BigIntStats } from 'node:fs';
import { lstat, open, opendir, realpath, type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { TextDecoder } from 'node:util';
import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core';
import { Type } from 'typebox';
import type { ReadonlyToolName, SourceEvidence, WorkspaceState } from '../../shared/workspace';
import {
  assertSelectedRootFingerprint, canonicalWorkspaceRoot, isInvalidPathSegment,
  sameCanonicalPath, WorkspacePolicyError,
} from '../workspace/workspace-session';

const LIMITS = {
  entries: 1000, textFiles: 100, depth: 8, fileBytes: 256 * 1024,
  output: 4000, readLines: 120, matches: 12, excerpt: 240, path: 512, query: 200,
} as const;

const BLOCKED_DIRECTORIES = new Set([
  '.git', '.hg', '.svn', 'node_modules', 'dist', 'build', 'logs', 'log', 'coverage',
  '.cache', '.next', '.nuxt', '.output', '.turbo', '.parcel-cache', '.pnpm-store',
  '.yarn', 'out', 'target', 'vendor', 'tmp', 'temp', '__pycache__', '.venv', 'venv',
  '.ssh', '.aws', '.azure', '.gcloud', '.gnupg', '.kube', '.docker',
  'secrets', 'credentials', 'certificates', 'certs', 'keys',
]);
const BLOCKED_FILES = new Set([
  '.npmrc', '.pypirc', '.netrc', '_netrc', '.git-credentials', '.dockercfg',
  'known_hosts', 'authorized_keys', 'shadow', 'passwd',
]);
const TEXT_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts', '.json',
  '.md', '.mdx', '.txt', '.rst', '.adoc', '.yaml', '.yml', '.toml', '.xml',
  '.html', '.htm', '.css', '.scss', '.sass', '.less', '.vue', '.svelte',
  '.py', '.pyi', '.rs', '.go', '.java', '.kt', '.kts', '.c', '.h', '.cc',
  '.cpp', '.cxx', '.hpp', '.hxx', '.cs', '.swift', '.rb', '.php', '.lua',
  '.sql', '.graphql', '.gql', '.proto', '.ino', '.pde', '.sh', '.bash', '.zsh',
  '.ps1', '.bat', '.cmd', '.r', '.dart', '.ex', '.exs', '.erl', '.hrl',
  '.clj', '.cljs', '.edn', '.tex', '.bib', '.cmake',
]);

type ToolDetails = { summary: string; sources: SourceEvidence[] };
type ToolResult = AgentToolResult<ToolDetails>;
type Parameters = { path?: string; startLine?: number; endLine?: number; query?: string };
export type CheckedPath = {
  absolute: string;
  relative: string;
  stat: BigIntStats;
  parents: { absolute: string; stat: BigIntStats }[];
};
type TextFile = { relative: string; text: string; sha256: string };
export type WorkspaceFileContext = {
  root: string;
  rootStat: BigIntStats;
  signal?: AbortSignal;
};
export type TextReadOptions = {
  maxBytes?: number;
  maxTextLength?: number;
  rejectHardLinks?: boolean;
  preserveBom?: boolean;
};
export type BoundedTextFile = CheckedPath & TextFile & { bytes: Buffer };
type ExecutionContext = WorkspaceFileContext & {
  entries: number;
  textFiles: number;
  skipped: number;
  notes: Set<string>;
  stopped: boolean;
};

const pathSchema = () => Type.String({ minLength: 1, maxLength: LIMITS.path,
  description: '工作区内相对路径；目录工具可使用点号表示工作区。' });
const listSchema = Type.Object({ path: Type.Optional(pathSchema()) }, { additionalProperties: false });
const readSchema = Type.Object({
  path: pathSchema(),
  startLine: Type.Optional(Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER })),
  endLine: Type.Optional(Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER })),
}, { additionalProperties: false });
const searchSchema = Type.Object({
  query: Type.String({ minLength: 1, maxLength: LIMITS.query,
    description: '区分大小写的单行字面文本，不作为正则表达式。' }),
  path: Type.Optional(pathSchema()),
}, { additionalProperties: false });

function blockedName(name: string): boolean {
  const lower = name.toLowerCase();
  return BLOCKED_DIRECTORIES.has(lower) || BLOCKED_FILES.has(lower) || lower.startsWith('.env')
    || /(?:secret|credential|password|passwd|api[-_.]?key|private[-_.]?key|access[-_.]?key|service[-_.]?account|certificate|keystore)/iu.test(name)
    || /(?:^|[-_.])(?:token|cert)(?:$|[-_.])/iu.test(name)
    || /^id_(?:rsa|dsa|ecdsa|ed25519)(?:$|[._-])/iu.test(name)
    || /\.(?:pem|key|p12|pfx|crt|cer|der|jks|keystore|csr|pub|kdb|srl)$/iu.test(name);
}

function relativeSegments(value: string, allowRoot: boolean): string[] {
  if (allowRoot && value === '.') return [];
  if (!value || value.length > LIMITS.path) {
    throw new WorkspacePolicyError('相对路径不能为空，且最多五百一十二个 UTF-16 单元。');
  }
  if (path.posix.isAbsolute(value)
    || path.win32.isAbsolute(value) || value.includes(':')) {
    throw new WorkspacePolicyError('只接受工作区内的相对路径，不接受绝对路径、设备路径或数据流。');
  }
  const segments = value.split(/[\\/]/u);
  if (segments.some(isInvalidPathSegment)) {
    throw new WorkspacePolicyError('路径包含不安全名称、空片段或目录穿越，已拒绝访问。');
  }
  if (segments.length > LIMITS.depth) {
    throw new WorkspacePolicyError('只读工具最多访问工作区内的八层相对路径。');
  }
  if (segments.some(blockedName)) {
    throw new WorkspacePolicyError('该路径属于敏感或排除范围，不能通过只读工具访问。');
  }
  return segments;
}

// 不依赖模型或 Pi 的参数转换；执行器自身拒绝额外字段、类型强制转换和访问器。
function strictParameters(name: ReadonlyToolName, input: unknown): Parameters {
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) {
    throw new WorkspacePolicyError('工具参数必须是普通对象。');
  }
  const allowed = name === 'read_file' ? ['path', 'startLine', 'endLine']
    : name === 'search_text' ? ['query', 'path'] : ['path'];
  const keys = Reflect.ownKeys(input);
  if (keys.some((key) => typeof key !== 'string' || !allowed.includes(key))) {
    throw new WorkspacePolicyError('工具参数包含未允许的字段。');
  }
  const descriptors = Object.getOwnPropertyDescriptors(input);
  if (Object.values(descriptors).some((descriptor) => !('value' in descriptor) || !descriptor.enumerable)) {
    throw new WorkspacePolicyError('工具参数必须是可枚举的普通数据字段。');
  }
  const has = (key: string) => Object.prototype.hasOwnProperty.call(input, key);
  const params = input as Parameters;
  if ((name === 'read_file' && !has('path'))
    || (has('path') && (typeof params.path !== 'string' || !params.path || params.path.length > LIMITS.path))) {
    throw new WorkspacePolicyError('请提供有效的工作区相对路径。');
  }
  if (has('path')) relativeSegments(params.path!, name !== 'read_file');
  if (name === 'search_text' && (!has('query') || typeof params.query !== 'string'
    || !params.query.trim() || params.query.length > LIMITS.query
    || /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(params.query))) {
    throw new WorkspacePolicyError('搜索文本必须是非空单行字面文本，最多二百个 UTF-16 单元。');
  }
  for (const key of ['startLine', 'endLine'] as const) {
    if (has(key) && (!Number.isSafeInteger(params[key]) || params[key]! < 1)) {
      throw new WorkspacePolicyError('行号必须是从一开始的安全整数。');
    }
  }
  if (params.endLine !== undefined && params.endLine < (params.startLine ?? 1)) {
    throw new WorkspacePolicyError('结束行不能早于起始行。');
  }
  return { ...params };
}

function contained(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`);
}

export function sameIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

export function sameFileSnapshot(left: BigIntStats, right: BigIntStats): boolean {
  return sameIdentity(left, right) && left.size === right.size
    && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

export function samePathIdentity(left: CheckedPath, right: CheckedPath): boolean {
  return sameCanonicalPath(left.absolute, right.absolute) && sameIdentity(left.stat, right.stat)
    && left.parents.length === right.parents.length
    && left.parents.every((parent, index) => sameCanonicalPath(parent.absolute, right.parents[index].absolute)
      && sameIdentity(parent.stat, right.parents[index].stat));
}

export async function createWorkspaceFileContext(workspace: WorkspaceState, signal?: AbortSignal): Promise<WorkspaceFileContext> {
  signal?.throwIfAborted();
  if (!workspace.root || workspace.dataEgressConsent !== true) {
    throw new WorkspacePolicyError('请先选择工作区并明确同意仓库内容外发。');
  }
  const root = await canonicalWorkspaceRoot(workspace.root, signal);
  if (!sameCanonicalPath(root, workspace.root)
    || root.slice(path.parse(root).root.length).split(/[\\/]/u).some(blockedName)) {
    throw new WorkspacePolicyError('工作区实际路径已变化或属于排除范围，请重新选择普通项目目录。');
  }
  const rootStat = await lstat(root, { bigint: true });
  signal?.throwIfAborted();
  assertSelectedRootFingerprint(root, rootStat);
  return { root, rootStat, signal };
}

export async function checkedPath(context: WorkspaceFileContext, relative: string): Promise<CheckedPath> {
  const { root, signal } = context;
  signal?.throwIfAborted();
  const canonicalRoot = await canonicalWorkspaceRoot(root, signal);
  if (!sameCanonicalPath(canonicalRoot, root)) {
    throw new WorkspacePolicyError('工作区实际路径已变化，请重新选择目录。');
  }
  const rootStat = await lstat(root, { bigint: true });
  signal?.throwIfAborted();
  assertSelectedRootFingerprint(root, rootStat);
  if (!sameIdentity(context.rootStat, rootStat)) {
    throw new WorkspacePolicyError('工作区目录已被替换，请重新选择目录。');
  }
  const segments = relativeSegments(relative, true);
  let absolute = root;
  let stat = rootStat;
  const parents: CheckedPath['parents'] = [];
  for (const segment of segments) {
    signal?.throwIfAborted();
    if (!stat.isDirectory()) throw new WorkspacePolicyError('路径的父级不是普通目录。');
    parents.push({ absolute, stat });
    absolute = path.join(absolute, segment);
    if (!contained(root, absolute)) throw new WorkspacePolicyError('目标路径超出工作区，已拒绝访问。');
    stat = await lstat(absolute, { bigint: true });
    signal?.throwIfAborted();
    if (stat.isSymbolicLink()) throw new WorkspacePolicyError('不允许访问符号链接或目录联接。');
    const canonical = await realpath(absolute);
    signal?.throwIfAborted();
    if (!contained(root, canonical) || !sameCanonicalPath(canonical, absolute)) {
      throw new WorkspacePolicyError('目标实际路径越界或发生重定向，已拒绝访问。');
    }
  }
  return { absolute, relative: segments.join('/') || '.', stat, parents };
}

function clip(text: string, limit: number): string {
  let end = Math.min(text.length, limit);
  if (end > 0 && end < text.length && /[\ud800-\udbff]/u.test(text[end - 1])) --end;
  return text.slice(0, end);
}

function hideRoot(text: string, root: string): string {
  const variants = new Set([root, root.replaceAll('\\', '/'), root.replaceAll('/', '\\')]);
  let safe = text;
  for (const variant of variants) {
    const needle = process.platform === 'win32' ? variant.toLowerCase() : variant;
    const haystack = process.platform === 'win32' ? safe.toLowerCase() : safe;
    let offset = 0;
    let result = '';
    while (offset < safe.length) {
      const index = haystack.indexOf(needle, offset);
      if (index === -1) break;
      result += safe.slice(offset, index) + '[工作区路径已隐藏]';
      offset = index + variant.length;
    }
    safe = result + safe.slice(offset);
  }
  return safe;
}

export function assertBoundedTextTarget(target: CheckedPath, options: TextReadOptions = {}): void {
  const maxBytes = options.maxBytes ?? LIMITS.fileBytes;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > LIMITS.fileBytes
    || (options.maxTextLength !== undefined && (!Number.isSafeInteger(options.maxTextLength)
      || options.maxTextLength < 0))) {
    throw new WorkspacePolicyError('文本读取上限不符合有界读取策略。');
  }
  if (!target.stat.isFile() || !TEXT_EXTENSIONS.has(path.extname(target.relative).toLowerCase())) {
    throw new WorkspacePolicyError('只允许访问白名单扩展名的普通代码或文档文件。');
  }
  if (target.stat.size > BigInt(maxBytes)) {
    throw new WorkspacePolicyError('文件超过本次有界文本读取的字节上限。');
  }
  if (options.rejectHardLinks && target.stat.nlink !== 1n) {
    throw new WorkspacePolicyError('文件存在硬链接或链接数不明确，已拒绝修改。');
  }
}

export function decodeUtf8Text(bytes: Buffer, signal?: AbortSignal, preserveBom = false): string {
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: preserveBom }).decode(bytes); }
  catch { throw new WorkspacePolicyError('文件不是有效的 UTF-8 文本，已拒绝访问。'); }
  for (let index = 0; index < text.length; ++index) {
    if (index % 4096 === 0) signal?.throwIfAborted();
    const code = text.charCodeAt(index);
    if ((code < 32 && code !== 9 && code !== 10 && code !== 13) || code === 127) {
      throw new WorkspacePolicyError('文件包含二进制或不允许的控制字符，已拒绝访问。');
    }
  }
  signal?.throwIfAborted();
  return text;
}

// 传入描述符时不关闭它；只读工具和写入器使用同一套路径、UTF-8 与快照策略。
export async function readBoundedTextFile(context: WorkspaceFileContext, relative: string,
  options: TextReadOptions = {}, existingHandle?: FileHandle): Promise<BoundedTextFile> {
  const target = await checkedPath(context, relative);
  assertBoundedTextTarget(target, options);
  context.signal?.throwIfAborted();
  const flags = constants.O_RDONLY | (process.platform === 'win32' ? 0
    : (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  const handle = existingHandle ?? await open(target.absolute, flags);
  try {
    context.signal?.throwIfAborted();
    const before = await handle.stat({ bigint: true });
    context.signal?.throwIfAborted();
    assertBoundedTextTarget({ ...target, stat: before }, options);
    if (!sameFileSnapshot(target.stat, before)) {
      throw new WorkspacePolicyError('文件不是稳定的有界普通文件，不能读取。');
    }
    const openedPath = await checkedPath(context, target.relative);
    if (!sameFileSnapshot(before, openedPath.stat) || !samePathIdentity(target, openedPath)) {
      throw new WorkspacePolicyError('文件在打开时发生变化，不能读取。');
    }
    const bytes = Buffer.alloc(Number(before.size));
    let offset = 0;
    while (offset < bytes.length) {
      context.signal?.throwIfAborted();
      const chunk = await handle.read(bytes, offset, Math.min(16 * 1024, bytes.length - offset), offset);
      context.signal?.throwIfAborted();
      if (!chunk.bytesRead) throw new WorkspacePolicyError('文件在读取时发生变化，不能生成来源快照。');
      offset += chunk.bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    context.signal?.throwIfAborted();
    const finalPath = await checkedPath(context, target.relative);
    assertBoundedTextTarget({ ...target, stat: after }, options);
    assertBoundedTextTarget(finalPath, options);
    if (!sameFileSnapshot(before, after) || !sameFileSnapshot(after, finalPath.stat)
      || !samePathIdentity(target, finalPath)) {
      throw new WorkspacePolicyError('文件在读取时发生变化，不能生成来源快照。');
    }
    const text = decodeUtf8Text(bytes, context.signal, options.preserveBom);
    if (options.maxTextLength !== undefined && text.length > options.maxTextLength) {
      throw new WorkspacePolicyError('文件超过本次完整正文的 UTF-16 长度上限。');
    }
    context.signal?.throwIfAborted();
    return { ...finalPath, text, bytes, sha256: createHash('sha256').update(bytes).digest('hex') };
  } finally {
    if (!existingHandle) await handle.close().catch(() => {});
  }
}

async function readTextFile(context: ExecutionContext, relative: string): Promise<TextFile> {
  return readBoundedTextFile(context, relative);
}

async function* walkFiles(context: ExecutionContext, relative: string, maxTextFiles = LIMITS.textFiles): AsyncGenerator<CheckedPath> {
  context.signal?.throwIfAborted();
  const target = await checkedPath(context, relative);
  if (!target.stat.isDirectory()) throw new WorkspacePolicyError('文件列表和目录遍历要求普通目录。');
  if (relativeSegments(relative, true).length >= LIMITS.depth) {
    context.notes.add('已达到八层深度上限，未扫描更深内容。');
    return;
  }
  const directory = await opendir(target.absolute, { bufferSize: 1 });
  try {
    context.signal?.throwIfAborted();
    const openedPath = await checkedPath(context, relative);
    if (!sameIdentity(target.stat, openedPath.stat)) {
      throw new WorkspacePolicyError('目录在打开时发生变化，已停止遍历。');
    }
    while (!context.stopped) {
      context.signal?.throwIfAborted();
      if (context.entries >= LIMITS.entries || context.textFiles >= maxTextFiles) {
        context.notes.add(context.entries >= LIMITS.entries
          ? '已达到一千个目录项上限，扫描已截断。' : '已达到一百个候选文本文件上限，扫描已截断。');
        context.stopped = true;
        break;
      }
      const entry = await directory.read();
      context.signal?.throwIfAborted();
      if (!entry) break;
      ++context.entries;
      if (isInvalidPathSegment(entry.name) || blockedName(entry.name) || entry.isSymbolicLink()) {
        ++context.skipped;
        continue;
      }
      const child = target.relative === '.' ? entry.name : `${target.relative}/${entry.name}`;
      try {
        const checked = await checkedPath(context, child);
        if (checked.stat.isDirectory()) {
          yield* walkFiles(context, checked.relative, maxTextFiles);
        } else if (checked.stat.isFile() && TEXT_EXTENSIONS.has(path.extname(child).toLowerCase())) {
          ++context.textFiles;
          if (checked.stat.size > BigInt(LIMITS.fileBytes)) ++context.skipped;
          else yield checked;
        } else {
          ++context.skipped;
        }
      } catch {
        context.signal?.throwIfAborted();
        ++context.skipped;
      }
    }
  } finally {
    await directory.close().catch(() => {});
  }
}

export async function scanWorkspaceTextFiles(workspace: WorkspaceState, signal?: AbortSignal,
  maxFiles = 200): Promise<BoundedTextFile[]> {
  const context = await createWorkspaceFileContext(workspace, signal);
  const execution: ExecutionContext = { ...context, entries: 0, textFiles: 0, skipped: 0,
    notes: new Set(), stopped: false };
  const files: BoundedTextFile[] = [];
  for await (const file of walkFiles(execution, '.', maxFiles)) {
    signal?.throwIfAborted();
    try { files.push(await readBoundedTextFile(context, file.relative)); }
    catch (error) {
      if (error instanceof WorkspacePolicyError) continue;
      throw error;
    }
    if (files.length >= maxFiles) break;
  }
  return files;
}

function* textLines(text: string, signal?: AbortSignal): Generator<{ number: number; text: string }> {
  let start = 0;
  let number = 1;
  for (let index = 0; index < text.length; ++index) {
    if (index % 4096 === 0) signal?.throwIfAborted();
    if (text[index] !== '\n' && text[index] !== '\r') continue;
    yield { number: number++, text: text.slice(start, index) };
    if (text[index] === '\r' && text[index + 1] === '\n') ++index;
    start = index + 1;
  }
  signal?.throwIfAborted();
  if (start < text.length) yield { number, text: text.slice(start) };
}

function toolResult(summary: string, blocks: string[], sources: SourceEvidence[], isError = false): ToolResult {
  if (sources.length > LIMITS.matches || sources.some((source) => !source.path.trim()
    || source.path.length > LIMITS.path || source.path.startsWith('/')
    || source.path.includes('\\') || source.path.includes(':')
    || source.path.split('/').some(isInvalidPathSegment)
    || !Number.isSafeInteger(source.startLine) || source.startLine < 1
    || !Number.isSafeInteger(source.endLine) || source.endLine < source.startLine
    || !/^[a-f0-9]{64}$/u.test(source.sha256) || source.excerpt.length > LIMITS.excerpt)) {
    throw new WorkspacePolicyError('来源证据不符合安全记录格式，未返回文件内容。');
  }
  const evidence = sources.map((source) => `来源：${JSON.stringify(source.path)}；行：${source.startLine}-${source.endLine}`
    + `；SHA-256：${source.sha256}\n摘录：${JSON.stringify(source.excerpt)}`);
  return { content: [{ type: 'text', text: [summary, ...blocks, ...evidence].join('\n') }],
    details: { summary, sources }, isError };
}

class OutputBuffer {
  blocks: string[] = [];
  sources: SourceEvidence[] = [];

  replace(blocks: string[], sources: SourceEvidence[], signal?: AbortSignal): boolean {
    signal?.throwIfAborted();
    // 预留摘要在 content/details 中各一份；按完整返回对象序列化后的 UTF-16 长度计预算。
    if (sources.length > LIMITS.matches || sources.some((source) => source.excerpt.length > LIMITS.excerpt)
      || JSON.stringify(toolResult(' '.repeat(600), blocks, sources)).length > LIMITS.output) return false;
    this.blocks = blocks;
    this.sources = sources;
    return true;
  }

  finish(summary: string, context: ExecutionContext): ToolResult {
    context.signal?.throwIfAborted();
    const notes = [...context.notes];
    if (context.skipped) notes.push(`已跳过 ${context.skipped} 个排除、不支持或不可读取的项；不展示其名称和原始错误。`);
    const safeSummary = [summary, ...notes].join(' ');
    if (safeSummary.length > 600) throw new WorkspacePolicyError('结果摘要超过安全输出预算，未返回文件内容。');
    const result = toolResult(safeSummary, this.blocks, this.sources);
    if (JSON.stringify(result).length > LIMITS.output) {
      throw new WorkspacePolicyError('工具结果超过安全输出预算，未返回文件内容。');
    }
    context.signal?.throwIfAborted();
    return result;
  }
}

async function listFiles(context: ExecutionContext, params: Parameters): Promise<ToolResult> {
  const output = new OutputBuffer();
  let count = 0;
  for await (const file of walkFiles(context, params.path ?? '.')) {
    context.signal?.throwIfAborted();
    if (!output.replace([...output.blocks, `相对路径：${JSON.stringify(file.relative)}`], [], context.signal)) {
      context.notes.add('已达到四千 UTF-16 单元输出上限，列表已截断。');
      break;
    }
    ++count;
  }
  await checkedPath(context, '.');
  return output.finish(count ? `列出 ${count} 个符合路径、扩展名和大小策略的候选文件；仅检查元数据，不保证正文为文本，也不是完整目录清单。`
    : '在已扫描且允许访问的范围内，没有符合元数据策略的候选文件；不代表工作区没有文件。', context);
}

async function readFile(context: ExecutionContext, params: Parameters): Promise<ToolResult> {
  const file = await readTextFile(context, params.path!);
  const output = new OutputBuffer();
  const start = params.startLine ?? 1;
  const end = Math.min(params.endLine ?? Number.MAX_SAFE_INTEGER,
    Math.min(Number.MAX_SAFE_INTEGER, start + LIMITS.readLines - 1));
  let count = 0;
  let lastLine = start;
  let excerpt = '';
  let excerptEndLine = start;
  for (const line of textLines(file.text, context.signal)) {
    context.signal?.throwIfAborted();
    if (line.number < start) continue;
    if (line.number > end) {
      if (params.endLine === undefined || params.endLine > end) {
        context.notes.add('已达到一百二十行上限，未返回后续请求范围。');
      }
      break;
    }
    const safeLine = hideRoot(line.text, context.root);
    const fragment = clip(safeLine, 1000);
    const nextExcerpt = clip(excerpt + (count ? '\n' : '') + safeLine, LIMITS.excerpt);
    const nextExcerptEnd = !count || nextExcerpt.length > excerpt.length ? line.number : excerptEndLine;
    const source: SourceEvidence = { path: file.relative, startLine: start, endLine: nextExcerptEnd,
      sha256: file.sha256, excerpt: nextExcerpt };
    const block = `行 ${line.number}：${JSON.stringify(fragment)}${fragment.length < safeLine.length ? '（本行已截断）' : ''}`;
    if (!output.replace([...output.blocks, block], [source], context.signal)) {
      context.notes.add('已达到四千 UTF-16 单元输出上限，读取结果已截断。');
      break;
    }
    if (fragment.length < safeLine.length) context.notes.add('存在长行，单行展示已截断至最多一千 UTF-16 单元。');
    if (safeLine !== line.text) context.notes.add('展示中的工作区绝对路径已隐藏，哈希仍对应原始文件字节。');
    if (nextExcerpt.length < (excerpt + (count ? '\n' : '') + safeLine).length) {
      context.notes.add('来源摘录限二百四十 UTF-16 单元；来源行号只覆盖实际摘录，不覆盖全部展示行。');
    }
    excerpt = nextExcerpt;
    excerptEndLine = nextExcerptEnd;
    lastLine = line.number;
    ++count;
  }
  await checkedPath(context, '.');
  const summary = count ? `已展示请求文件的第 ${start}-${lastLine} 行，共 ${count} 行。`
    : context.notes.size ? '读取请求未产生可展示行；请参见截断说明。'
      : file.text ? '请求起始行超出文件范围，没有可返回的行。' : '文件为空，没有可返回的行。';
  return output.finish(summary, context);
}

async function* searchFiles(context: ExecutionContext, relative: string): AsyncGenerator<TextFile> {
  const target = await checkedPath(context, relative);
  if (target.stat.isDirectory()) {
    for await (const file of walkFiles(context, target.relative)) {
      try { yield await readTextFile(context, file.relative); }
      catch {
        context.signal?.throwIfAborted();
        ++context.skipped;
      }
    }
  } else {
    yield await readTextFile(context, target.relative);
  }
}

async function searchText(context: ExecutionContext, params: Parameters): Promise<ToolResult> {
  const output = new OutputBuffer();
  let matches = 0;
  search: for await (const file of searchFiles(context, params.path ?? '.')) {
    for (const line of textLines(file.text, context.signal)) {
      context.signal?.throwIfAborted();
      const index = line.text.indexOf(params.query!);
      if (index === -1) continue;
      const safeLine = hideRoot(line.text, context.root);
      const safeIndex = safeLine.indexOf(params.query!);
      const excerpt = clip(safeLine.slice(Math.max(0, safeIndex - 40)), LIMITS.excerpt);
      const source: SourceEvidence = { path: file.relative, startLine: line.number,
        endLine: line.number, sha256: file.sha256, excerpt };
      if (!output.replace([], [...output.sources, source], context.signal)) {
        context.notes.add('已达到四千 UTF-16 单元输出上限，搜索结果已截断。');
        break search;
      }
      ++matches;
      if (excerpt.length < safeLine.length) context.notes.add('匹配行只展示最多二百四十 UTF-16 单元的局部摘录。');
      if (safeLine !== line.text) context.notes.add('展示中的工作区绝对路径已隐藏，哈希仍对应原始文件字节。');
      if (safeIndex === -1) context.notes.add('匹配文字涉及被隐藏的路径，展示摘录可能不再含有查询原文。');
      if (matches >= LIMITS.matches) {
        context.notes.add('已达到十二个匹配行上限，后续内容未继续检查。');
        break search;
      }
    }
  }
  await checkedPath(context, '.');
  return output.finish(matches ? `找到并展示 ${matches} 个匹配行；同一行多次出现只计一个匹配。`
    : '在已扫描且允许访问的文本范围内没有可展示的字面匹配；不代表未扫描内容也没有匹配。', context);
}

export function createReadonlyTools(workspace: WorkspaceState): AgentTool[] {
  const selected = { ...workspace };
  if (!selected.root || selected.dataEgressConsent !== true) return [];
  const execute = async (name: ReadonlyToolName, input: unknown, signal?: AbortSignal): Promise<ToolResult> => {
    signal?.throwIfAborted();
    try {
      const params = strictParameters(name, input);
      const fileContext = await createWorkspaceFileContext(selected, signal);
      const context: ExecutionContext = { ...fileContext, entries: 0, textFiles: 0,
        skipped: 0, notes: new Set(), stopped: false };
      const result = name === 'list_files' ? await listFiles(context, params)
        : name === 'read_file' ? await readFile(context, params) : await searchText(context, params);
      signal?.throwIfAborted();
      return result;
    } catch (error) {
      signal?.throwIfAborted();
      const summary = error instanceof WorkspacePolicyError ? error.message
        : '只读工具无法安全完成该请求；目标可能不可访问或已经变化，请重新选择工作区后重试。';
      return toolResult(summary, [], [], true);
    }
  };
  return [
    { name: 'list_files', label: '列出文件', parameters: listSchema,
      description: '仅检查元数据，列出授权工作区内符合路径、扩展名和大小策略的候选文件，不读取正文。最多扫描一千项、一百个候选文件、八层路径；不是完整目录清单。',
      executionMode: 'sequential', replay: 'never',
      execute: (_id, params, signal) => execute('list_files', params, signal) },
    { name: 'read_file', label: '读取文件', parameters: readSchema,
      description: '读取授权工作区内的 UTF-8 代码或文档，行号从一开始。文件最多二百五十六 KiB，展示最多一百二十行；返回原始字节 SHA-256 和有界来源摘录。',
      executionMode: 'sequential', replay: 'never',
      execute: (_id, params, signal) => execute('read_file', params, signal) },
    { name: 'search_text', label: '搜索文本', parameters: searchSchema,
      description: '按区分大小写的单行字面文本搜索授权目录或文件，不使用正则或命令。最多十二个匹配行；返回相对路径、行号、原始字节 SHA-256 和摘录。',
      executionMode: 'sequential', replay: 'never',
      execute: (_id, params, signal) => execute('search_text', params, signal) },
  ];
}
