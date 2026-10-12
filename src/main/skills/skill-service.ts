import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { BUILTIN_SKILLS } from './builtin-skills';
import { matchSkills } from './skill-matcher';
import { validateSkillDefinition, type SkillAccess, type SkillDefinition, type SkillSelection, type SkillSummary } from '../../shared/skills';

type SkillSettings = { enabled: Record<string, boolean> };

export class SkillService implements SkillAccess {
  private readonly settingsPath: string;
  private readonly userSkillsPath: string;
  private definitions: SkillDefinition[] | undefined;
  private settings: SkillSettings | undefined;

  constructor(baseDirectory: string) {
    this.settingsPath = join(baseDirectory, 'skills', 'settings-v1.json');
    this.userSkillsPath = join(baseDirectory, 'skills');
  }

  private async loadSettings(): Promise<SkillSettings> {
    if (this.settings) return this.settings;
    try {
      const parsed = JSON.parse(await readFile(this.settingsPath, 'utf8')) as SkillSettings;
      this.settings = parsed && parsed.enabled && typeof parsed.enabled === 'object'
        ? { enabled: { ...parsed.enabled } } : { enabled: {} };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      this.settings = { enabled: {} };
    }
    return this.settings;
  }

  private async loadDefinitions(): Promise<SkillDefinition[]> {
    if (this.definitions) return this.definitions;
    const definitions = [...BUILTIN_SKILLS];
    try {
      const entries = await readdir(this.userSkillsPath, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.name === 'settings-v1.json') continue;
        const file = join(this.userSkillsPath, entry.name, 'SKILL.md');
        try {
          const parsed = parseSkillMarkdown(await readFile(file, 'utf8'));
          if (parsed && validateSkillDefinition(parsed) && parsed.source === 'user' && parsed.id === entry.name) definitions.push(parsed);
        } catch { /* Ignore one malformed user Skill without disabling the app. */ }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    this.definitions = definitions;
    return definitions;
  }

  private async persistSettings(): Promise<void> {
    if (!this.settings) return;
    await mkdir(dirname(this.settingsPath), { recursive: true });
    const temporary = `${this.settingsPath}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify(this.settings, null, 2), 'utf8');
    await rename(temporary, this.settingsPath);
  }

  private async enabledIds(): Promise<Set<string>> {
    const settings = await this.loadSettings();
    const definitions = await this.loadDefinitions();
    return new Set(definitions.filter((skill) => settings.enabled[skill.id] !== false).map((skill) => skill.id));
  }

  async select(prompt: string): Promise<SkillSelection> {
    return matchSkills(prompt, await this.loadDefinitions(), await this.enabledIds());
  }

  async list(): Promise<SkillSummary[]> {
    const settings = await this.loadSettings();
    return (await this.loadDefinitions()).map((skill) => ({ id: skill.id, name: skill.name,
      description: skill.description, keywords: [...skill.keywords], allowedTools: [...skill.allowedTools],
      source: skill.source, enabled: settings.enabled[skill.id] !== false }));
  }

  async setEnabled(id: string, enabled: boolean): Promise<SkillSummary[]> {
    const definition = (await this.loadDefinitions()).find((skill) => skill.id === id);
    if (!definition || typeof enabled !== 'boolean') throw new Error('Skill 不存在或启用状态无效');
    const settings = await this.loadSettings();
    settings.enabled[id] = enabled;
    await this.persistSettings();
    return this.list();
  }
}

function parseSkillMarkdown(text: string): unknown {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/u.exec(text);
  if (!match) return undefined;
  const values: Record<string, string> = {};
  for (const line of match[1].split(/\r?\n/u)) {
    const separator = line.indexOf(':');
    if (separator <= 0) continue;
    values[line.slice(0, separator).trim()] = line.slice(separator + 1).trim();
  }
  return { id: values.id, name: values.name, description: values.description,
    keywords: (values.keywords ?? '').split(',').map((value) => value.trim()).filter(Boolean),
    allowedTools: (values.allowedTools ?? '').split(',').map((value) => value.trim()).filter(Boolean),
    instructions: match[2].trim(), source: 'user' };
}
