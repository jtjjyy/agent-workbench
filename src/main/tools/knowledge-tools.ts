import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core';
import { Type } from 'typebox';
import type { KnowledgeAccess, KnowledgeSearchResult } from '../../shared/knowledge';
import type { WorkspaceState } from '../../shared/workspace';

const querySchema = Type.Object({ query: Type.String({ minLength: 1, maxLength: 200 }) }, { additionalProperties: false });
const emptySchema = Type.Object({}, { additionalProperties: false });
type Details = { summary: string; sources: NonNullable<KnowledgeSearchResult['source']>[] };

function result(content: string, details: Details, isError = false): AgentToolResult<Details> {
  return { content: [{ type: 'text', text: content }], details, isError };
}

function formatSearch(results: KnowledgeSearchResult[]): AgentToolResult<Details> {
  const sources = results.flatMap((item) => item.source ? [item.source] : []);
  const text = results.length ? results.map((item, index) => `${index + 1}. ${item.title}\n${item.text}`).join('\n\n')
    : '没有找到匹配的项目知识或已保存记忆。';
  return result(text, { summary: `知识检索返回 ${results.length} 条结果。`, sources });
}

export function createKnowledgeTools(workspace: WorkspaceState, knowledge: KnowledgeAccess): AgentTool[] {
  if (!workspace.root || workspace.dataEgressConsent !== true) return [];
  return [
    { name: 'search_knowledge', label: '检索项目知识', parameters: querySchema,
      description: '检索已建立的项目索引和用户明确保存的记忆。结果可能过期，必须阅读来源路径、行号和 SHA-256。',
      executionMode: 'sequential', replay: 'never',
      execute: async (_id, input, signal) => {
        try { return formatSearch(await knowledge.search(workspace, (input as { query: string }).query, signal)); }
        catch (error) { signal?.throwIfAborted(); return result(error instanceof Error ? error.message : '知识检索失败。', { summary: '知识检索失败。', sources: [] }, true); }
      } },
    { name: 'read_project_knowledge', label: '读取项目知识摘要', parameters: emptySchema,
      description: '读取当前项目索引摘要，包括文件列表、扩展名统计、候选入口和索引时间。',
      executionMode: 'sequential', replay: 'never',
      execute: async (_id, _input, signal) => {
        try {
          const summary = await knowledge.readProjectKnowledge(workspace, signal);
          return result(JSON.stringify(summary), { summary: `项目知识摘要包含 ${summary.files.length} 个文件。`, sources: [] });
        } catch (error) { signal?.throwIfAborted(); return result(error instanceof Error ? error.message : '项目知识摘要读取失败。', { summary: '项目知识摘要读取失败。', sources: [] }, true); }
      } },
  ];
}
