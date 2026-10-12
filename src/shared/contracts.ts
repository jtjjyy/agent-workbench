import type { ModelSettingsResult, PublicModelSettings, SaveModelSettingsRequest } from './model-settings';
import type { WorkspaceState, WorkspaceResult, ToolProgress, ToolTrace, SourceEvidence } from './workspace';
import type { ApprovalIdentity, ApprovalDecision, EditOutcomeStatus, PendingFileEdit,
  DecideFileEditRequest, DecideFileEditResult, FileEditHandler } from './file-edit';
import type { KnowledgeSearchResult, KnowledgeState, ManagedMemory, MemoryScope,
  ProjectKnowledgeSummary } from './knowledge';
import type { SkillSelection, SkillSummary } from './skills';
import type { CommandApprovalResult, PendingCommandApproval } from './command';

export interface RunUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  totalTokens: number;
}

export interface RunMetadata {
  provider?: 'mock' | 'deepseek';
  model?: string;
}

export type EventType =
  | 'conversation.created'
  | 'message.user.created'
  | 'run.started'
  | 'message.agent.created'
  | 'message.agent.delta'
  | 'tool.started'
  | 'tool.completed'
  | 'approval.requested'
  | 'approval.decided'
  | 'command.approval.requested'
  | 'command.approval.decided'
  | 'file.edit.started'
  | 'file.edit.completed'
  | 'run.completed'
  | 'run.failed';

export type EventPayloads = {
  'conversation.created': { title: string };
  'message.user.created': {
    messageId: string;
    clientRequestId: string;
    text: string;
  };
  'run.started': { runId: string; sourceMessageId: string; workspaceAttached?: boolean } & RunMetadata;
  'message.agent.created': { messageId: string; runId: string };
  'message.agent.delta': { messageId: string; runId: string; text: string };
  'tool.started': { runId: string } & ToolTrace;
  'tool.completed': { runId: string; isError: boolean; durationMs: number; sources: SourceEvidence[] } & ToolTrace;
  'approval.requested': ApprovalIdentity & { expiresAt: string };
  'approval.decided': ApprovalIdentity & { decision: ApprovalDecision };
  'command.approval.requested': { runId: string; toolCallId: string; approvalId: string; bindingDigest: string;
    command: string; cwd: string; expiresAt: string };
  'command.approval.decided': { runId: string; toolCallId: string; approvalId: string; bindingDigest: string;
    command: string; cwd: string; decision: 'approved' | 'rejected' | 'expired' | 'cancelled' };
  'file.edit.started': ApprovalIdentity;
  'file.edit.completed': ApprovalIdentity & { status: EditOutcomeStatus };
  'run.completed': { runId: string; messageId: string; usage?: RunUsage;
    stopReason?: 'stop' | 'length'; durationMs?: number; modelRequestCount?: number; toolCallCount?: number } & RunMetadata;
  'run.failed': { runId: string; code: string; message: string };
};

export type EventEnvelope<T extends EventType = EventType> = {
  [K in T]: {
    schemaVersion: 1;
    eventId: string;
    conversationId: string;
    sequence: number;
    occurredAt: string;
    type: K;
    payload: EventPayloads[K];
  };
}[T];

export type SubmitMessageRequest = {
  conversationId: string;
  clientRequestId: string;
  text: string;
};

export const DEFAULT_CONVERSATION_ID = 'default';

export interface EventStore {
  append(event: EventEnvelope): Promise<void>;
  readAll(conversationId: string): Promise<EventEnvelope[]>;
}

export interface ContextTurn {
  user: string;
  assistant: string;
}

export interface ProviderReply extends RunMetadata {
  usage?: RunUsage;
  stopReason?: 'stop' | 'length';
  modelRequestCount?: number;
  toolCallCount?: number;
}

export interface AgentProvider {
  streamReply(
    input: { text: string; runId?: string; history?: ContextTurn[]; workspace?: WorkspaceState;
      knowledge?: import('./knowledge').KnowledgeAccess;
      skills?: SkillSelection;
      onTool?: (progress: ToolProgress) => Promise<void>;
      onApproval?: (type: 'command.approval.requested' | 'command.approval.decided', payload: any) => Promise<void>;
      onFileEdit?: (toolCallId: string, ...args: Parameters<FileEditHandler>) => ReturnType<FileEditHandler> },
    signal: AbortSignal,
    onDelta: (text: string) => Promise<void>,
  ): Promise<void | ProviderReply>;
}

