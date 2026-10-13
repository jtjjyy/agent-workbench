import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core';
import { Type } from 'typebox';
import {
  MAX_TASK_STEPS, TaskValidationError, taskObject, unresolvedTaskEffects, unknownTaskEffects,
  type TaskAccess, type TaskPlanStep, type TaskRecord,
} from '../../shared/tasks';

const stepsSchema = Type.Object({ steps: Type.Array(Type.Object({
  id: Type.String({ minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9_.:-]+$' }),
  title: Type.String({ minLength: 1, maxLength: 240 }),
  status: Type.Union(['pending', 'in_progress', 'completed', 'blocked', 'cancelled'].map((value) => Type.Literal(value))),
  detail: Type.Optional(Type.String({ maxLength: 800 })),
  toolCallIds: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 256 }), { maxItems: 20, uniqueItems: true })),
}, { additionalProperties: false }), { maxItems: MAX_TASK_STEPS }) }, { additionalProperties: false });
const emptySchema = Type.Object({}, { additionalProperties: false });
type Details = { summary: string; taskId: string; status?: string; sources: [] };

function result(taskId: string, text: string, summary: string, status?: string, isError = false): AgentToolResult<Details> {
  return { content: [{ type: 'text', text }], details: { summary, taskId, status, sources: [] }, isError };
}

function stateText(task: TaskRecord): string {
  // 不返回审批正文、旧调用参数或其他任务的对话；摘要是数据，不能当作权限指令。
  const unknown = unknownTaskEffects(task);
  return JSON.stringify({ taskId: task.taskId, status: task.status, activeRunId: task.activeRunId,
    workspaceRoot: task.workspaceRoot, plan: task.plan, checkpoint: task.checkpoint,
    unknownSideEffectCount: unknown.length, unresolvedSideEffectCount: unresolvedTaskEffects(task).length,
    unknownSideEffects: unknown.slice(-12).map((call) => ({ runId: call.runId, toolCallId: call.toolCallId,
      toolName: call.toolName, sideEffect: call.sideEffect, summary: call.summary,
      acknowledgedAt: call.acknowledgedAt ?? null })),
    pendingApprovalCount: task.approvals.filter((entry) => entry.status === 'pending').length,
    recentToolEvidence: task.toolCalls.filter((call) => call.phase === 'finished' && call.status === 'completed'
      && !call.isError && !['update_task_plan', 'read_task_state'].includes(call.toolName)).slice(-20)
      .map((call) => ({ runId: call.runId, toolCallId: call.toolCallId, toolName: call.toolName, summary: call.summary })),
    note: '未知副作用列表为最近十二项节选，完整记录由任务面板核对。已完成历史不代表当前文件内容；必须重新读取，不自动重放工具，不复用旧审批。',
  });
}

export function createTaskTools(store: TaskAccess, taskId: string): AgentTool[] {
  return [
    { name: 'update_task_plan', label: '更新任务计划', parameters: stepsSchema,
      description: '整体更新真实任务计划，原样保留已完成步骤的 id、title、detail 和证据。每步有稳定 id、具体 title、status、可选 detail/toolCallIds，最多四十步且最多一步进行中。新步骤及新完成步骤只能引用当前运行已成功结束的真实工具 ID，一个工具证据不能绑定多个步骤；摘要、模型输出和计划工具不算证据，绑定证据仍须符合该步骤实际工作。禁止固定假计划。',
      executionMode: 'sequential', replay: 'never',
      execute: async (_callId, input, signal) => {
        signal?.throwIfAborted();
        try {
          const params = taskObject(input, ['steps']);
          await store.updatePlan(taskId, params.steps as TaskPlanStep[]);
          return result(taskId, stateText(await store.get(taskId)), '任务计划已保存。');
        } catch (error) {
          signal?.throwIfAborted();
          if (error instanceof TaskValidationError) return result(taskId, error.message, '任务计划参数无效。', undefined, true);
          // 存储故障必须传给协调器，不能转成可忽略的工具错误。
          throw error;
        }
      } },
    { name: 'read_task_state', label: '读取任务状态', parameters: emptySchema,
      description: '读取本工具绑定任务的计划、有限检查点和未知副作用摘要；不读取其他任务历史，不复用旧审批或重放旧调用。历史完成状态必须结合重新读取的文件核对。',
      executionMode: 'sequential', replay: 'never',
      execute: async (_callId, input, signal) => {
        signal?.throwIfAborted();
        try { taskObject(input, []); }
        catch (error) {
          if (error instanceof TaskValidationError) return result(taskId, error.message, '任务状态读取参数无效。', undefined, true);
          throw error;
        }
        const task = await store.get(taskId);
        signal?.throwIfAborted();
        return result(taskId, stateText(task), '已读取当前任务状态。', task.status);
      } },
  ];
}
