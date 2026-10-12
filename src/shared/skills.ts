export const MAX_SKILL_NAME_LENGTH = 64;
export const MAX_SKILL_DESCRIPTION_LENGTH = 400;
export const MAX_SKILL_INSTRUCTIONS_LENGTH = 8000;
export const MAX_SKILL_COUNT = 3;
export const MAX_SKILL_PROMPT_LENGTH = 12_000;

export type SkillSource = 'builtin' | 'user';
export type SkillToolName = 'list_files' | 'read_file' | 'search_text' | 'search_knowledge' | 'read_project_knowledge' | 'replace_text';

export interface SkillDefinition {
  id: string;
  name: string;
  description: string;
  keywords: string[];
  instructions: string;
  allowedTools: SkillToolName[];
  source: SkillSource;
}

export interface SkillSummary extends Omit<SkillDefinition, 'instructions'> {
  enabled: boolean;
}

export interface SkillState {
  skills: SkillSummary[];
}

export interface SkillSelection {
  names: string[];
  instructions: string;
}

export interface SkillAccess {
  select(prompt: string): Promise<SkillSelection>;
  list(): Promise<SkillSummary[]>;
  setEnabled(id: string, enabled: boolean): Promise<SkillSummary[]>;
}

export interface SkillBridge {
  readSkills(): Promise<SkillSummary[]>;
  setSkillEnabled(request: { id: string; enabled: boolean }): Promise<SkillSummary[]>;
}

export function validateSkillDefinition(value: unknown): value is SkillDefinition {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return typeof item.id === 'string' && item.id.length > 0 && item.id.length <= MAX_SKILL_NAME_LENGTH
    && /^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(item.id)
    && typeof item.name === 'string' && item.name.trim().length > 0 && item.name.length <= MAX_SKILL_NAME_LENGTH
    && typeof item.description === 'string' && item.description.length <= MAX_SKILL_DESCRIPTION_LENGTH
    && Array.isArray(item.keywords) && item.keywords.length <= 16
    && item.keywords.every((keyword) => typeof keyword === 'string' && keyword.trim().length > 0 && keyword.length <= 64)
    && typeof item.instructions === 'string' && item.instructions.trim().length > 0
    && item.instructions.length <= MAX_SKILL_INSTRUCTIONS_LENGTH
    && Array.isArray(item.allowedTools) && item.allowedTools.every((tool) =>
      ['list_files', 'read_file', 'search_text', 'search_knowledge', 'read_project_knowledge', 'replace_text'].includes(tool as string))
    && (item.source === 'builtin' || item.source === 'user');
}
