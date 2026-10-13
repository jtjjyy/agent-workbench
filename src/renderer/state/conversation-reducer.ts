import { DEFAULT_CONVERSATION_ID, type EventEnvelope, type EventPayloads } from '../../shared/contracts';
import { runErrorText } from '../../shared/zh-CN';

export interface ConversationMessage {
  messageId: string;
  role: 'user' | 'agent';
  text: string;
  runId?: string;
  clientRequestId?: string;
  status: 'complete' | 'streaming' | 'failed' | 'cancelled';
  usage?: EventPayloads['run.completed']['usage'];
  provider?: EventPayloads['run.completed']['provider'];
  model?: string;
  stopReason?: EventPayloads['run.completed']['stopReason'];
}

export interface ConversationState {
  conversationId: string;
  messages: ConversationMessage[];
  events: EventEnvelope[];
  activeRunId: string | null;
  runProvider?: EventPayloads['run.started']['provider'];
  runModel?: string;
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
  let runProvider = state.runProvider;
  let runModel = state.runModel;
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
      runProvider = event.payload.provider;
      runModel = event.payload.model;
      error = null;
      break;
    case 'message.agent.created': {
      const payload = event.payload;
      if (activeRunId !== payload.runId) return requireReload(state);
      if (!messages.some((message) => message.messageId === payload.messageId)) {
        messages = [...messages, {
          ...payload, role: 'agent', text: '', status: 'streaming',
          provider: runProvider, model: runModel,
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
    case 'tool.started':
    case 'tool.completed':
    case 'approval.requested':
    case 'approval.decided':
    case 'command.approval.requested':
    case 'command.approval.decided':
    case 'file.edit.started':
    case 'file.edit.completed':
    case 'change-set.approval.requested':
    case 'change-set.approval.decided':
    case 'change-set.applying':
    case 'change-set.completed':
      if (activeRunId !== event.payload.runId) return requireReload(state);
      break;
    case 'run.completed':
      if (activeRunId === event.payload.runId) {
        const payload = event.payload;
        const target = messages.find((message) =>
          message.role === 'agent' && message.messageId === payload.messageId
          && message.runId === payload.runId);
        if (!target) return requireReload(state);
        activeRunId = null;
        runProvider = payload.provider ?? runProvider;
        runModel = payload.model ?? runModel;
        messages = messages.map((message) => message === target
          ? {
            ...message, status: 'complete',
            usage: payload.usage ? { ...payload.usage } : undefined,
            provider: payload.provider ?? message.provider,
            model: payload.model ?? message.model,
            stopReason: payload.stopReason,
          }
          : message);
      }
      break;
    case 'run.failed':
      if (activeRunId === event.payload.runId) {
        activeRunId = null;
        error = ['RUN_CANCELLED', 'RUN_PAUSED'].includes(event.payload.code) ? null : runErrorText(event.payload.code);
        messages = messages.map((message) =>
          message.role === 'agent' && message.runId === event.payload.runId
            ? { ...message, status: event.payload.code === 'RUN_CANCELLED' ? 'cancelled' : 'failed' }
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
    runProvider,
    runModel,
    error,
    lastSequence: event.sequence,
    events: [...state.events, { ...event, payload: { ...event.payload } } as EventEnvelope],
  };
}

function requireReload(state: ConversationState): ConversationState {
  return {
    ...state,
    error: '会话状态不同步，请重新加载。',
    reloadRequired: true,
  };
}
