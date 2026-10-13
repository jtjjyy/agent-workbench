export const CHANGE_SET_VERSION = 1;
export const CHANGE_SET_LIMITS = {
  operations: 20, fileBytes: 32 * 1024, textLength: 12_000,
  batchBytes: 512 * 1024, approvalTtlMs: 60_000, records: 200,
  verificationRecords: 400, outputLength: 12_000, storeBytes: 8 * 1024 * 1024,
  repairAttempts: 3,
} as const;

export type ChangeOperation =
  | { operation: 'create'; path: string; afterText: string }
  | { operation: 'update'; path: string; beforeSha256: string; afterText: string }
  | { operation: 'delete'; path: string; beforeSha256: string }
  | { operation: 'rename'; path: string; toPath: string; beforeSha256: string };

export interface ChangeIdentity {
  runId: string;
  taskId: string;
  toolCallId: string;
}

export interface ChangeHashes {
  operation: ChangeOperation['operation'];
  path: string;
  toPath?: string;
  beforeSha256: string | null;
  afterSha256: string | null;
}

export interface ChangePreview extends ChangeHashes {
  beforeText: string | null;
  afterText: string | null;
}

export type ChangeItemStatus = 'pending' | 'not_applied' | 'applied' | 'conflict' | 'failed' | 'unknown';
export interface ChangeItemResult extends ChangeHashes {
  status: ChangeItemStatus;
  summary: string;
}
export type ChangeSetStatus = 'pending' | 'applying' | 'applied' | 'partial' | 'conflict'
  | 'failed' | 'unknown' | 'rejected' | 'expired' | 'cancelled';
export interface ChangeSetRecord extends ChangeIdentity {
  id: string;
  version: typeof CHANGE_SET_VERSION;
  workspaceRoot: string;
  rootIdentity: string;
  bindingDigest: string;
  approvalId: string;
  createdAt: string;
  expiresAt: string;
  updatedAt: string;
  generation: number;
  status: ChangeSetStatus;
  operations: ChangeItemResult[];
}

export interface PendingChangeSet extends ChangeIdentity {
  id: string;
  workspaceRoot: string;
  rootIdentity: string;
  approvalId: string;
  bindingDigest: string;
  expiresAt: string;
  operations: ChangePreview[];
}
export type ChangeApprovalDecision = 'approved' | 'rejected' | 'expired' | 'cancelled';
export interface DecideChangeSetRequest extends ChangeIdentity {
  id: string;
  approvalId: string;
  bindingDigest: string;
  decision: 'approved' | 'rejected';
}
export type DecideChangeSetResult = { ok: true } | { ok: false; code: 'APPROVAL_UNAVAILABLE' };
export interface ChangeSetOutcome {
  status: ChangeSetStatus;
  summary: string;
  changeSet: ChangeSetRecord;
}

export type ChangeSetEvent = 'change-set.approval.requested' | 'change-set.approval.decided'
  | 'change-set.applying' | 'change-set.completed';
// 事件不携带正文；完整预览通过本地 readPendingChangeSet 获取。
export interface ChangeSetEventPayload extends ChangeIdentity {
  id: string;
  approvalId: string;
  bindingDigest: string;
  expiresAt: string;
  decision?: ChangeApprovalDecision;
  status: ChangeSetStatus;
  generation: number;
}
export type PublishChangeSet = (type: ChangeSetEvent, payload: ChangeSetEventPayload) => Promise<void>;

export interface ChangeSetAccess {
  readPendingChangeSet(): Promise<PendingChangeSet | null>;
  decideChangeSet(request: DecideChangeSetRequest): Promise<DecideChangeSetResult>;
  readChangeSets(taskId?: string): Promise<ChangeSetRecord[]>;
  getDelivery?(taskId: string): Promise<ChangeDelivery>;
}

export interface VerificationPolicy { allowVerification: boolean }
export type VerificationStatus = 'running' | 'passed' | 'failed' | 'cancelled'
  | 'timed_out' | 'unknown' | 'rejected' | 'expired';
export interface VerificationRecord extends ChangeIdentity {
  id: string;
  workspaceRoot: string;
  rootIdentity: string;
  generation: number;
  snapshotDigest: string;
  command: string;
  timeoutMs: number;
  attempt: number;
  repairAttempt: number;
  startedAt: string;
  completedAt?: string;
  status: VerificationStatus;
  exitCode: number | null;
  output: string;
}
export type VerificationOutcome =
  | { status: 'not_run'; summary: string }
  | { status: VerificationStatus; summary: string; verification: VerificationRecord };

export interface DeliveryFile {
  path: string;
  expectedSha256: string | null;
  actualSha256: string | null;
  status: 'current' | 'conflict' | 'unknown';
}
export interface ChangeDelivery {
  taskId: string;
  workspaceRoot: string;
  generation: number;
  createdAt: string;
  changeSets: ChangeSetRecord[];
  files: DeliveryFile[];
  verification: 'not_run' | 'passed' | 'failed';
  verificationReason: string;
  evidence: VerificationRecord[];
  risks: string[];
  canComplete: boolean;
}

// 局部接口，集成方在受信任 IPC/preload 中实现；不依赖公共 AgentBridge。
export interface ChangeSetBridge extends ChangeSetAccess {
  readPendingChangeSet(): Promise<PendingChangeSet | null>;
  decideChangeSet(request: DecideChangeSetRequest): Promise<DecideChangeSetResult>;
  readChangeSets(taskId?: string): Promise<ChangeSetRecord[]>;
  getDelivery(taskId: string): Promise<ChangeDelivery>;
}
