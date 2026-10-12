import { afterEach, expect, test } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KnowledgeService } from '../../src/main/knowledge/knowledge-service';
import { WorkspaceSession } from '../../src/main/workspace/workspace-session';

const roots: string[] = [];
const sessions: WorkspaceSession[] = [];
afterEach(async () => {
  sessions.splice(0).forEach((session) => session.clear());
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test('首次同步建立索引，后续同步复用未变化文件', async () => {
  const root = await mkdtemp(join(tmpdir(), 'awb-knowledge-'));
  const data = await mkdtemp(join(tmpdir(), 'awb-knowledge-data-'));
  roots.push(root, data);
  await writeFile(join(root, 'README.md'), 'Agent knowledge\n');
  const session = new WorkspaceSession(); sessions.push(session); await session.select(root);
  const workspace = session.setConsent(true);
  const service = new KnowledgeService(data);
  const first = await service.sync(workspace);
  const second = await service.sync(workspace);
  expect(first.fileCount).toBe(1);
  expect(second.chunkCount).toBe(first.chunkCount);
  expect((await service.search(workspace, 'knowledge'))[0]?.source?.path).toBe('README.md');
});

test('用户记忆可保存、读取和删除', async () => {
  const root = await mkdtemp(join(tmpdir(), 'awb-knowledge-'));
  const data = await mkdtemp(join(tmpdir(), 'awb-knowledge-data-'));
  roots.push(root, data);
  const session = new WorkspaceSession(); sessions.push(session); await session.select(root);
  const service = new KnowledgeService(data);
  const saved = await service.saveMemory(session.setConsent(true), 'user', '保留中文回复');
  expect((await service.readMemories(session.read())).some((item) => item.id === saved.id)).toBe(true);
  expect(await service.deleteMemory(saved.id)).toBe(true);
  expect((await service.readMemories(session.read())).some((item) => item.id === saved.id)).toBe(false);
  expect(await readFile(join(data, 'knowledge', 'memories-v1.json'), 'utf8')).toContain('[]');
});
