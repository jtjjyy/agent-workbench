// 按用户要求仅编写源码，尚未运行。
import { afterEach, expect, test } from 'vitest';
import { createHash } from 'node:crypto';
import { link, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FileEditHandler, FileEditProposal } from '../../src/shared/file-edit';
import { createFileEditTool } from '../../src/main/tools/file-edit-tool';
import { WorkspaceSession } from '../../src/main/workspace/workspace-session';

const directories: string[] = [];
const sessions: WorkspaceSession[] = [];
afterEach(async () => {
  sessions.splice(0).forEach((session) => session.clear());
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function fixture(text: string | Buffer = '前文\n唯一片段\n后文\n', handler?: FileEditHandler) {
  const root = await mkdtemp(join(tmpdir(), 'awb-edit-'));
  directories.push(root);
  const file = join(root, 'example.ts');
  await writeFile(file, text);
  const session = new WorkspaceSession();
  sessions.push(session);
  await session.select(root);
  const workspace = session.setConsent(true);
  let proposal: FileEditProposal | undefined;
  const tool = createFileEditTool(workspace, async (next, apply, signal) => {
    proposal = next;
    return handler ? handler(next, apply, signal) : apply(signal);
  });
  return { root, file, tool, session, proposal: () => proposal };
}

const params = { path: 'example.ts', oldText: '唯一片段', newText: '已替换' };
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

test('唯一替换保留其他正文，返回结果不含前后全文', async () => {
  const { file, tool, proposal } = await fixture();
  const result = await tool.execute('sdk-id', params);
  expect(await readFile(file, 'utf8')).toBe('前文\n已替换\n后文\n');
  expect(proposal()?.beforeText).toBe('前文\n唯一片段\n后文\n');
  expect(proposal()?.afterText).toBe('前文\n已替换\n后文\n');
  expect(result.details.status).toBe('applied');
  expect(result.details.sources).toEqual([]);
  expect(JSON.stringify(result)).not.toContain('唯一片段');
  expect(JSON.stringify(result)).not.toContain('前文');
});

test('空 newText 删除唯一片段并正确截去旧尾部', async () => {
  const { file, tool } = await fixture('abcXYZdef');
  const result = await tool.execute('id', { ...params, oldText: 'XYZ', newText: '' });
  expect(result.details.status).toBe('applied');
  expect(await readFile(file, 'utf8')).toBe('abcdef');
});

test('保留 UTF-8 BOM，前后 SHA-256 对应含 BOM 的原始字节', async () => {
  const before = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('abcXYZdef')]);
  const after = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('abcQdef')]);
  const { file, tool, proposal } = await fixture(before);
  await tool.execute('id', { ...params, oldText: 'XYZ', newText: 'Q' });
  expect(await readFile(file)).toEqual(after);
  expect(proposal()?.beforeSha256).toBe(hash(before));
  expect(proposal()?.afterSha256).toBe(hash(after));
  expect(proposal()?.beforeText).toBe('\ufeffabcXYZdef');
  expect(proposal()?.afterText).toBe('\ufeffabcQdef');
  expect(Buffer.from(proposal()!.beforeText, 'utf8')).toEqual(before);
  expect(Buffer.from(proposal()!.afterText, 'utf8')).toEqual(after);
});

test('BOM 计入正文长度且不允许替换消除它', async () => {
  const { file, tool, proposal } = await fixture('\ufeff' + 'x'.repeat(12000));
  expect((await tool.execute('id', { ...params, oldText: 'x', newText: 'y' })).isError).toBe(true);
  expect(proposal()).toBeUndefined();
  await writeFile(file, '\ufeffabc');
  expect((await tool.execute('id', { ...params, oldText: '\ufeff', newText: '' })).isError).toBe(true);
  expect(await readFile(file, 'utf8')).toBe('\ufeffabc');
});

test.each([
  { ...params, oldText: '' },
  { ...params, oldText: '不存在' },
  { ...params, newText: '唯一片段' },
  { ...params, unexpected: true },
  { ...params, oldText: 1 },
  { ...params, newText: undefined },
  { ...params, newText: '\ud800' },
  { ...params, newText: '\u0000' },
  { ...params, path: '../example.ts' },
  { ...params, path: '.env' },
  { ...params, path: 'example.ts:stream' },
])('严格拒绝不安全参数或提案，原文件不变：%j', async (input) => {
  const { file, tool, proposal } = await fixture();
  const result = await tool.execute('id', input);
  expect(result.isError).toBe(true);
  expect(proposal()).toBeUndefined();
  expect(await readFile(file, 'utf8')).toBe('前文\n唯一片段\n后文\n');
});

test('拒绝参数访问器，不调用 getter', async () => {
  const { tool, proposal } = await fixture();
  let accessed = false;
  const input = Object.defineProperty({ ...params }, 'oldText', {
    enumerable: true, get() { accessed = true; return '唯一片段'; },
  });
  const result = await tool.execute('id', input);
  expect(result.isError).toBe(true);
  expect(accessed).toBe(false);
  expect(proposal()).toBeUndefined();
});