// Transient command outcome, never a journal event. Success remains void.
export type SubmitMessageResult = void | {
  status: 'unavailable';
  code: 'JOURNAL_WRITE_FAILED';
};

export interface AgentBridge {
  readConversation(conversationId: string): Promise<EventEnvelope[]>;
  submitMessage(request: SubmitMessageRequest): Promise<SubmitMessageResult>;
  readModelSettings(): Promise<PublicModelSettings>;
  saveModelSettings(request: SaveModelSettingsRequest): Promise<ModelSettingsResult>;
  deleteModelApiKey(): Promise<ModelSettingsResult>;
  cancelRun(request: { conversationId: string; runId: string }): Promise<{ cancelled: boolean }>;
  readWorkspace(): Promise<WorkspaceState>;
  chooseWorkspace(): Promise<WorkspaceResult>;
  setWorkspaceConsent(request: { dataEgressConsent: boolean }): Promise<WorkspaceResult>;
  clearWorkspace(): Promise<WorkspaceResult>;
  readPendingFileEdit(): Promise<PendingFileEdit | null>;
  decideFileEdit(request: DecideFileEditRequest): Promise<DecideFileEditResult>;
  readPendingCommand(): Promise<PendingCommandApproval | null>;
  decideCommand(request: { conversationId: string; runId: string; approvalId: string; bindingDigest: string; decision: 'approved' | 'rejected' }): Promise<CommandApprovalResult>;
  readKnowledgeState(): Promise<KnowledgeState>;
  syncKnowledge(): Promise<KnowledgeState>;
  searchKnowledge(request: { query: string }): Promise<KnowledgeSearchResult[]>;
  readProjectKnowledge(): Promise<ProjectKnowledgeSummary | null>;
  readMemories(): Promise<ManagedMemory[]>;
  saveMemory(request: { scope: MemoryScope; content: string }): Promise<ManagedMemory | null>;
  deleteMemory(request: { id: string }): Promise<{ deleted: boolean }>;
  readSkills(): Promise<SkillSummary[]>;
  setSkillEnabled(request: { id: string; enabled: boolean }): Promise<SkillSummary[]>;
  onEvent(listener: (event: EventEnvelope) => void): () => void;
}

export type ValidationResult =
  | { ok: true }
  | { ok: false; error: string };

// Stage 1 prompts are limited to 20,000 UTF-16 code units, before trimming.
export const MAX_SUBMIT_TEXT_LENGTH = 20_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonblankString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function validatePrompt(text: unknown): ValidationResult {
  if (!isNonblankString(text)) {
    return { ok: false, error: 'text must be a nonblank string' };
  }
  if (text.length > MAX_SUBMIT_TEXT_LENGTH) {
    return { ok: false, error: 'text exceeds 20,000 UTF-16 code units' };
  }
  return { ok: true };
}

export function validateSubmitMessageRequest(input: unknown): ValidationResult {
  if (!isRecord(input)) {
    return { ok: false, error: 'SubmitMessageRequest must be an object' };
  }
  for (const field of ['conversationId', 'clientRequestId']) {
    if (!isNonblankString(input[field])) {
      return { ok: false, error: `${field} must be a nonblank string` };
    }
  }
  return validatePrompt(input.text);
}

