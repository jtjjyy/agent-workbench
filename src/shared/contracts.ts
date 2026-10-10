export type EventType =
  | 'conversation.created'
  | 'message.user.created'
  | 'run.started'
  | 'message.agent.created'
  | 'message.agent.delta'
  | 'run.completed'
  | 'run.failed';

export type EventPayloads = {
  'conversation.created': { title: string };
  'message.user.created': {
    messageId: string;
    clientRequestId: string;
    text: string;
  };
  'run.started': { runId: string; sourceMessageId: string };
  'message.agent.created': { messageId: string; runId: string };
  'message.agent.delta': { messageId: string; runId: string; text: string };
  'run.completed': { runId: string; messageId: string };
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

export interface AgentProvider {
  streamReply(
    input: { text: string },
    signal: AbortSignal,
    onDelta: (text: string) => Promise<void>,
  ): Promise<void>;
}

export interface AgentBridge {
  readConversation(conversationId: string): Promise<EventEnvelope[]>;
  submitMessage(request: SubmitMessageRequest): Promise<void>;
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
  return { ok: true };
}
