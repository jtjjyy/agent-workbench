export const COMMAND_APPROVAL_TTL_MS = 60_000;
export const MAX_COMMAND_LENGTH = 8_000;
export const MAX_COMMAND_OUTPUT_LENGTH = 24_000;
export const MAX_COMMAND_TIMEOUT_MS = 120_000;

export type CommandApprovalDecision = 'approved' | 'rejected' | 'expired' | 'cancelled';
export type CommandOutcomeStatus = 'completed' | 'failed' | 'cancelled' | 'timed_out' | 'unknown';

export interface CommandApprovalIdentity {
  runId: string;
  toolCallId: string;
  approvalId: string;
  bindingDigest: string;
  command: string;
  cwd: string;
}

export interface PendingCommandApproval extends CommandApprovalIdentity {
  timeoutMs: number;
  expiresAt: string;
  risk: 'workspace' | 'network' | 'mutation' | 'elevated';
  preview?: string;
}

export type CommandApprovalResult = { ok: true }
  | { ok: false; code: 'APPROVAL_UNAVAILABLE' | 'INVALID_APPROVAL_COMMAND' | 'JOURNAL_WRITE_FAILED' };