const payloadFields: Record<EventType, readonly string[]> = {
  'conversation.created': ['title'],
  'message.user.created': ['messageId', 'clientRequestId', 'text'],
  'run.started': ['runId', 'sourceMessageId'],
  'message.agent.created': ['messageId', 'runId'],
  'message.agent.delta': ['messageId', 'runId', 'text'],
  'tool.started': ['runId', 'toolCallId', 'toolName', 'summary'],
  'tool.completed': ['runId', 'toolCallId', 'toolName', 'summary'],
  'approval.requested': ['runId', 'toolCallId', 'approvalId', 'bindingDigest', 'path', 'beforeSha256', 'afterSha256', 'expiresAt'],
  'approval.decided': ['runId', 'toolCallId', 'approvalId', 'bindingDigest', 'path', 'beforeSha256', 'afterSha256', 'decision'],
  'command.approval.requested': ['runId', 'toolCallId', 'approvalId', 'bindingDigest', 'command', 'cwd', 'expiresAt'],
  'command.approval.decided': ['runId', 'toolCallId', 'approvalId', 'bindingDigest', 'command', 'cwd', 'decision'],
  'file.edit.started': ['runId', 'toolCallId', 'approvalId', 'bindingDigest', 'path', 'beforeSha256', 'afterSha256'],
  'file.edit.completed': ['runId', 'toolCallId', 'approvalId', 'bindingDigest', 'path', 'beforeSha256', 'afterSha256', 'status'],
  'run.completed': ['runId', 'messageId'],
  'run.failed': ['runId', 'code', 'message'],
};

