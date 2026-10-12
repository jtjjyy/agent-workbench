import { afterEach, expect, test } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SkillService } from '../../src/main/skills/skill-service';

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });

test('内置 Skill 默认启用且可以持久化停用状态', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'awb-skills-')); directories.push(directory);
  const service = new SkillService(directory);
  expect((await service.list()).every((skill) => skill.enabled)).toBe(true);
  await service.setEnabled('repository-understanding', false);
  const restored = new SkillService(directory);
  expect((await restored.list()).find((skill) => skill.id === 'repository-understanding')?.enabled).toBe(false);
});
