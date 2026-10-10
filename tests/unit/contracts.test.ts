import { describe, expect, it } from 'vitest';
import {
  type EventEnvelope,
  validateEventEnvelope,
  validateSubmitMessageRequest,
} from '../../src/shared/contracts';

const request = {
  conversationId: 'conv-1',
  clientRequestId: 'req-1',
  text: 'Explain this project',
};

const base = {
  schemaVersion: 1 as const,
  eventId: 'event-1',
  conversationId: 'conv-1',
  sequence: 1,
  occurredAt: '2026-10-10T05:00:00.000Z',
};

const events: EventEnvelope[] = [
  { ...base, type: 'conversation.created', payload: { title: 'Project' } },
  {
    ...base,
    type: 'message.user.created',
    payload: { messageId: 'user-1', clientRequestId: 'req-1', text: 'Explain' },
  },
  {
    ...base,
    type: 'run.started',
    payload: { runId: 'run-1', sourceMessageId: 'user-1' },
  },
  {
    ...base,
    type: 'message.agent.created',
    payload: { messageId: 'agent-1', runId: 'run-1' },
  },
  {
    ...base,
    type: 'message.agent.delta',
    payload: { messageId: 'agent-1', runId: 'run-1', text: 'Hello' },
  },
  {
    ...base,
    type: 'run.completed',
    payload: { runId: 'run-1', messageId: 'agent-1' },
  },
  {
    ...base,
    type: 'run.failed',
    payload: { runId: 'run-1', code: 'provider_error', message: 'Failed' },
  },
];

describe('validateSubmitMessageRequest', () => {
  it('accepts a valid command without normalizing values', () => {
    const input = { ...request, text: '  Explain\nthis project  ' };
    expect(validateSubmitMessageRequest(input)).toEqual({ ok: true });
    expect(input.text).toBe('  Explain\nthis project  ');
  });

  it.each([
    null,
    undefined,
    [],
    'request',
    {},
    { ...request, conversationId: '' },
    { ...request, conversationId: ' \t ' },
    { ...request, conversationId: 1 },
    { ...request, clientRequestId: '' },
    { ...request, clientRequestId: ' \n ' },
    { ...request, clientRequestId: false },
    { ...request, text: '' },
    { ...request, text: '   ' },
    { ...request, text: 123 },
    { ...request, text: null },
    { conversationId: 'conv-1', clientRequestId: 'req-1' },
  ])('rejects malformed commands (%#)', (input) => {
    expect(validateSubmitMessageRequest(input)).toMatchObject({
      ok: false,
      error: expect.any(String),
    });
  });

  it('accepts exactly 20,000 UTF-16 code units', () => {
    expect(validateSubmitMessageRequest({
      ...request,
      text: '\u{1f600}'.repeat(10_000),
    })).toEqual({ ok: true });
  });

  it('rejects over-limit input including whitespace before trimming', () => {
    expect(validateSubmitMessageRequest({
      ...request,
      text: ` ${'x'.repeat(20_000)}`,
    })).toMatchObject({ ok: false, error: expect.stringMatching(/20.?000/) });
  });

  it('counts supplementary characters as two UTF-16 code units', () => {
    expect(validateSubmitMessageRequest({
      ...request,
      text: '\u{1f600}'.repeat(10_001),
    })).toMatchObject({ ok: false });
  });
});

describe('validateEventEnvelope', () => {
  it.each(events)('accepts the payload for $type', (event) => {
    expect(validateEventEnvelope(event)).toEqual({ ok: true });
  });

  it.each([
    null,
    undefined,
    [],
    {},
    { ...events[0], schemaVersion: 2 },
    { ...events[0], schemaVersion: '1' },
    { ...events[0], eventId: '' },
    { ...events[0], eventId: '  ' },
    { ...events[0], eventId: 1 },
    { ...events[0], conversationId: '' },
    { ...events[0], conversationId: null },
    { ...events[0], sequence: -1 },
    { ...events[0], sequence: 1.5 },
    { ...events[0], sequence: Number.NaN },
    { ...events[0], sequence: Number.POSITIVE_INFINITY },
    { ...events[0], sequence: Number.MAX_SAFE_INTEGER + 1 },
    { ...events[0], sequence: '1' },
    { ...events[0], occurredAt: '' },
    { ...events[0], occurredAt: 'not-a-date' },
    { ...events[0], occurredAt: 123 },
    { ...events[0], type: 'unknown.event' },
    { ...events[0], type: 'toString' },
    { ...events[0], payload: null },
    { ...events[0], payload: [] },
    { ...events[0], payload: {} },
    { ...events[0], payload: { title: 1 } },
  ])('rejects invalid envelope fields (%#)', (input) => {
    expect(validateEventEnvelope(input)).toMatchObject({
      ok: false,
      error: expect.any(String),
    });
  });

  it('accepts sequence zero without taking over coordinator allocation', () => {
    expect(validateEventEnvelope({ ...events[0], sequence: 0 }))
      .toEqual({ ok: true });
  });

  it.each(events)('rejects missing or wrong-type fields in $type', (event) => {
    for (const field of Object.keys(event.payload)) {
      const payload = { ...event.payload } as Record<string, unknown>;
      delete payload[field];
      expect(validateEventEnvelope({ ...event, payload })).toMatchObject({ ok: false });
      payload[field] = 123;
      expect(validateEventEnvelope({ ...event, payload })).toMatchObject({ ok: false });
    }
  });

  it.each([
    { ...events[1], payload: { messageId: ' ', clientRequestId: 'req-1', text: 'Hi' } },
    { ...events[1], payload: { messageId: 'user-1', clientRequestId: '', text: 'Hi' } },
    { ...events[1], payload: { messageId: 'user-1', clientRequestId: 'req-1', text: ' ' } },
    { ...events[1], payload: { messageId: 'user-1', clientRequestId: 'req-1', text: 'x'.repeat(20_001) } },
    { ...events[2], payload: { runId: '', sourceMessageId: 'user-1' } },
    { ...events[2], payload: { runId: 'run-1', sourceMessageId: '' } },
    { ...events[3], payload: { messageId: '', runId: 'run-1' } },
    { ...events[4], payload: { messageId: 'agent-1', runId: '', text: 'Hi' } },
    { ...events[5], payload: { runId: 'run-1', messageId: '' } },
    { ...events[6], payload: { runId: 'run-1', code: '', message: 'Failed' } },
  ])('rejects blank identifiers and invalid user text (%#)', (input) => {
    expect(validateEventEnvelope(input)).toMatchObject({ ok: false });
  });

  it.each(['', ' \n ', '\u{1f600}\n\u4f60\u597d', 'x'.repeat(20_001)])(
    'preserves unrestricted agent delta text (%#)',
    (text) => {
      expect(validateEventEnvelope({
        ...events[4],
        payload: { messageId: 'agent-1', runId: 'run-1', text },
      })).toEqual({ ok: true });
    },
  );
});
