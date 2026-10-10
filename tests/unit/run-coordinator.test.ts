import { afterEach, expect, test } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDeterministicProvider } from '../../src/main/agent/provider';
import { RunCoordinator } from '../../src/main/agent/run-coordinator';
import { JsonlEventStore } from '../../src/main/events/event-store';
import type { EventEnvelope, EventStore } from '../../src/shared/contracts';

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});
const request = { conversationId: 'default', clientRequestId: 'req-1', text: 'Explain this project' };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
async function fixture(fail = false) {
  const directory = await mkdtemp(join(tmpdir(), 'awb-run-'));
  directories.push(directory);
  const store = new JsonlEventStore(join(directory, 'events.jsonl'));
  const provider = createDeterministicProvider({ chunkDelayMs: 0, failOnPrompt: (text) => fail && text === request.text });
  const coordinator = new RunCoordinator(store, provider);
  await coordinator.initialize();
  return { store, coordinator };
}

test('persists a full deterministic streamed run in contiguous event order', async () => {
  const { store, coordinator } = await fixture();
  await coordinator.submit(request);
  const events = await store.readAll('default');
  expect(events.slice(0, 4).map((event) => event.type)).toEqual([
    'conversation.created', 'message.user.created', 'run.started', 'message.agent.created',
  ]);
  const deltas = events.filter((event) => event.type === 'message.agent.delta');
  expect(deltas.length).toBeGreaterThan(1);
  expect(deltas.map((event) => event.payload.text).join('')).toBe(
    'Local mock response: Explain this project\n\nNo model, tools, or network requests were used.',
  );
  expect(events.at(-1)?.type).toBe('run.completed');
  expect(events.map((event) => event.sequence)).toEqual(events.map((_, index) => index + 1));
  expect(new Set(events.map((event) => event.eventId)).size).toBe(events.length);
});

test('deduplicates concurrent requests and reconstructs keys after restart', async () => {
  const { store, coordinator } = await fixture();
  await Promise.all([coordinator.submit(request), coordinator.submit(request)]);
  const restored = new RunCoordinator(store, createDeterministicProvider({ chunkDelayMs: 0 }));
  await restored.initialize();
  await restored.submit(request);
  expect((await store.readAll('default')).filter((event) => event.type === 'run.started')).toHaveLength(1);
  await restored.submit({ ...request, clientRequestId: 'req-2', text: 'Next' });
  const events = await store.readAll('default');
  expect(events.filter((event) => event.type === 'run.completed')).toHaveLength(2);
  expect(events.map((event) => event.sequence)).toEqual(events.map((_, index) => index + 1));
});

test('records provider failure and remains usable on the next prompt', async () => {
  const { store, coordinator } = await fixture(true);
  await coordinator.submit(request);
  expect((await store.readAll('default')).at(-1)?.type).toBe('run.failed');
  await coordinator.submit({ ...request, clientRequestId: 'req-2', text: 'Next' });
  expect((await store.readAll('default')).at(-1)?.type).toBe('run.completed');
});

test('rejects blank, oversized and non-default submissions before writing', async () => {
  const { store, coordinator } = await fixture();
  for (const invalid of [
    { ...request, text: '   ' }, { ...request, text: 'x'.repeat(20001) },
    { ...request, conversationId: 'other' }, { ...request, clientRequestId: '' },
  ]) await expect(coordinator.submit(invalid)).rejects.toThrow();
  expect(await store.readAll('default')).toHaveLength(1);
  await expect(coordinator.readConversation('other')).rejects.toThrow();
});

