import { expect, test, vi } from 'vitest';
import { registerHandlers, type CommandSource, type IpcRegistry, type RuntimeCommands, type WindowEndpoint } from '../../src/main/ipc/register-handlers';
import type { EventEnvelope, SubmitMessageRequest } from '../../src/shared/contracts';

function fixture(expectedUrl?: string) {
  const handlers = new Map<string, (source: CommandSource, input: unknown) => Promise<unknown>>();
  const submissions: SubmitMessageRequest[] = [];
  const delivered: EventEnvelope[] = [];
  const frame = { url: expectedUrl ? new URL(expectedUrl).href : 'file:///app/main_window/index.html' };
  let eventListener: ((event: EventEnvelope) => void) | undefined;
  const window: WindowEndpoint = {
    id: 1, mainFrame: frame, getURL: () => frame.url, isDestroyed: () => false,
    send(channel, event) { expect(channel).toBe('agent:event'); delivered.push(event); },
  };
  const source: CommandSource = { sender: window, senderFrame: frame };
  const ipc: IpcRegistry = {
    handle(channel, listener) { handlers.set(channel, listener); },
    removeHandler(channel) { handlers.delete(channel); },
  };
  const history: EventEnvelope[] = [{
    schemaVersion: 1, sequence: 1, eventId: 'e1', conversationId: 'default',
    occurredAt: new Date().toISOString(), type: 'conversation.created', payload: { title: 'Test' },
  }];
  const runtime: RuntimeCommands = {
    async readConversation() { return history; },
    async submit(request) { submissions.push(request); },
    subscribe(listener) { eventListener = listener; return () => { eventListener = undefined; }; },
  };
  const dispose = registerHandlers(ipc, runtime, window, expectedUrl ?? frame.url);
  async function invoke(channel: string, input: unknown, from = source) {
    const handler = handlers.get(channel);
    if (!handler) throw new Error('Unknown IPC channel');
    return handler(from, input);
  }
  return { handlers, submissions, delivered, window, source, frame, invoke, dispose, runtime, emit: (event: EventEnvelope) => eventListener?.(event), history };
}
const request = { conversationId: 'default', clientRequestId: 'req-1', text: 'hello' };

test('forwards the transient unavailable submit outcome without publishing a journal event', async () => {
  const harness = fixture();
  const outcome = { status: 'unavailable', code: 'JOURNAL_WRITE_FAILED' } as const;
  vi.spyOn(harness.runtime, 'submit').mockResolvedValue(outcome);
  expect(await harness.invoke('agent:submit-message', request)).toEqual(outcome);
  expect(harness.delivered).toEqual([]);
});

test('accepts the canonical Chromium URL for a Windows Forge entry with spaces', async () => {
  const harness = fixture('file://D:\\Agent Workbench\\resources\\app.asar\\index.html');
  expect(harness.frame.url).toBe('file:///D:/Agent%20Workbench/resources/app.asar/index.html');
  expect(await harness.invoke('agent:read-conversation', 'default')).toEqual(harness.history);
  await harness.invoke('agent:submit-message', request);
  harness.emit(harness.history[0]);
  expect(harness.submissions).toEqual([request]);
  expect(harness.delivered).toEqual(harness.history);
  harness.frame.url += '?unexpected=1';
  await expect(harness.invoke('agent:submit-message', request)).rejects.toThrow('Untrusted IPC sender');
  harness.emit(harness.history[0]);
  expect(harness.delivered).toHaveLength(1);
});

test('registers only named commands and forwards valid typed requests', async () => {
  const harness = fixture();
  expect([...harness.handlers.keys()].sort()).toEqual(['agent:read-conversation', 'agent:submit-message']);
  await harness.invoke('agent:submit-message', request);
  expect(harness.submissions).toEqual([request]);
  expect(await harness.invoke('agent:read-conversation', 'default')).toEqual(harness.history);
  await expect(harness.invoke('arbitrary:shell', 'rm')).rejects.toThrow('Unknown IPC channel');
});

test('rejects invalid payloads at the actual registered boundary', async () => {
  const harness = fixture();
  for (const payload of [
    null, 'text', {}, { ...request, text: ' ' }, { ...request, text: 'x'.repeat(20001) },
    { ...request, text: 5 }, { ...request, clientRequestId: '' }, { ...request, conversationId: 'other' },
  ]) await expect(harness.invoke('agent:submit-message', payload)).rejects.toThrow('Invalid command');
  for (const id of [null, {}, 'other']) await expect(harness.invoke('agent:read-conversation', id)).rejects.toThrow('Unknown conversation');
  expect(harness.submissions).toHaveLength(0);
});

test('rejects different sender, child frame, missing frame and unexpected origin', async () => {
  const harness = fixture();
  for (const source of [
    { ...harness.source, sender: { ...harness.window, id: 2 } },
    { ...harness.source, senderFrame: { url: harness.frame.url } },
    { ...harness.source, senderFrame: null },
    { ...harness.source, sender: { ...harness.window, getURL: () => 'https://evil.invalid' } },
  ]) await expect(harness.invoke('agent:submit-message', request, source)).rejects.toThrow('Untrusted IPC sender');
  harness.frame.url = 'https://evil.invalid';
  await expect(harness.invoke('agent:read-conversation', 'default')).rejects.toThrow('Untrusted IPC sender');
  expect(harness.submissions).toHaveLength(0);
  expect(harness.delivered).toHaveLength(0);
});

test('forwards committed events only to a still-trusted window and disposes exact handlers', () => {
  const harness = fixture();
  harness.emit(harness.history[0]);
  expect(harness.delivered).toEqual(harness.history);
  harness.frame.url = 'https://evil.invalid';
  harness.emit(harness.history[0]);
  expect(harness.delivered).toHaveLength(1);
  harness.dispose();
  expect(harness.handlers.size).toBe(0);
  harness.emit(harness.history[0]);
  expect(harness.delivered).toHaveLength(1);
});
