import { describe, expect, it } from 'vitest';
import { DEFAULT_CONVERSATION_ID, type EventEnvelope, type EventPayloads, type EventType } from '../../shared/contracts';
import { conversationReducer, createConversationState } from './conversation-reducer';

function event<T extends EventType>(
  sequence: number,
  type: T,
  payload: EventPayloads[T],
): EventEnvelope<T> {
  return {
    schemaVersion: 1,
    eventId: `event-${sequence}`,
    conversationId: DEFAULT_CONVERSATION_ID,
    sequence,
    occurredAt: '2026-10-10T04:00:00.000Z',
    type,
    payload,
  } as EventEnvelope<T>;
}

const started = [
  event(1, 'conversation.created', { title: 'Conversation' }),
  event(2, 'message.user.created', { messageId: 'user-1', clientRequestId: 'request-1', text: 'Hello' }),
  event(3, 'run.started', { runId: 'run-1', sourceMessageId: 'user-1' }),
  event(4, 'message.agent.created', { messageId: 'agent-1', runId: 'run-1' }),
];

function replay(events: EventEnvelope[]) {
  return events.reduce(conversationReducer, createConversationState());
}

describe('conversationReducer', () => {
  it('replays ordered messages, streamed text, and one trace entry per sequence', () => {
    const state = replay([
      ...started,
      event(5, 'message.agent.delta', { messageId: 'agent-1', runId: 'run-1', text: 'First ' }),
      event(6, 'message.agent.delta', { messageId: 'agent-1', runId: 'run-1', text: 'reply' }),
    ]);
    expect(state.messages.map(({ role, text }) => ({ role, text }))).toEqual([
      { role: 'user', text: 'Hello' },
      { role: 'agent', text: 'First reply' },
    ]);
    expect(state.events.map(({ sequence }) => sequence)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(state.lastSequence).toBe(6);
    expect(state.activeRunId).toBe('run-1');
  });

  it('ignores duplicate and older sequences without duplicating text or trace', () => {
    const delta = event(5, 'message.agent.delta', { messageId: 'agent-1', runId: 'run-1', text: 'Once' });
    const state = replay([...started, delta]);
    expect(conversationReducer(state, delta)).toBe(state);
    expect(conversationReducer(state, started[1])).toBe(state);
    expect(state.messages[1]?.text).toBe('Once');
    expect(state.events).toHaveLength(5);
  });

  it('does not add the same user message or request twice at a new sequence', () => {
    const state = replay([
      ...started.slice(0, 2),
      event(3, 'message.user.created', { messageId: 'user-1', clientRequestId: 'request-1', text: 'Hello' }),
      event(4, 'message.user.created', { messageId: 'user-2', clientRequestId: 'request-1', text: 'Hello' }),
    ]);
    expect(state.messages).toHaveLength(1);
    expect(state.events).toHaveLength(4);
  });

  it('rejects a gap and freezes replay until history is reloaded', () => {
    const before = replay(started);
    const state = conversationReducer(before, event(6, 'message.agent.delta', {
      messageId: 'agent-1', runId: 'run-1', text: 'Missing chunk',
    }));
    expect(state.reloadRequired).toBe(true);
    expect(state.error).toBe('会话状态不同步，请重新加载。');
    expect(state.lastSequence).toBe(4);
    expect(state.events).toEqual(before.events);
    expect(state.messages[1].text).toBe('');
    expect(conversationReducer(state, event(5, 'message.agent.delta', {
      messageId: 'agent-1', runId: 'run-1', text: 'Late',
    }))).toBe(state);
  });

  it.each([
    { messageId: 'missing-agent', runId: 'run-1' },
    { messageId: 'agent-1', runId: 'wrong-run' },
    { messageId: 'user-1', runId: 'run-1' },
  ])('rejects a delta with an invalid target: %j', (target) => {
    const state = conversationReducer(replay(started), event(5, 'message.agent.delta', {
      ...target, text: 'Wrong target',
    }));
    expect(state.reloadRequired).toBe(true);
    expect(state.messages.map(({ text }) => text)).toEqual(['Hello', '']);
    expect(state.lastSequence).toBe(4);
  });

  it('clears the active run and marks its message complete on completion', () => {
    const state = replay([...started, event(5, 'run.completed', { runId: 'run-1', messageId: 'agent-1' })]);
    expect(state.activeRunId).toBeNull();
    expect(state.messages[1]?.status).toBe('complete');
    expect(state.error).toBeNull();
  });

  it('keeps prior text and the user message visible when a run fails', () => {
    const state = replay([
      ...started,
      event(5, 'message.agent.delta', { messageId: 'agent-1', runId: 'run-1', text: 'Partial' }),
      event(6, 'run.failed', { runId: 'run-1', code: 'PROVIDER_ERROR', message: 'Provider failed' }),
    ]);
    expect(state.activeRunId).toBeNull();
    expect(state.messages.map(({ text }) => text)).toEqual(['Hello', 'Partial']);
    expect(state.messages[1].status).toBe('failed');
    expect(state.error).toBe('任务未完成，你可以重新发送消息。');
    expect(state.reloadRequired).toBe(false);
    const next = conversationReducer(state, event(7, 'run.started', { runId: 'run-2', sourceMessageId: 'user-2' }));
    expect(next.error).toBeNull();
    expect(next.activeRunId).toBe('run-2');
  });

  it.each(['run.completed', 'run.failed'] as const)('does not clear an unrelated active run on %s', (type) => {
    const terminal = type === 'run.completed'
      ? event(5, type, { runId: 'other-run', messageId: 'other-agent' })
      : event(5, type, { runId: 'other-run', code: 'ERROR', message: 'Other failure' });
    const state = conversationReducer(replay(started), terminal);
    expect(state.activeRunId).toBe('run-1');
    expect(state.messages[1].status).toBe('streaming');
    expect(state.error).toBeNull();
  });

  it('never appends a later delta to a terminal message', () => {
    const state = replay([
      ...started,
      event(5, 'run.completed', { runId: 'run-1', messageId: 'agent-1' }),
      event(6, 'message.agent.delta', { runId: 'run-1', messageId: 'agent-1', text: 'Too late' }),
    ]);
    expect(state.reloadRequired).toBe(true);
    expect(state.messages[1].text).toBe('');
  });

  it('ignores a different conversation without changing sequence state', () => {
    const state = replay(started);
    const foreign = { ...event(5, 'conversation.created', { title: 'Other' }), conversationId: 'other' };
    expect(conversationReducer(state, foreign)).toBe(state);
  });

  it('fails closed on an unsupported event version', () => {
    const unsupported = { ...started[0], schemaVersion: 2 } as unknown as EventEnvelope;
    const state = conversationReducer(createConversationState(), unsupported);
    expect(state.reloadRequired).toBe(true);
    expect(state.events).toEqual([]);
  });

  it('does not mutate frozen state, messages, or input events', () => {
    const state = replay(started);
    state.messages.forEach(Object.freeze);
    state.events.forEach((entry) => {
      Object.freeze(entry.payload);
      Object.freeze(entry);
    });
    Object.freeze(state.messages);
    Object.freeze(state.events);
    Object.freeze(state);
    const delta = event(5, 'message.agent.delta', { runId: 'run-1', messageId: 'agent-1', text: 'New' });
    Object.freeze(delta.payload);
    Object.freeze(delta);
    const next = conversationReducer(state, delta);
    expect(next.messages[1]?.text).toBe('New');
    expect(state.messages[1].text).toBe('');
    expect(state.events).toHaveLength(4);
    expect(next.events).toHaveLength(5);
    expect(delta.payload.text).toBe('New');
  });
});
