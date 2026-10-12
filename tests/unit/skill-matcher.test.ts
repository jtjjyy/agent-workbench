import { expect, test } from 'vitest';
import { matchSkills } from '../../src/main/skills/skill-matcher';
import type { SkillDefinition } from '../../src/shared/skills';

const skills: SkillDefinition[] = [
  { id: 'repo', name: '仓库', description: '仓库', keywords: ['仓库', '源码'], instructions: '先找入口。', allowedTools: ['list_files'], source: 'builtin' },
  { id: 'research', name: '调研', description: '调研', keywords: ['调研'], instructions: '列出证据。', allowedTools: ['search_knowledge'], source: 'builtin' },
];

test('只选择已启用且与任务关键词匹配的 Skill', () => {
  const result = matchSkills('请理解这个仓库的源码入口', skills, new Set(['repo']));
  expect(result.names).toEqual(['repo']);
  expect(result.instructions).toContain('先找入口');
});

test('没有匹配时不注入 Skill 指令', () => {
  expect(matchSkills('请写一封邮件', skills, new Set(['repo', 'research']))).toEqual({ names: [], instructions: '' });
});
