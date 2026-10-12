import type { KnowledgeAccess, KnowledgeSearchResult, KnowledgeState, ManagedMemory, MemoryScope, ProjectKnowledgeSummary } from '../../shared/knowledge';
import type { WorkspaceState } from '../../shared/workspace';
import { createWorkspaceFileContext, scanWorkspaceTextFiles } from '../tools/readonly-tools';
import { MemoryStore } from './memory-store';
import { buildFileRecord, projectKeyForRoot, ProjectIndexStore, type ProjectIndex } from './project-index';

export class KnowledgeService implements KnowledgeAccess {
  private readonly memoryStore: MemoryStore;
  private readonly indexStore: ProjectIndexStore;
  private readonly states = new Map<string, KnowledgeState>();

  constructor(baseDirectory: string) {
    this.memoryStore = new MemoryStore(baseDirectory);
    this.indexStore = new ProjectIndexStore(baseDirectory);
  }

  private key(workspace: WorkspaceState): string {
    if (!workspace.root) throw new Error('请先选择工作区');
    return projectKeyForRoot(workspace.root);
  }

  async readState(workspace: WorkspaceState): Promise<KnowledgeState> {
    if (!workspace.root) return { projectKey: null, indexedAt: null, fileCount: 0, chunkCount: 0, staleCount: 0, memoryCount: 0, lastError: null };
    const projectKey = this.key(workspace);
    const index = await this.indexStore.read(projectKey);
    const memories = await this.memoryStore.list(projectKey);
    const state = this.states.get(projectKey) ?? { projectKey, indexedAt: index?.indexedAt ?? null,
      fileCount: index?.files.length ?? 0, chunkCount: index?.files.reduce((sum, file) => sum + file.chunks.length, 0) ?? 0,
      staleCount: 0, memoryCount: memories.length, lastError: null };
    return { ...state, memoryCount: memories.length };
  }

  async sync(workspace: WorkspaceState, signal?: AbortSignal): Promise<KnowledgeState> {
    const projectKey = this.key(workspace);
    await createWorkspaceFileContext(workspace, signal);
    const previous = await this.indexStore.read(projectKey);
    const files = await scanWorkspaceTextFiles(workspace, signal, 200);
    const previousFiles = new Map((previous?.files ?? []).map((file) => [file.path, file]));
    const records = files.map((file) => {
      const old = previousFiles.get(file.relative);
      return old && old.size === file.stat.size.toString() && old.mtimeNs === file.stat.mtimeNs.toString()
        && old.ctimeNs === file.stat.ctimeNs.toString() && old.sha256 === file.sha256 ? old : buildFileRecord(file);
    });
    const summary: ProjectKnowledgeSummary = { projectKey, indexedAt: new Date().toISOString(), files: records.map((file) => file.path),
      extensionCounts: {}, entryCandidates: [], notes: [] };
    for (const file of records) {
      const extension = file.path.includes('.') ? `.${file.path.split('.').pop()!.toLowerCase()}` : '(无扩展名)';
      summary.extensionCounts[extension] = (summary.extensionCounts[extension] ?? 0) + 1;
      if (/^(readme|package\.json|tsconfig\.json|src\/main|src\/renderer)/iu.test(file.path)) summary.entryCandidates.push(file.path);
    }
    if (files.length >= 200) summary.notes.push('索引达到单次最多 200 个文本文件的上限。');
    const index: ProjectIndex = { projectKey, indexedAt: summary.indexedAt, files: records, summary };
    await this.indexStore.write(index);
    const memories = await this.memoryStore.list(projectKey);
    const currentPaths = new Set(records.map((file) => file.path));
    const staleCount = previous ? previous.files.filter((file) => !currentPaths.has(file.path)).length : 0;
    const state: KnowledgeState = { projectKey, indexedAt: index.indexedAt, fileCount: records.length,
      chunkCount: records.reduce((sum, file) => sum + file.chunks.length, 0), staleCount,
      memoryCount: memories.length, lastError: null };
    this.states.set(projectKey, state);
    return state;
  }

  async search(workspace: WorkspaceState, query: string, signal?: AbortSignal): Promise<KnowledgeSearchResult[]> {
    if (!query.trim() || query.length > 200) throw new Error('检索内容长度不符合要求');
    const projectKey = this.key(workspace);
    await createWorkspaceFileContext(workspace, signal);
    const index = await this.indexStore.read(projectKey);
    const fileResults = index ? ProjectIndexStore.search(index, query) : [];
    const memories = await this.memoryStore.list(projectKey);
    const terms = query.toLocaleLowerCase().split(/\s+/u).filter(Boolean);
    const memoryResults = memories.filter((memory) => terms.every((term) => memory.content.toLocaleLowerCase().includes(term)))
      .slice(0, 12).map((memory) => ({ kind: 'memory' as const, title: memory.scope === 'project' ? '项目记忆' : '用户记忆', text: memory.content, memoryId: memory.id }));
    return [...fileResults, ...memoryResults].slice(0, 12);
  }

  async readProjectKnowledge(workspace: WorkspaceState, signal?: AbortSignal): Promise<ProjectKnowledgeSummary> {
    const projectKey = this.key(workspace);
    await createWorkspaceFileContext(workspace, signal);
    const index = await this.indexStore.read(projectKey);
    return index?.summary ?? { projectKey, indexedAt: null, files: [], extensionCounts: {}, entryCandidates: [], notes: ['尚未建立项目索引。'] };
  }

  async readMemories(workspace: WorkspaceState): Promise<ManagedMemory[]> {
    return this.memoryStore.list(workspace.root ? this.key(workspace) : undefined);
  }

  async saveMemory(workspace: WorkspaceState, scope: MemoryScope, content: string): Promise<ManagedMemory> {
    return this.memoryStore.save({ scope, content, projectKey: scope === 'project' ? this.key(workspace) : undefined });
  }

  async deleteMemory(id: string): Promise<boolean> { return this.memoryStore.delete(id); }
}
