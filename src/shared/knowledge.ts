import type { SourceEvidence, WorkspaceState } from './workspace';

export type MemoryScope = 'user' | 'project';

export interface ManagedMemory {
  id: string;
  scope: MemoryScope;
  projectKey?: string;
  content: string;
  sourcePath?: string;
  sourceStartLine?: number;
  sourceEndLine?: number;
  sourceSha256?: string;
  createdAt: string;
  updatedAt: string;
}

export interface KnowledgeState {
  projectKey: string | null;
  indexedAt: string | null;
  fileCount: number;
  chunkCount: number;
  staleCount: number;
  memoryCount: number;
  lastError: string | null;
}

export interface KnowledgeSearchResult {
  kind: 'file' | 'memory';
  title: string;
  text: string;
  source?: SourceEvidence;
  memoryId?: string;
}

export interface ProjectKnowledgeSummary {
  projectKey: string;
  indexedAt: string | null;
  files: string[];
  extensionCounts: Record<string, number>;
  entryCandidates: string[];
  notes: string[];
}

export interface KnowledgeAccess {
  readState(workspace: WorkspaceState): Promise<KnowledgeState>;
  sync(workspace: WorkspaceState, signal?: AbortSignal): Promise<KnowledgeState>;
  search(workspace: WorkspaceState, query: string, signal?: AbortSignal): Promise<KnowledgeSearchResult[]>;
  readProjectKnowledge(workspace: WorkspaceState, signal?: AbortSignal): Promise<ProjectKnowledgeSummary>;
}

export interface KnowledgeBridge {
  readKnowledgeState(): Promise<KnowledgeState>;
  syncKnowledge(): Promise<KnowledgeState>;
  searchKnowledge(request: { query: string }): Promise<KnowledgeSearchResult[]>;
  readProjectKnowledge(): Promise<ProjectKnowledgeSummary | null>;
  readMemories(): Promise<ManagedMemory[]>;
  saveMemory(request: { scope: MemoryScope; content: string }): Promise<ManagedMemory | null>;
  deleteMemory(request: { id: string }): Promise<{ deleted: boolean }>;
}

export const EMPTY_KNOWLEDGE_STATE: KnowledgeState = {
  projectKey: null, indexedAt: null, fileCount: 0, chunkCount: 0, staleCount: 0,
  memoryCount: 0, lastError: null,
};
