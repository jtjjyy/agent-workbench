// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createElement, StrictMode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_CONVERSATION_ID, type AgentBridge, type EventEnvelope, type SubmitMessageRequest } from '../../src/shared/contracts';
import { App } from '../../src/renderer/components/App';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

const history: EventEnvelope[] = [
  {
    schemaVersion: 1, eventId: 'event-1', conversationId: DEFAULT_CONVERSATION_ID,
    sequence: 1, occurredAt: '2026-10-10T04:00:00.000Z',
    type: 'conversation.created', payload: { title: 'Conversation' },
  },
  {
    schemaVersion: 1, eventId: 'event-2', conversationId: DEFAULT_CONVERSATION_ID,
    sequence: 2, occurredAt: '2026-10-10T04:00:01.000Z',
    type: 'message.user.created',
    payload: { messageId: 'user-1', clientRequestId: 'request-1', text: 'Hello' },
  },
  {
    schemaVersion: 1, eventId: 'event-3', conversationId: DEFAULT_CONVERSATION_ID,
    sequence: 3, occurredAt: '2026-10-10T04:00:02.000Z',
    type: 'run.started', payload: { runId: 'run-1', sourceMessageId: 'user-1' },
  },
  {
    schemaVersion: 1, eventId: 'event-4', conversationId: DEFAULT_CONVERSATION_ID,
    sequence: 4, occurredAt: '2026-10-10T04:00:03.000Z',
    type: 'message.agent.created', payload: { runId: 'run-1', messageId: 'agent-1' },
  },
  {
    schemaVersion: 1, eventId: 'event-5', conversationId: DEFAULT_CONVERSATION_ID,
    sequence: 5, occurredAt: '2026-10-10T04:00:04.000Z',
    type: 'message.agent.delta', payload: { runId: 'run-1', messageId: 'agent-1', text: 'First' },
  },
  {
    schemaVersion: 1, eventId: 'event-6', conversationId: DEFAULT_CONVERSATION_ID,
    sequence: 6, occurredAt: '2026-10-10T04:00:05.000Z',
    type: 'message.agent.delta', payload: { runId: 'run-1', messageId: 'agent-1', text: ' reply' },
  },
  {
    schemaVersion: 1, eventId: 'event-7', conversationId: DEFAULT_CONVERSATION_ID,
    sequence: 7, occurredAt: '2026-10-10T04:00:06.000Z',
    type: 'run.completed', payload: { runId: 'run-1', messageId: 'agent-1' },
  },
];