export function validateEventEnvelope(input: unknown): ValidationResult {
  if (!isRecord(input)) {
    return { ok: false, error: 'EventEnvelope must be an object' };
  }
  if (input.schemaVersion !== 1) {
    return { ok: false, error: 'schemaVersion must be 1' };
  }
  for (const field of ['eventId', 'conversationId']) {
    if (!isNonblankString(input[field])) {
      return { ok: false, error: `${field} must be a nonblank string` };
    }
  }
  if (!Number.isSafeInteger(input.sequence) || (input.sequence as number) < 0) {
    return { ok: false, error: 'sequence must be a nonnegative safe integer' };
  }
  if (!isNonblankString(input.occurredAt) || !Number.isFinite(Date.parse(input.occurredAt))) {
    return { ok: false, error: 'occurredAt must be a valid timestamp string' };
  }
  if (typeof input.type !== 'string' || !Object.hasOwn(payloadFields, input.type)) {
    return { ok: false, error: 'type must be a supported event type' };
  }
  if (!isRecord(input.payload)) {
    return { ok: false, error: 'payload must be an object' };
  }
  for (const field of payloadFields[input.type as EventType]) {
    if (typeof input.payload[field] !== 'string') {
      return { ok: false, error: `payload.${field} must be a string` };
    }
    if (field !== 'title' && field !== 'text' && field !== 'message'
      && !isNonblankString(input.payload[field])) {
      return { ok: false, error: `payload.${field} must be a nonblank string` };
    }
  }
  if (input.type === 'message.user.created') {
    return validatePrompt(input.payload.text);
  }
  if (input.type === 'tool.started' || input.type === 'tool.completed') {
    const { toolCallId, toolName, summary, isError, durationMs, sources } = input.payload;
    if ((toolCallId as string).length > 256 || (summary as string).length > 800
      || !['list_files', 'read_file', 'search_text', 'replace_text', 'search_knowledge', 'read_project_knowledge',
        'run_powershell', 'web_search', 'web_fetch', 'browser_open', 'browser_read', 'browser_screenshot',
        'browser_click', 'browser_type', 'unknown'].includes(toolName as string)) {
      return { ok: false, error: 'Invalid tool trace' };
    }
    if (input.type === 'tool.completed' && (typeof isError !== 'boolean'
      || !Number.isSafeInteger(durationMs) || (durationMs as number) < 0
      || !Array.isArray(sources) || sources.length > 12 || sources.some((source) => !validSource(source)))) {
      return { ok: false, error: 'Invalid tool outcome' };
    }
  }
  if (input.type === 'approval.requested' || input.type === 'approval.decided'
    || input.type === 'file.edit.started' || input.type === 'file.edit.completed') {
    const payload = input.payload;
    if (['runId', 'approvalId'].some((field) =>
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(payload[field] as string))
      || typeof payload.toolCallId !== 'string' || !payload.toolCallId.trim() || payload.toolCallId.length > 256
      || ['bindingDigest', 'beforeSha256', 'afterSha256'].some((field) => !/^[a-f0-9]{64}$/.test(payload[field] as string))
      || !validRelativePath(payload.path)
      || (input.type === 'approval.requested' && !Number.isFinite(Date.parse(payload.expiresAt as string)))
      || (input.type === 'approval.decided' && !['approved', 'rejected', 'expired', 'cancelled'].includes(payload.decision as string))
      || (input.type === 'file.edit.completed'
        && !['applied', 'rejected', 'expired', 'cancelled', 'conflict', 'failed', 'unknown'].includes(payload.status as string))
      || Object.hasOwn(payload, 'beforeText') || Object.hasOwn(payload, 'afterText')) {
      return { ok: false, error: 'Invalid file edit event' };
    }
  }
  if (input.type === 'command.approval.requested' || input.type === 'command.approval.decided') {
    const payload = input.payload;
    if (['runId', 'approvalId'].some((field) =>
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(payload[field] as string))
      || typeof payload.toolCallId !== 'string' || !payload.toolCallId.trim() || payload.toolCallId.length > 256
      || !/^[a-f0-9]{64}$/.test(payload.bindingDigest as string)
      || typeof payload.command !== 'string' || payload.command.length === 0 || payload.command.length > 8_000
      || typeof payload.cwd !== 'string' || payload.cwd.length === 0 || payload.cwd.length > 2_000
      || (input.type === 'command.approval.requested' && !Number.isFinite(Date.parse(payload.expiresAt as string)))
      || (input.type === 'command.approval.decided' && !['approved', 'rejected', 'expired', 'cancelled'].includes(payload.decision as string))) {
      return { ok: false, error: 'Invalid command approval event' };
    }
  }
  if (input.type === 'run.started' || input.type === 'run.completed') {
    const { provider, model, usage, stopReason, durationMs, workspaceAttached } = input.payload;
    if (workspaceAttached !== undefined && typeof workspaceAttached !== 'boolean') {
      return { ok: false, error: 'Invalid workspace metadata' };
    }
    if (provider !== undefined && provider !== 'mock' && provider !== 'deepseek') {
      return { ok: false, error: 'Invalid run provider' };
    }
    if (model !== undefined && (!isNonblankString(model) || model.length > 128)) {
      return { ok: false, error: 'Invalid run model' };
    }
    if (input.type === 'run.completed') {
      if (usage !== undefined && (!isRecord(usage)
        || ['inputTokens', 'outputTokens', 'cacheReadTokens', 'totalTokens'].some((field) =>
          !Number.isSafeInteger(usage[field]) || (usage[field] as number) < 0))) {
        return { ok: false, error: 'Invalid run usage' };
      }
      if (stopReason !== undefined && stopReason !== 'stop' && stopReason !== 'length') {
        return { ok: false, error: 'Invalid run stop reason' };
      }
      if (durationMs !== undefined && (!Number.isSafeInteger(durationMs) || (durationMs as number) < 0)) {
        return { ok: false, error: 'Invalid run duration' };
      }
      for (const field of ['modelRequestCount', 'toolCallCount']) {
        const count = input.payload[field];
        if (count !== undefined && (!Number.isSafeInteger(count) || (count as number) < 0 || (count as number) > 100)) {
          return { ok: false, error: 'Invalid run count' };
        }
      }
    }
  }
  return { ok: true };
}

function validRelativePath(input: unknown): input is string {
  return isNonblankString(input) && input.length <= 512 && !input.startsWith('/')
    && !/[\\:\u0000-\u001f\u007f-\u009f<>"|?*\u2028\u2029\u202a-\u202e\u2066-\u2069]/u.test(input)
    && input.split('/').every((part) => part !== '' && part !== '.' && part !== '..' && !/[. ]$/u.test(part));
}

function validSource(input: unknown): boolean {
  if (!isRecord(input) || !isNonblankString(input.path) || input.path.length > 512
    || input.path.startsWith('/') || input.path.includes('\\') || input.path.includes(':')
    || input.path.split('/').some((part) => !part || part === '.' || part === '..')
    || !Number.isSafeInteger(input.startLine) || (input.startLine as number) < 1
    || !Number.isSafeInteger(input.endLine) || (input.endLine as number) < (input.startLine as number)
    || typeof input.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(input.sha256)
    || typeof input.excerpt !== 'string' || input.excerpt.length > 240) return false;
  return true;
}
