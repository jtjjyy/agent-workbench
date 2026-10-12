import { MAX_SKILL_COUNT, MAX_SKILL_PROMPT_LENGTH, type SkillDefinition, type SkillSelection } from '../../shared/skills';

export function matchSkills(prompt: string, skills: SkillDefinition[], enabled: Set<string>): SkillSelection {
  const normalized = prompt.toLocaleLowerCase();
  const ranked = skills.filter((skill) => enabled.has(skill.id)).map((skill) => {
    const score = skill.keywords.reduce((total, keyword) => total + (normalized.includes(keyword.toLocaleLowerCase()) ? 1 : 0), 0);
    return { skill, score };
  }).filter((item) => item.score > 0).sort((left, right) => right.score - left.score || left.skill.id.localeCompare(right.skill.id));
  const selected = ranked.slice(0, MAX_SKILL_COUNT);
  let instructions = selected.map(({ skill }) => `【Skill：${skill.name}】\n${skill.instructions}`).join('\n\n');
  if (instructions.length > MAX_SKILL_PROMPT_LENGTH) instructions = instructions.slice(0, MAX_SKILL_PROMPT_LENGTH);
  return { names: selected.map(({ skill }) => skill.id), instructions };
}