function bridgeFixture(initial: EventEnvelope[] = []) {
  const listeners = new Set<(event: EventEnvelope) => void>();
  const calls: string[] = [];
  const requests: SubmitMessageRequest[] = [];
  const unsubscribe = vi.fn();
  const bridge: AgentBridge = {
    readConversation: vi.fn(async (conversationId) => {
      calls.push(`read:${conversationId}`);
      return initial;
    }),
    submitMessage: vi.fn(async (request) => { requests.push(request); }),
    onEvent: vi.fn((listener) => {
      calls.push('subscribe');
      listeners.add(listener);
      return () => {
        unsubscribe();
        listeners.delete(listener);
      };
    }),
  };
  vi.stubGlobal('agent', bridge);
  return {
    bridge, calls, requests, listeners, unsubscribe,
    emit(event: EventEnvelope) {
      act(() => { listeners.forEach((listener) => listener(event)); });
    },
  };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function ready() {
  await waitFor(() => {
    expect(screen.queryByRole('textbox', { name: 'Message' })).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Message' })).toBeEnabled();
  });
}

describe('App', () => {
  it('subscribes before reading the shared default conversation and restores transcript', async () => {
    const fixture = bridgeFixture(history);
    render(createElement(App));
    await ready();
    expect(fixture.calls).toEqual(['subscribe', `read:${DEFAULT_CONVERSATION_ID}`]);
    expect(screen.getByRole('heading', { name: 'Agent Workbench' })).toBeInTheDocument();
    expect(screen.getByText('Hello')).toBeInTheDocument();
    expect(screen.getByText('First reply')).toBeInTheDocument();
    const trace = screen.getByRole('region', { name: 'Event trace' });
    expect(within(trace).getAllByRole('listitem')).toHaveLength(7);
    expect(within(trace).getByText('run.completed')).toBeInTheDocument();
  });

  it('buffers startup events, sorts overlap, and deduplicates history and live deltas', async () => {
    const fixture = bridgeFixture();
    const read = deferred<EventEnvelope[]>();
    fixture.bridge.readConversation = vi.fn(() => read.promise);
    render(createElement(App));
    expect(screen.queryByRole('textbox', { name: 'Message' })).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Message' })).toBeDisabled();
    fixture.emit(history[5]);
    fixture.emit(history[4]);
    fixture.emit(history[6]);
    await act(async () => { read.resolve([...history.slice(0, 6)].reverse()); });
    await ready();
    expect(screen.getByText('First reply')).toBeInTheDocument();
    expect(within(screen.getByRole('region', { name: 'Event trace' })).getAllByRole('listitem')).toHaveLength(7);
    fixture.emit(history[5]);
    expect(screen.getByText('First reply')).toBeInTheDocument();
  });

  it('disposes the subscription and ignores a history promise settled after unmount', async () => {
    const fixture = bridgeFixture();
    const read = deferred<EventEnvelope[]>();
    fixture.bridge.readConversation = vi.fn(() => read.promise);
    const view = render(createElement(App));
    expect(fixture.listeners.size).toBe(1);
    view.unmount();
    expect(fixture.unsubscribe).toHaveBeenCalledTimes(1);
    expect(fixture.listeners.size).toBe(0);
    await act(async () => { read.resolve(history); });
    expect(screen.queryByText('First reply')).not.toBeInTheDocument();
  });

  it('isolates subscriptions and pending reads across StrictMode effect remounts', async () => {
    const fixture = bridgeFixture();
    const first = deferred<EventEnvelope[]>();
    const second = deferred<EventEnvelope[]>();
    fixture.bridge.readConversation = vi.fn()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);
    render(createElement(StrictMode, null, createElement(App)));
    expect(fixture.listeners.size).toBe(1);
    await act(async () => { second.resolve(history); });
    await ready();
    await act(async () => { first.resolve([]); });
    expect(screen.getByText('First reply')).toBeInTheDocument();
    expect(fixture.unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('retains one UUID and blocks overlapping submissions until the request settles', async () => {
    const fixture = bridgeFixture();
    const pending = deferred<void>();
    fixture.bridge.submitMessage = vi.fn(async (request) => {
      fixture.requests.push(request);
      await pending.promise;
    });
    render(createElement(App));
    await ready();
    const input = screen.getByRole('textbox', { name: 'Message' });
    fireEvent.change(input, { target: { value: '  Explain\nthis  ' } });
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true });
    expect(fixture.requests).toHaveLength(0);
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(fixture.requests).toHaveLength(1);
    expect(fixture.requests[0]).toMatchObject({
      conversationId: DEFAULT_CONVERSATION_ID, text: 'Explain\nthis',
      clientRequestId: expect.stringMatching(/^[0-9a-f-]{36}$/),
    });
    const id = fixture.requests[0].clientRequestId;
    expect(input).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Send message' })).toBeDisabled();
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(fixture.requests).toHaveLength(1);
    await act(async () => { pending.resolve(); });
    await ready();
    expect(input).toHaveValue('');
    fireEvent.change(input, { target: { value: 'Next' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
    await waitFor(() => expect(fixture.requests).toHaveLength(2));
    expect(fixture.requests[1].clientRequestId).not.toBe(id);
  });

  it('keeps the draft, shows a safe submission error, and allows another attempt', async () => {
    const fixture = bridgeFixture();
    fixture.bridge.submitMessage = vi.fn().mockRejectedValueOnce(new Error('C:\\private\\token=secret'))
      .mockResolvedValueOnce(undefined);
    render(createElement(App));
    await ready();
    const input = screen.getByRole('textbox', { name: 'Message' });
    fireEvent.change(input, { target: { value: 'Keep this draft' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/could not send/i));
    expect(screen.getByRole('alert')).not.toHaveTextContent(/private|secret/);
    expect(input).toHaveValue('Keep this draft');
    expect(input).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
    await waitFor(() => expect(input).toHaveValue(''));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('fails closed on history errors and reloads without duplicate subscriptions', async () => {
    const fixture = bridgeFixture(history);
    fixture.bridge.readConversation = vi.fn().mockRejectedValueOnce(new Error('API_KEY=secret'))
      .mockResolvedValueOnce(history);
    render(createElement(App));
    await waitFor(() => {
      expect(screen.queryByRole('alert')).toBeInTheDocument();
      expect(screen.getByRole('alert')).toHaveTextContent(/could not load/i);
    });
    expect(screen.getByRole('alert')).not.toHaveTextContent('secret');
    expect(screen.getByRole('textbox', { name: 'Message' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Reload conversation' }));
    await ready();
    expect(screen.getByText('First reply')).toBeInTheDocument();
    expect(fixture.listeners.size).toBe(1);
    expect(fixture.unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('disables input while a run is active and recovers after a streamed failure', async () => {
    const fixture = bridgeFixture(history.slice(0, 6));
    render(createElement(App));
    await waitFor(() => expect(screen.queryByText('First reply')).toBeInTheDocument());
    expect(screen.getByRole('textbox', { name: 'Message' })).toBeDisabled();
    expect(screen.getByRole('status')).toHaveTextContent(/running/i);
    fixture.emit({
      ...history[6], type: 'run.failed',
      payload: { runId: 'run-1', code: 'PROVIDER_ERROR', message: 'Provider failed' },
    });
    await ready();
    expect(screen.getByRole('alert')).toHaveTextContent(/failed/i);
    expect(screen.getByText('Hello')).toBeInTheDocument();
    expect(screen.getByText('First reply')).toBeInTheDocument();
  });

  it('shows a reload action and blocks submission after a live sequence gap', async () => {
    const fixture = bridgeFixture(history.slice(0, 4));
    render(createElement(App));
    await waitFor(() => expect(screen.queryByText('Hello')).toBeInTheDocument());
    fixture.emit(history[5]);
    expect(screen.getByRole('alert')).toHaveTextContent(/reload/i);
    expect(screen.getByRole('button', { name: 'Reload conversation' })).toBeEnabled();
    expect(screen.getByRole('textbox', { name: 'Message' })).toBeDisabled();
  });

  it('renders trace metadata only, never raw payload, event IDs or conversation titles', async () => {
    const fixture = bridgeFixture([{
      ...history[0], type: 'conversation.created',
      eventId: 'SECRET_EVENT_ID', payload: { title: 'C:\\private\\API_KEY=secret' },
    }]);
    render(createElement(App));
    await ready();
    const trace = screen.getByRole('region', { name: 'Event trace' });
    expect(trace).toHaveTextContent('conversation.created');
    expect(trace.querySelector('time')).toHaveAttribute('datetime', '2026-10-10T04:00:00.000Z');
    expect(document.body).not.toHaveTextContent(/private|API_KEY|SECRET_EVENT_ID/);
    fixture.emit({
      ...history[1], type: 'message.user.created',
      payload: {
        messageId: 'user-1', clientRequestId: 'request-1',
        text: '<script>alert("bad")</script>',
      },
    });
    expect(document.querySelector('script')).toBeNull();
    expect(screen.getByText('<script>alert("bad")</script>')).toBeInTheDocument();
  });

  it('handles a missing bridge without crashing or offering fake availability', () => {
    vi.stubGlobal('agent', undefined);
    render(createElement(App));
    expect(screen.getByRole('heading', { name: 'Agent Workbench' })).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent(/unavailable/i);
    expect(screen.getByRole('textbox', { name: 'Message' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Send message' })).toBeDisabled();
  });

  it('keeps blank drafts disabled and ignores composing Enter keystrokes', async () => {
    const fixture = bridgeFixture();
    render(createElement(App));
    await ready();
    const input = screen.getByRole('textbox', { name: 'Message' });
    fireEvent.change(input, { target: { value: '   ' } });
    expect(screen.getByRole('button', { name: 'Send message' })).toBeDisabled();
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(fixture.requests).toHaveLength(0);
    fireEvent.change(input, { target: { value: 'Draft' } });
    fireEvent.keyDown(input, { key: 'Enter', isComposing: true });
    expect(fixture.requests).toHaveLength(0);
    expect(screen.getByRole('button', { name: 'Send message' })).toHaveAttribute('title', 'Send message');
  });
});