test.each(['run.completed', 'run.failed'] as const)('persists every event before broadcast, gating deltas and %s', async (terminal) => {
  const expectedTypes = [
    'conversation.created', 'message.user.created', 'run.started', 'message.agent.created',
    'message.agent.delta', 'message.agent.delta', terminal,
  ];
  const gates = expectedTypes.map(() => ({
    entered: deferred<EventEnvelope>(), release: deferred<void>(),
  }));
  const written: EventEnvelope[] = [];
  let attempts = 0;
  const store: EventStore = {
    async readAll() { return [...written]; },
    async append(event) {
      const gate = gates[attempts++];
      gate.entered.resolve(event);
      await gate.release.promise;
      written.push(event);
    },
  };
  const coordinator = new RunCoordinator(store, {
    async streamReply(_input, _signal, onDelta) {
      await onDelta('First');
      await onDelta(' second');
      if (terminal === 'run.failed') throw new Error('Provider failure');
    },
  });
  const observations: { event: EventEnvelope; persisted: boolean; sequences: number[] }[] = [];
  coordinator.subscribe((event) => {
    // No assertions here: the runtime intentionally isolates listener exceptions.
    observations.push({
      event, persisted: written.includes(event),
      sequences: written.map((record) => record.sequence),
    });
  });
  const pending = coordinator.submit(request);
  try {
    for (const [index, gate] of gates.entries()) {
      const event = await gate.entered.promise;
      await Promise.resolve();
      expect(event.type).toBe(expectedTypes[index]);
      expect(observations).toHaveLength(index);
      expect(written).toHaveLength(index);
      gate.release.resolve();
    }
    await pending;
    expect(observations).toHaveLength(7);
    expect(written).toHaveLength(7);
    expect(observations.map(({ event }) => event)).toEqual(written);
    expect(observations.map(({ event }) => event.type)).toEqual(expectedTypes);
    expect(observations.map(({ persisted }) => persisted)).toEqual(Array(7).fill(true));
    expect(observations.map(({ event }) => event.sequence)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(observations.map(({ sequences }) => sequences)).toEqual([
      [1], [1, 2], [1, 2, 3], [1, 2, 3, 4],
      [1, 2, 3, 4, 5], [1, 2, 3, 4, 5, 6], [1, 2, 3, 4, 5, 6, 7],
    ]);
  } finally {
    gates.forEach((gate) => gate.release.resolve());
    await pending;
  }
});

test.each([
  'conversation.created', 'message.user.created', 'run.started',
  'message.agent.created', 'message.agent.delta', 'run.completed', 'run.failed',
] as const)('returns a safe unavailable outcome on failed %s append and stays closed until restart', async (failedType) => {
  let writes = 0;
  const written: EventEnvelope[] = [];
  const store: EventStore = {
    async readAll() { return [...written]; },
    async append(event) {
      writes++;
      if (event.type === failedType) throw new Error('C:\\private\\API_KEY=secret');
      written.push(event);
    },
  };
  const coordinator = new RunCoordinator(store, createDeterministicProvider({
    chunkDelayMs: 0, failOnPrompt: () => failedType === 'run.failed',
  }));
  const published: EventEnvelope[] = [];
  coordinator.subscribe((event) => published.push(event));
  const unavailable = { status: 'unavailable', code: 'JOURNAL_WRITE_FAILED' };
  await expect(coordinator.submit(request)).resolves.toEqual(unavailable);
  const count = writes;
  await expect(coordinator.submit({ ...request, clientRequestId: 'req-2' })).resolves.toEqual(unavailable);
  expect(published).toEqual(written);
  expect(published.some((event) => event.type === failedType)).toBe(false);
  expect(published.some((event) => event.type === 'run.failed')).toBe(false);
  expect(writes).toBe(count);
});

test('initialization is idempotent and safely marks an interrupted run without replaying it', async () => {
  const { store } = await fixture();
  const sourceId = 'source';
  const runId = 'interrupted';
  const base = { schemaVersion: 1 as const, conversationId: 'default', occurredAt: new Date().toISOString() };
  await store.append({ ...base, eventId: 'e2', sequence: 2, type: 'message.user.created', payload: { messageId: sourceId, clientRequestId: 'old', text: 'Previous' } });
  await store.append({ ...base, eventId: 'e3', sequence: 3, type: 'run.started', payload: { runId, sourceMessageId: sourceId } });
  const restored = new RunCoordinator(store, createDeterministicProvider({ chunkDelayMs: 0 }));
  await Promise.all([restored.initialize(), restored.initialize()]);
  expect((await store.readAll('default')).at(-1)).toMatchObject({ type: 'run.failed', payload: { runId, code: 'RUN_INTERRUPTED' } });
  await restored.submit({ ...request, clientRequestId: 'old', text: 'Previous' });
  expect((await store.readAll('default')).filter((event) => event.type === 'run.started')).toHaveLength(1);
});

test('shutdown aborts a running local provider and leaves a terminal event', async () => {
  const { store, coordinator } = await fixture();
  let stop: Promise<void> | undefined;
  coordinator.subscribe((event) => { if (event.type === 'run.started') stop = coordinator.shutdown(); });
  await coordinator.submit(request);
  await stop;
  expect((await store.readAll('default')).at(-1)).toMatchObject({ type: 'run.failed', payload: { code: 'RUN_CANCELLED' } });
  await expect(coordinator.submit({ ...request, clientRequestId: 'req-2' })).rejects.toThrow();
});
