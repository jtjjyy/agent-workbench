import type { EventType } from './contracts';
import type { SettingsErrorCode } from './model-settings';

export const APP_DISPLAY_NAME = '开发者智能体工作台';
export const UI_LOCALE = 'zh-CN';

export const EVENT_LABELS: Record<EventType, string> = {
  'command.approval.requested': '命令或浏览器交互等待审批',
  'command.approval.decided': '命令或浏览器审批决定已记录',
  'conversation.created': '会话已创建',
  'message.user.created': '用户消息已保存',
  'run.started': '任务已开始',
  'message.agent.created': '智能体消息已创建',
  'message.agent.delta': '回复内容已追加',
  'tool.started': '工具请求已记录',
  'tool.completed': '工具结果已记录',
  'approval.requested': '文件修改等待审批',
  'approval.decided': '审批决定已记录',
  'file.edit.started': '文件写入开始已记录',
  'file.edit.completed': '文件写入结果已记录',
  'run.completed': '任务已完成',
  'run.failed': '任务未完成',
};

export const SETTINGS_ERROR_MESSAGES: Record<SettingsErrorCode, string> = {
  INVALID_SETTINGS: '请检查模型、密钥、输出上限、超时时间和数据外发授权。',
  SECURE_STORAGE_UNAVAILABLE: '系统密钥加密不可用，无法使用已保存的密钥。',
  SETTINGS_READ_FAILED: '无法读取模型设置，已有数据已保留。',
  SETTINGS_WRITE_FAILED: '无法保存模型设置，请稍后重试。',
  API_KEY_REQUIRED: '请先在模型设置中添加 DeepSeek API 密钥。',
  RUN_ACTIVE: '请等待当前请求或任务结束后再修改设置。',
};

export const RUN_ERROR_MESSAGES = {
  API_KEY_REQUIRED: SETTINGS_ERROR_MESSAGES.API_KEY_REQUIRED,
  DATA_EGRESS_NOT_APPROVED: '请先在模型设置中同意将对话内容发送给 DeepSeek。',
  SECURE_STORAGE_UNAVAILABLE: SETTINGS_ERROR_MESSAGES.SECURE_STORAGE_UNAVAILABLE,
  SETTINGS_READ_FAILED: SETTINGS_ERROR_MESSAGES.SETTINGS_READ_FAILED,
  PROVIDER_AUTH_FAILED: 'DeepSeek 密钥验证失败，请在模型设置中更换密钥。',
  PROVIDER_BALANCE_REQUIRED: 'DeepSeek 账户余额不足，请检查账户余额。',
  PROVIDER_RATE_LIMITED: 'DeepSeek 请求达到频率限制，本次未自动重试，请稍后再试。',
  PROVIDER_REQUEST_REJECTED: 'DeepSeek 拒绝了请求或所选模型，请检查模型设置。',
  PROVIDER_UNAVAILABLE: 'DeepSeek 服务暂时不可用，本次未自动重试，请稍后再试。',
  PROVIDER_FAILED: '模型请求失败，本次未自动重试，你可以重新发送消息。',
  PROVIDER_INCOMPLETE: '模型回复未完整结束，你可以重新发送消息。',
  OUTPUT_LIMIT_REACHED: '回复达到本地长度上限，已保留生成的内容。',
  RUN_BUDGET_EXCEEDED: '任务达到模型请求、工具或上下文预算上限，已停止继续执行。',
  WORKSPACE_UNAVAILABLE: '工作区已不可用，本次未读取仓库，请重新选择目录。',
  FILE_EDIT_UNCONFIRMED: '文件修改结果未确认，任务已停止。请人工检查文件；不会自动重试或回滚。',
  RUN_TIMEOUT: '任务超过时间限制，已保留生成的内容，你可以重新发送消息。',
  RUN_CANCELLED: '任务已取消，已保留生成的内容。',
  RUN_INTERRUPTED: '上次任务已中断，未自动重新执行，你可以重新发送消息。',
  JOURNAL_WRITE_FAILED: '本地存储不可用，请重启工作台后再继续。',
} as const;

export function settingsErrorText(code: unknown): string {
  return typeof code === 'string' && Object.hasOwn(SETTINGS_ERROR_MESSAGES, code)
    ? SETTINGS_ERROR_MESSAGES[code as SettingsErrorCode] : '模型设置暂时不可用。';
}

export function runErrorText(code: string): string {
  return Object.hasOwn(RUN_ERROR_MESSAGES, code)
    ? RUN_ERROR_MESSAGES[code as keyof typeof RUN_ERROR_MESSAGES] : '任务未完成，你可以重新发送消息。';
}
