import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { KnowledgeSearchResult, ProjectKnowledgeSummary } from '../../shared/knowledge';
import type { SourceEvidence } from '../../shared/workspace';
import type { BoundedTextFile } from '../tools/readonly-tools';

type StoredChunk = { text: string; startLine: number; endLine: number };
type StoredFile = { path: string; size: string; mtimeNs: string; ctimeNs: string; sha256: string; chunks: StoredChunk[] };
export type ProjectIndex = { projectKey: string; indexedAt: string; files: StoredFile[]; summary: ProjectKnowledgeSummary };

const CHUNK_LENGTH = 1200;
const CHUNK_OVERLAP = 100;

export function projectKeyForRoot(root: string): string {
  return createHash('sha256').update(root.toLowerCase()).digest('hex').slice(0, 32);
}

function lineNumberAt(text: string, offset: number): number {
  let line = 1;
  for (let index = 0; index < offset; index++) if (text[index] === '\n') line++;
  return line;
}

function chunkText(text: string): StoredChunk[] {
  const chunks: StoredChunk[] = [];
  let start = 0;
  while (start < text.length) {
    const end = Math.min(text.length, start + CHUNK_LENGTH);
    const chunk = text.slice(start, end);
    chunks.push({ text: chunk, startLine: lineNumberAt(text, start), endLine: lineNumberAt(text, Math.max(start, end - 1)) });
    if (end === text.length) break;
    start = Math.max(start + 1, end - CHUNK_OVERLAP);
  }
  return chunks;
}

export function buildFileRecord(file: BoundedTextFile): StoredFile {
  return { path: file.relative, size: file.stat.size.toString(), mtimeNs: file.stat.mtimeNs.toString(),
    ctimeNs: file.stat.ctimeNs.toString(), sha256: file.sha256, chunks: chunkText(file.text) };
}

export class ProjectIndexStore {
  constructor(private readonly baseDirectory: string) {}

  private pathFor(projectKey: string): string {
    return join(this.baseDirectory, 'knowledge', 'projects', `${projectKey}.json`);
  }

  async read(projectKey: string): Promise<ProjectIndex | null> {
    try {
      const raw = await readFile(this.pathFor(projectKey), 'utf8');
      const parsed = JSON.parse(raw) as ProjectIndex;
      return parsed.projectKey === projectKey ? parsed : null;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  async write(index: ProjectIndex): Promise<void> {
    const filePath = this.pathFor(index.projectKey);
    await mkdir(dirname(filePath), { recursive: true });
    const temporary = `${filePath}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify(index), 'utf8');
    await rename(temporary, filePath);
  }

  static search(index: ProjectIndex, query: string, limit = 12): KnowledgeSearchResult[] {
    const terms = query.toLocaleLowerCase().split(/\s+/u).filter(Boolean);
    const results: { score: number; result: KnowledgeSearchResult }[] = [];
    for (const file of index.files) for (const chunk of file.chunks) {
      const lower = chunk.text.toLocaleLowerCase();
      const score = terms.reduce((sum, term) => sum + (lower.includes(term) ? 1 : 0), 0);
      if (!score) continue;
      const source: SourceEvidence = { path: file.path, startLine: chunk.startLine, endLine: chunk.endLine,
        sha256: file.sha256, excerpt: chunk.text.slice(0, 240) };
      results.push({ score, result: { kind: 'file', title: file.path, text: chunk.text.slice(0, 1200), source } });
    }
    return results.sort((left, right) => right.score - left.score || left.result.title.localeCompare(right.result.title))
      .slice(0, limit).map((item) => item.result);
  }
}
