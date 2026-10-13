export const DESKTOP_SCHEMA_VERSION = 1;
export const DESKTOP_BACKUP_FORMAT = 'agent-workbench-backup';

export const DESKTOP_ERROR_MESSAGES = {
  NOT_INITIALIZED: '桌面数据尚未初始化。',
  DATA_READ_FAILED: '无法读取桌面数据，已有文件已保留。',
  DATA_WRITE_FAILED: '无法保存桌面数据，请检查目录权限和剩余空间。',
  MIGRATION_FAILED: '旧数据迁移失败，原目录未修改，请关闭客户端后处理。',
  SETUP_REQUIRED: '请先保存模型设置，再完成首次配置。',
  SETTINGS_INVALID: '模型配置不可用，请打开模型设置处理。',
  RUN_ACTIVE: '存在活动任务或待处理请求，暂时无法执行此操作。',
  MAINTENANCE_UNAVAILABLE: '维护入口尚未接入，请稍后重试。',
  DIALOG_UNAVAILABLE: '文件选择入口尚未接入。',
  INVALID_BACKUP: '备份格式、版本、内容或校验值无效，当前数据未替换。',
  BACKUP_TOO_LARGE: '数据超过备份大小上限，请先归档历史记录。',
  UNSAFE_PATH: '检测到链接、特殊文件或不允许的路径，操作已停止。',
  BACKUP_FAILED: '本地备份失败，当前数据未替换。',
  RESTORE_FAILED: '恢复失败，请关闭客户端后重启；恢复前的数据备份已保留。',
  RESTART_REQUIRED: '本次恢复需要重启客户端才能继续使用。',
  DIAGNOSTICS_FAILED: '诊断信息导出失败。',
  STARTUP_FAILED: '桌面客户端启动失败，已有数据已保留。',
  SHUTDOWN_FAILED: '关闭时无法完整保存状态，下次启动需核对中断任务。',
} as const;

export type DesktopErrorCode = keyof typeof DESKTOP_ERROR_MESSAGES;
export type DesktopDataScope = 'settings' | 'tasks' | 'conversations' | 'memories' | 'skills';
export const DESKTOP_DATA_SCOPES: DesktopDataScope[] = ['settings', 'tasks', 'conversations', 'memories', 'skills'];
export const DESKTOP_SCOPE_LABELS: Record<DesktopDataScope, string> = {
  settings: '模型设置与密钥密文', tasks: '任务记录与交付证据', conversations: '历史会话',
  memories: '用户与项目记忆', skills: '技能启用设置',
};

export type DesktopMigrationStatus = 'none' | 'migrated' | 'skipped-existing' | 'failed';
export type DesktopStartupStage = 'data' | 'settings' | 'tasks' | 'runtime' | 'window' | 'ready';
export const DESKTOP_STARTUP_LABELS: Record<DesktopStartupStage, string> = {
  data: '本地数据初始化', settings: '模型设置加载', tasks: '任务记录加载',
  runtime: '运行服务初始化', window: '客户端窗口加载', ready: '启动完成',
};

export interface DesktopInfo {
  schemaVersion: 1;
  version: string;
  dataDir: string;
  initialized: boolean;
  setupCompleted: boolean;
  setupMode: 'mock' | 'deepseek' | null;
  configurationReady: boolean;
  configurationError: 'missing' | 'invalid' | 'unavailable' | null;
  migration: { status: DesktopMigrationStatus; backupPath: string | null };
  restartRequired: boolean;
  startupStage: DesktopStartupStage;
  lastError: DesktopErrorCode | null;
}

export interface DesktopBackupRequest { scopes: DesktopDataScope[] }
export type DesktopResult =
  | { ok: true; info: DesktopInfo; path?: string; safetyBackupPath?: string; restartRequired?: boolean }
  | { ok: false; code: DesktopErrorCode; safetyBackupPath?: string }
  | { ok: false; cancelled: true };

export interface DesktopBridge {
  readDesktopInfo(): Promise<DesktopInfo>;
  completeSetup(): Promise<DesktopResult>;
  exportDiagnostics(): Promise<DesktopResult>;
  backupDesktop(request: DesktopBackupRequest): Promise<DesktopResult>;
  restoreDesktop(): Promise<DesktopResult>;
}

export function validateDesktopBackupRequest(value: unknown): value is DesktopBackupRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return Object.keys(record).length === 1 && Array.isArray(record.scopes)
    && record.scopes.length > 0 && record.scopes.length <= DESKTOP_DATA_SCOPES.length
    && new Set(record.scopes).size === record.scopes.length
    && record.scopes.every((scope) => DESKTOP_DATA_SCOPES.includes(scope));
}
