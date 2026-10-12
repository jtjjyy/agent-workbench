export const MAX_EDIT_TEXT_LENGTH = 12_000;
export const MAX_EDIT_FILE_BYTES = 32 * 1024;
export const EDIT_APPROVAL_TTL_MS = 60_000;

export interface FileEditProposal {
  path: string;
  beforeText: string;
  afterText: string;
  beforeSha256: string;
  afterSha256: string;
}

export type EditOutcomeStatus = 'applied' | 'rejected' | 'expired' | 'cancelled' | 'conflict' | 'failed' | 'unknown';
export interface EditOutcome { status: EditOutcomeStatus; summary: string }
export type ApplyFileEdit = (signal: AbortSignal) => Promise<EditOutcome>;
export type FileEditHandler = (proposal: FileEditProposal, apply: ApplyFileEdit,
  signal: AbortSignal) => Promise<EditOutcome>;

export type ApprovalDecision = 'approved' | 'rejected' | 'expired' | 'cancelled';
export interface ApprovalIdentity {
  runId: string;
  toolCallId: string;
  approvalId: string;
  bindingDigest: string;
  path: string;
  beforeSha256: string;
  afterSha256: string;
}
export interface PendingFileEdit extends ApprovalIdentity, FileEditProposal {
  expiresAt: string;
}
export interface DecideFileEditRequest {
  conversationId: string;
  runId: string;
  approvalId: string;
  bindingDigest: string;
  decision: 'approved' | 'rejected';
}
export type DecideFileEditResult = { ok: true }
  | { ok: false; code: 'APPROVAL_UNAVAILABLE' | 'INVALID_APPROVAL_COMMAND' | 'JOURNAL_WRITE_FAILED' };
