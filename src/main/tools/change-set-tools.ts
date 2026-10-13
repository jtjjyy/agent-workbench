import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core';
import { Type } from 'typebox';
import { CHANGE_SET_LIMITS, type ChangeIdentity } from '../../shared/change-set';
import type { AgentApprovalPublisher } from '../../shared/contracts';
import type { WorkspaceState } from '../../shared/workspace';
import { MAX_COMMAND_LENGTH, MAX_COMMAND_TIMEOUT_MS } from '../../shared/command';
import type { CommandApprovals } from '../agent/command-approvals';
import { ChangeSetService } from '../changes/change-set-service';
import { plainObject } from '../changes/change-set-policy';
import { WorkspacePolicyError } from '../workspace/workspace-session';

export interface ChangeSetToolContext {
  runId: string;
  taskId: string;
  commandApprovals: CommandApprovals;
  onApproval: AgentApprovalPublisher;
  onProgress?: (progress: { toolCallId: string; toolName: 'propose_change_set' | 'run_verification' | 'deliver_changes';
    summary: string; generation?: number }) => Promise<void>;
}

const options = { additionalProperties: false } as const;
const relative = Type.String({ minLength: 1, maxLength: 512 });
const hash = Type.String({ pattern: '^[a-f0-9]{64}$' });
const text = Type.String({ maxLength: CHANGE_SET_LIMITS.textLength });
const operation = Type.Union([
  Type.Object({ operation: Type.Literal('create'), path: relative, afterText: text }, options),
  Type.Object({ operation: Type.Literal('update'), path: relative, beforeSha256: hash, afterText: text }, options),
  Type.Object({ operation: Type.Literal('delete'), path: relative, beforeSha256: hash }, options),
  Type.Object({ operation: Type.Literal('rename'), path: relative, beforeSha256: hash, toPath: relative }, options),
]);
const changesSchema = Type.Object({ operations: Type.Array(operation,
  { minItems: 1, maxItems: CHANGE_SET_LIMITS.operations }) }, options);
const verifySchema = Type.Object({ command: Type.String({ minLength: 1, maxLength: MAX_COMMAND_LENGTH }),
  timeoutMs: Type.Optional(Type.Integer({ minimum: 1000, maximum: MAX_COMMAND_TIMEOUT_MS })) }, options);

function toolResult(summary: string, data: unknown, isError = false): AgentToolResult<Record<string, unknown>> {
  return { content: [{ type: 'text', text: JSON.stringify({ summary, data }) }],
    details: { summary, sources: [], data }, isError };
}

export function createChangeSetTools(workspace: WorkspaceState, service: ChangeSetService,
  context: ChangeSetToolContext): AgentTool[] {
  const selected = { ...workspace };
  const identity = (toolCallId: string): ChangeIdentity => ({ runId: context.runId, taskId: context.taskId, toolCallId });
  const progress = (toolCallId: string, toolName: 'propose_change_set' | 'run_verification' | 'deliver_changes',
    summary: string, generation?: number) => context.onProgress?.({ toolCallId, toolName, summary, generation });
  return [{ name: 'propose_change_set', label: '提出多文件变更', parameters: changesSchema,
    description: '提出 create/update/delete/rename UTF-8 文本批次。修改、删除、重命名必须带 beforeSha256；目标必须不存在。用户审阅完整差异并批准后逐项应用。返回逐项状态和哈希，禁止声称原子事务、自动回滚或未核对的交付完成。',
    executionMode: 'sequential', replay: 'never',
    execute: async (toolCallId, input, signal) => {
      if (!signal) throw new Error('变更工具缺少取消信号，操作未开始。');
      let parameters: Record<string, unknown>;
      try { parameters = plainObject(input, ['operations']); }
      catch { return toolResult('变更参数必须且只能包含 operations。', null, true); }
      let outcome;
      try {
        outcome = await service.request(selected, identity(toolCallId), parameters.operations, signal,
          (type, payload) => context.onApproval(type, payload));
      } catch (error) {
        // 参数/路径拒绝可供模型纠正；存储或发布失败必须原样传播，中止运行。
        if (error instanceof WorkspacePolicyError) return toolResult(error.message, null, true);
        throw error;
      }
      await progress(toolCallId, 'propose_change_set', outcome.summary, outcome.changeSet.generation);
      if (['unknown', 'partial'].includes(outcome.status)) {
        throw new Error('变更集存在部分或未知应用，已保存逐项结果；停止任务并人工核对，不自动重放。');
      }
      return toolResult(outcome.summary, outcome.changeSet, outcome.status !== 'applied');
    } }, {
    name: 'run_verification', label: '验证变更', parameters: verifySchema,
    description: '对当前变更代次申请一条具体 PowerShell 验证命令审批。默认策略禁止验证，不能用参数恢复。恢复后保存退出码、状态、尝试次数及脱敏输出供分析，最多三次失败修复。不得使用此工具提交或推送 Git。',
    executionMode: 'sequential', replay: 'never',
    execute: async (toolCallId, input, signal) => {
      if (!service.verificationPolicy.allowVerification) {
        return toolResult('验证策略暂停：未运行验证，不能宣称通过。', { status: 'not_run' });
      }
      if (!signal) throw new Error('验证工具缺少取消信号，操作未开始。');
      let outcome;
      try {
        const parameters = plainObject(input, ['command', 'timeoutMs'], ['command']);
        outcome = await service.runVerification(selected, identity(toolCallId), parameters.command as string,
          (parameters.timeoutMs ?? 30_000) as number, signal, context.commandApprovals,
          (type, payload) => context.onApproval(type, payload));
      } catch (error) {
        if (error instanceof WorkspacePolicyError) return toolResult(error.message, { status: 'not_run' });
        throw error;
      }
      await progress(toolCallId, 'run_verification', outcome.summary,
        'verification' in outcome ? outcome.verification.generation : undefined);
      if (outcome.status === 'unknown') throw new Error('验证命令结果未知，已保存证据；停止任务并人工核对，不自动重放。');
      // 验证失败也是有效证据，保持 isError=false，防止运行时抹掉输出与退出码。
      return toolResult(outcome.summary, outcome);
    } }, {
    name: 'deliver_changes', label: '核对本地交付', parameters: Type.Object({}, options),
    description: '复读当前文件哈希，列出变更及有效验证状态。仅本地交付，不提交或推送 Git；未验证、部分或未知应用不得声称任务完成。',
    executionMode: 'sequential', replay: 'never',
    execute: async (toolCallId, input, signal) => {
      let report;
      try {
        plainObject(input, []);
        report = await service.deliver(selected, identity(toolCallId), signal);
      } catch (error) {
        if (error instanceof WorkspacePolicyError) return toolResult(error.message, null, true);
        throw error;
      }
      const summary = report.canComplete ? '当前变更哈希与有效验证证据一致，可作为完成依据。'
        : '本地交付已核对，但完成条件未满足；请保留未验证或待处理状态。';
      await progress(toolCallId, 'deliver_changes', summary, report.generation);
      return toolResult(summary, report);
    } }];
}
