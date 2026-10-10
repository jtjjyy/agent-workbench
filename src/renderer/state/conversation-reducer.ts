import { DEFAULT_CONVERSATION_ID, type EventEnvelope } from '../../shared/contracts';

export interface ConversationMessage {
  messageId: string;
  role: 'user' | 'agent';
  text: string;
  runId?: string;
  clientRequestId?: string;
  status: 'complete' | 'streaming' | 'failed';
}

export interface ConversationState {
  conversationId: string;
  messages: ConversationMessage[];
  events: EventEnvelope[];
  activeRunId: string | null;
  lastSequence: number;
  error: string | null;
  reloadRequired: boolean;
}

export function createConversationState(
  conversationId = DEFAULT_CONVERSATION_ID,
): ConversationState {
  return {
    conversationId,
    messages: [],
    events: [],
    activeRunId: null,
    lastSequence: 0,
    error: null,
    reloadRequired: false,
  };
}

export function conversationReducer(
  state: ConversationState,
  event: EventEnvelope,
): ConversationState {
  if (event.conversationId !== state.conversationId || state.reloadRequired) return state;
  if (event.schemaVersion !== 1) return requireReload(state);
  if (event.sequence <= state.lastSequence) return state;
  if (event.sequence !== state.lastSequence + 1) return requireReload(state);

  let messages = state.messages;
  let activeRunId = state.activeRunId;
  let error = state.error;

  switch (event.type) {
    case 'conversation.created':
      break;
    case 'message.user.created': {
      const payload = event.payload;
      if (!messages.some((message) =>
        message.messageId === payload.messageId
        || message.clientRequestId === payload.clientRequestId)) {
        messages = [...messages, {
          ...payload, role: 'user', status: 'complete',
        }];
      }
      break;
    }
    case 'run.started':
      activeRunId = event.payload.runId;
      error = null;
      break;
    case 'message.agent.created': {
      const payload = event.payload;
      if (activeRunId !== payload.runId) return requireReload(state);
      if (!messages.some((message) => message.messageId === payload.messageId)) {
        messages = [...messages, {
          ...payload, role: 'agent', text: '', status: 'streaming',
        }];
      }
      break;
    }
    case 'message.agent.delta': {
      const payload = event.payload;
      const target = messages.find((message) =>
        message.role === 'agent' && message.messageId === payload.messageId
        && message.runId === payload.runId && message.status === 'streaming');
      if (activeRunId !== payload.runId || !target) return requireReload(state);
      messages = messages.map((message) => message === target
        ? { ...message, text: message.text + payload.text }
        : message);
      break;
    }
    case 'run.completed':
      if (activeRunId === event.payload.runId) {
        const payload = event.payload;
        const target = messages.find((message) =>
          message.role === 'agent' && message.messageId === payload.messageId
          && message.runId === payload.runId);
        if (!target) return requireReload(state);
        activeRunId = null;
        messages = messages.map((message) => message === target
          ? { ...message, status: 'complete' }
          : message);
      }
      break;
    case 'run.failed':
      if (activeRunId === event.payload.runId) {
        activeRunId = null;
        error = 'Run failed.';
        messages = messages.map((message) =>
          message.role === 'agent' && message.runId === event.payload.runId
            ? { ...message, status: 'failed' }
            : message);
      }
      break;
    default:
      return requireReload(state);
  }

  return {
    ...state,
    messages,
    activeRunId,
    error,
    lastSequence: event.sequence,
    events: [...state.events, { ...event, payload: { ...event.payload } } as EventEnvelope],
  };
}

function requireReload(state: ConversationState): ConversationState {
  return {
    ...state,
    error: 'Conversation is out of sync. Reload required.',
    reloadRequired: true,
  };
}
