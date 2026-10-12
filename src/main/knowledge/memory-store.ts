import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ManagedMemory, MemoryScope } from '../../shared/knowledge';

const MAX_MEMORY_LENGTH = 4000;

export class MemoryStore {
  private readonly filePath: string;
  private memories: ManagedMemory[] = [];
  private loaded: Promise<void> | undefined;

  constructor(baseDirectory: string) {
    this.filePath = join(baseDirectory, 'knowledge', 'memories-v1.json');
  }

  private async load(): Promise<void> {
    if (this.loaded) return this.loaded;
    this.loaded = (async () => {
      try {
        const raw = await readFile(this.filePath, 'utf8');
        const parsed: unknown = JSON.parse(raw);
        if (Array.isArray(parsed)) this.memories = parsed.filter((item): item is ManagedMemory => this.valid(item));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    })();
    return this.loaded;
  }

  private valid(value: unknown): value is ManagedMemory {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const item = value as Record<string, unknown>;
    return typeof item.id === 'string' && (item.scope === 'user' || item.scope === 'project')
      && typeof item.content === 'string' && item.content.length <= MAX_MEMORY_LENGTH
      && typeof item.createdAt === 'string' && typeof item.updatedAt === 'string';
  }

  private async persist(): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify(this.memories, null, 2), 'utf8');
    await rename(temporary, this.filePath);
  }

  async list(projectKey?: string): Promise<ManagedMemory[]> {
    await this.load();
    return this.memories.filter((item) => item.scope === 'user' || item.projectKey === projectKey)
      .map((item) => ({ ...item }));
  }

  async save(input: { scope: MemoryScope; content: string; projectKey?: string }): Promise<ManagedMemory> {
    await this.load();
    const content = input.content.trim();
    if (!content || content.length > MAX_MEMORY_LENGTH) throw new Error('记忆内容长度不符合要求');
    if (input.scope === 'project' && !input.projectKey) throw new Error('项目记忆缺少项目标识');
    const now = new Date().toISOString();
    const memory: ManagedMemory = { id: randomUUID(), scope: input.scope,
      ...(input.projectKey ? { projectKey: input.projectKey } : {}), content,
      createdAt: now, updatedAt: now };
    this.memories.push(memory);
    await this.persist();
    return { ...memory };
  }

  async delete(id: string): Promise<boolean> {
    await this.load();
    const before = this.memories.length;
    this.memories = this.memories.filter((item) => item.id !== id);
    if (this.memories.length === before) return false;
    await this.persist();
    return true;
  }
}
