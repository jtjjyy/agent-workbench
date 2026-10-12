import { BookOpen, RefreshCw, Save, Search, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { AgentBridge } from '../../shared/contracts';
import type { KnowledgeSearchResult, KnowledgeState, ManagedMemory, ProjectKnowledgeSummary } from '../../shared/knowledge';

export function KnowledgePanel({ bridge, blocked }: { bridge?: AgentBridge; blocked: boolean }) {
  const [state, setState] = useState<KnowledgeState | null>(null);
  const [summary, setSummary] = useState<ProjectKnowledgeSummary | null>(null);
  const [memories, setMemories] = useState<ManagedMemory[]>([]);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<KnowledgeSearchResult[]>([]);
  const [memory, setMemory] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function reload() { if (!bridge) return; try { const [a, b, c] = await Promise.all([bridge.readKnowledgeState(), bridge.readProjectKnowledge(), bridge.readMemories()]); setState(a); setSummary(b); setMemories(c); setError(a.lastError); } catch { setError('无法读取项目知识状态。'); } }
  useEffect(() => { void reload(); }, [bridge]);
  async function sync() { if (!bridge || blocked || busy) return; setBusy(true); setError(null); try { await bridge.syncKnowledge(); await reload(); } catch { setError('知识索引同步失败。'); } finally { setBusy(false); } }
  async function search() { if (!bridge || blocked || busy || !query.trim()) return; setBusy(true); setError(null); try { setResults(await bridge.searchKnowledge({ query: query.trim() })); } catch { setError('知识检索失败。'); } finally { setBusy(false); } }
  async function save() { if (!bridge || blocked || busy || !memory.trim()) return; setBusy(true); setError(null); try { await bridge.saveMemory({ scope: 'user', content: memory.trim() }); setMemory(''); await reload(); } catch { setError('记忆保存失败。'); } finally { setBusy(false); } }
  async function remove(id: string) { if (!bridge || blocked || busy) return; setBusy(true); setError(null); try { await bridge.deleteMemory({ id }); await reload(); } catch { setError('记忆删除失败。'); } finally { setBusy(false); } }
  return <section className="knowledge-panel" aria-label="项目知识库">
    <header className="section-header"><h2><BookOpen size={15} aria-hidden="true" />项目知识库</h2><button className="icon-button" type="button" title="同步项目索引" aria-label="同步项目索引" disabled={!bridge || blocked || busy} onClick={() => { void sync(); }}><RefreshCw size={15} aria-hidden="true" /></button></header>
    <div className="knowledge-content"><p className="knowledge-status">{state ? `文件 ${state.fileCount} 个，片段 ${state.chunkCount} 个，记忆 ${state.memoryCount} 条` : '正在读取状态'}</p>{state?.indexedAt && <p className="knowledge-muted">最近同步：{new Date(state.indexedAt).toLocaleString('zh-CN')}</p>}{summary && <p className="knowledge-muted">候选入口：{summary.entryCandidates.slice(0, 4).join('、') || '暂无'}</p>}
      <div className="knowledge-search"><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="检索项目知识" aria-label="检索项目知识" disabled={!bridge || blocked || busy} onKeyDown={(event) => { if (event.key === 'Enter') void search(); }} /><button className="icon-button" type="button" title="检索" aria-label="检索" disabled={!query.trim() || blocked || busy} onClick={() => { void search(); }}><Search size={15} aria-hidden="true" /></button></div>
      {results.length > 0 && <ol className="knowledge-results">{results.map((item, index) => <li key={`${item.memoryId ?? item.title}-${index}`}><strong>{item.title}</strong><p>{item.text}</p>{item.source && <code>{item.source.path}:{item.source.startLine}-{item.source.endLine}</code>}</li>)}</ol>}
      <div className="knowledge-memory"><textarea value={memory} onChange={(event) => setMemory(event.target.value)} placeholder="保存一条用户记忆" aria-label="保存一条用户记忆" maxLength={4000} disabled={!bridge || blocked || busy} /><button className="text-button" type="button" disabled={!memory.trim() || blocked || busy} onClick={() => { void save(); }}><Save size={14} aria-hidden="true" />保存记忆</button></div>
      {memories.length > 0 && <ul className="knowledge-memory-list">{memories.map((item) => <li key={item.id}><span>{item.content}</span><button className="icon-button" type="button" title="删除记忆" aria-label="删除记忆" disabled={blocked || busy} onClick={() => { void remove(item.id); }}><Trash2 size={14} aria-hidden="true" /></button></li>)}</ul>}{error && <p className="knowledge-error" role="alert">{error}</p>}</div>
  </section>;
}