test.each(['aaaa', 'XYZXYZ'])('包括重叠在内的多处匹配必须拒绝：%s', async (text) => {
  const { file, tool } = await fixture(text);
  const result = await tool.execute('id', { ...params, oldText: text === 'aaaa' ? 'aaa' : 'XYZ' });
  expect(result.isError).toBe(true);
  expect(await readFile(file, 'utf8')).toBe(text);
});

test.each([
  Buffer.from('x'.repeat(12001)),
  Buffer.from('中'.repeat(11000)),
  Buffer.from([0xc3, 0x28]),
])('拒绝前文字符超限、字节超限及无效 UTF-8', async (bytes) => {
  const { file, tool, proposal } = await fixture(bytes);
  const result = await tool.execute('id', { ...params, oldText: 'x' });
  expect(result.isError).toBe(true);
  expect(proposal()).toBeUndefined();
  expect(await readFile(file)).toEqual(bytes);
});

test('拒绝后文字符或字节超限', async () => {
  const { file, tool, proposal } = await fixture('X');
  for (const newText of ['x'.repeat(12001), '中'.repeat(11000)]) {
    expect((await tool.execute('id', { ...params, oldText: 'X', newText })).isError).toBe(true);
  }
  expect(proposal()).toBeUndefined();
  expect(await readFile(file, 'utf8')).toBe('X');
});

test('审批拒绝不会打开写入，处理器摘要不进入对话', async () => {
  const { file, tool } = await fixture(undefined, async () => ({ status: 'rejected', summary: '完整私有正文' }));
  const result = await tool.execute('id', params);
  expect(result.details.status).toBe('rejected');
  expect(await readFile(file, 'utf8')).toBe('前文\n唯一片段\n后文\n');
  expect(JSON.stringify(result)).not.toContain('完整私有正文');
});

test('onEdit 抛错原样传播，不转成可继续的工具错误', async () => {
  const failure = new Error('日志写入失败');
  const { file, tool } = await fixture(undefined, async () => { throw failure; });
  await expect(tool.execute('id', params)).rejects.toBe(failure);
  expect(await readFile(file, 'utf8')).toBe('前文\n唯一片段\n后文\n');
});

test('审批等待中内容变化返回冲突并保留外部改动', async () => {
  let file = '';
  const f = await fixture(undefined, async (_proposal, apply, signal) => {
    await writeFile(file, '外部编辑');
    return apply(signal);
  });
  file = f.file;
  const result = await f.tool.execute('id', params);
  expect(result.details.status).toBe('conflict');
  expect(await readFile(file, 'utf8')).toBe('外部编辑');
});

test('审批中替换文件，即使字节相同仍拒绝', async () => {
  let file = '';
  const f = await fixture(undefined, async (_proposal, apply, signal) => {
    await rename(file, `${file}.saved`);
    await writeFile(file, '前文\n唯一片段\n后文\n');
    return apply(signal);
  });
  file = f.file;
  expect((await f.tool.execute('id', params)).details.status).toBe('conflict');
  expect(await readFile(file, 'utf8')).toBe('前文\n唯一片段\n后文\n');
});

test('硬链接在准备阶段被拒绝', async () => {
  const { root, file, tool, proposal } = await fixture();
  await link(file, join(root, 'second.ts'));
  expect((await tool.execute('id', params)).isError).toBe(true);
  expect(proposal()).toBeUndefined();
});

test('审批中新增硬链接返回冲突', async () => {
  let root = '';
  let file = '';
  const f = await fixture(undefined, async (_proposal, apply, signal) => {
    await link(file, join(root, 'second.ts'));
    return apply(signal);
  });
  root = f.root;
  file = f.file;
  expect((await f.tool.execute('id', params)).details.status).toBe('conflict');
  expect(await readFile(file, 'utf8')).toBe('前文\n唯一片段\n后文\n');
});

test('目录联接或符号链接不能成为写入路径', async () => {
  const { root, file, tool } = await fixture();
  const target = join(root, 'actual');
  await mkdir(target);
  await writeFile(join(target, 'other.ts'), '唯一片段');
  await symlink(target, join(root, 'alias'), process.platform === 'win32' ? 'junction' : 'dir');
  expect((await tool.execute('id', { ...params, path: 'alias/other.ts' })).isError).toBe(true);
  expect(await readFile(join(target, 'other.ts'), 'utf8')).toBe('唯一片段');
  expect(await readFile(file, 'utf8')).toBe('前文\n唯一片段\n后文\n');
});

test('写前取消无副作用，重复 apply 不重放', async () => {
  const controller = new AbortController();
  const { file, tool } = await fixture(undefined, async (_proposal, apply) => {
    controller.abort();
    const first = await apply(controller.signal);
    expect(first.status).toBe('cancelled');
    expect((await apply(new AbortController().signal)).status).toBe('failed');
    return first;
  });
  expect((await tool.execute('id', params)).details.status).toBe('cancelled');
  expect(await readFile(file, 'utf8')).toBe('前文\n唯一片段\n后文\n');
});

test('根授权失效后 apply 拒绝', async () => {
  let session: WorkspaceSession;
  const f = await fixture(undefined, async (_proposal, apply, signal) => {
    session.clear();
    return apply(signal);
  });
  session = f.session;
  expect((await f.tool.execute('id', params)).details.status).toBe('conflict');
  expect(await readFile(f.file, 'utf8')).toBe('前文\n唯一片段\n后文\n');
});
