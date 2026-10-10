import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { JsonlEventStore } from '../../src/main/events/event-store';
import { type EventEnvelope } from '../../src/shared/contracts';

function event(sequence: number, conversationId = 'conv-1'): EventEnvelope<'message.agent.delta'> {
  return {
    schemaVersion: 1,
    eventId: `${conversationId}-event-${sequence}`,
    conversationId,
    sequence,
    occurredAt: '2026-10-10T05:00:00.000Z',
    type: 'message.agent.delta',
    payload: {
      messageId: 'agent-1',
      runId: 'run-1',
      text: '  Hello\n\u4f60\u597d \u{1f600}  ',
    },
  };
}

const malformedStringTails = [
  { name: 'space in a partial Unicode escape', tail: '{"payload":{"text":"\\u12 ' },
  { name: 'tab in a partial Unicode escape', tail: '{"payload":{"text":"\\u12\t' },
  { name: 'nonhex digit in a partial Unicode escape', tail: '{"payload":{"text":"\\u12g' },
  { name: 'raw tab in an unterminated string', tail: '{"payload":{"text":"bad\t' },
  { name: 'raw carriage return in an unterminated string', tail: '{"payload":{"text":"bad\r' },
  { name: 'raw NUL in an unterminated string', tail: '{"payload":{"text":"bad\u0000' },
  { name: 'invalid escape in an unterminated string', tail: '{"payload":{"text":"bad\\x' },
  { name: 'escaped raw tab in an unterminated string', tail: '{"payload":{"text":"bad\\\t' },
];

describe('JsonlEventStore', () => {
  let directory: string;
  let filePath: string;
  let store: JsonlEventStore;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'agent-journal-'));
    filePath = join(directory, 'events.jsonl');
    store = new JsonlEventStore(filePath);
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it('returns an empty transcript for a missing file without creating it', async () => {
    await expect(store.readAll('conv-1')).resolves.toEqual([]);
    await expect(readFile(filePath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('round-trips exact values and writes one newline-terminated JSON record', async () => {
    const input = event(1);
    await store.append(input);
    await expect(readFile(filePath, 'utf8')).resolves.toBe(`${JSON.stringify(input)}\n`);
    expect(await store.readAll('conv-1')).toEqual([input]);
    expect(await new JsonlEventStore(filePath).readAll('conv-1')).toEqual([input]);
  });

  it('creates the supplied journal parent directory on first append', async () => {
    const nestedPath = join(directory, 'nested', 'events.jsonl');
    const nested = new JsonlEventStore(nestedPath);
    await nested.append(event(1));
    await expect(readFile(nestedPath, 'utf8')).resolves.toBe(`${JSON.stringify(event(1))}\n`);
  });

  it('filters conversations without changing physical append order or values', async () => {
    const first = event(1);
    const second = { ...event(4), occurredAt: '2026-10-09T05:00:00.000Z' };
    await store.append(first);
    await store.append(event(1, 'conv-2'));
    await store.append(second);
    expect(await store.readAll('conv-1')).toEqual([first, second]);
    expect(await store.readAll('conv-2')).toEqual([event(1, 'conv-2')]);
    expect(await store.readAll('unknown')).toEqual([]);
  });

  it('keeps concurrent appends whole and in invocation order', async () => {
    const inputs = Array.from({ length: 24 }, (_, index) => ({
      ...event(index + 1),
      payload: { ...event(index + 1).payload, text: `${index}:${'x'.repeat(64_000)}` },
    }));
    await Promise.all(inputs.map((input) => store.append(input)));
    await expect(readFile(filePath, 'utf8')).resolves.toBe(
      inputs.map((input) => `${JSON.stringify(input)}\n`).join(''),
    );
    const lines = (await readFile(filePath, 'utf8')).split('\n');
    expect(lines.pop()).toBe('');
    expect(lines.map((line) => JSON.parse(line))).toEqual(inputs);
    expect(await store.readAll('conv-1')).toEqual(inputs);
  });

  it('serializes reads with appends in invocation order', async () => {
    const firstAppend = store.append(event(1));
    const firstRead = store.readAll('conv-1');
    const secondAppend = store.append(event(2));
    const secondRead = store.readAll('conv-1');
    await Promise.all([firstAppend, secondAppend]);
    expect(await firstRead).toEqual([event(1)]);
    expect(await secondRead).toEqual([event(1), event(2)]);
  });

  it('snapshots append values before the caller mutates a queued event', async () => {
    const input = event(1);
    const append = store.append(input);
    input.sequence = 99;
    input.payload.text = 'changed after append';
    await append;
    expect(await store.readAll('conv-1')).toEqual([event(1)]);
  });

  it.each([
    '{',
    '{"schemaVersion":1,',
    '{"schemaVersion":1,"payload":tru',
    '{"schemaVersion":1,"payload":{"text":"unfinished',
    '{"schemaVersion":1,"payload":{"text":"\\u12',
  ])('ignores an incomplete final fragment without modifying the file (%#)', async (tail) => {
    const original = `${JSON.stringify(event(1))}\n${tail}`;
    await writeFile(filePath, original);
    expect(await store.readAll('conv-1')).toEqual([event(1)]);
    expect(await readFile(filePath, 'utf8')).toBe(original);
  });

  it.each([
    '{',
    '{"schemaVersion":1,',
    '{"schemaVersion":1,"payload":tru',
    '{"schemaVersion":1,"payload":{"text":"unfinished',
    '{"schemaVersion":1,"payload":{"text":"\\u12',
  ])('truncates an incomplete final fragment before future append (%#)', async (tail) => {
    await writeFile(filePath, `${JSON.stringify(event(1))}\n${tail}`);
    await store.append(event(2));
    expect(await readFile(filePath, 'utf8')).toBe(
      `${JSON.stringify(event(1))}\n${JSON.stringify(event(2))}\n`,
    );
    expect(await new JsonlEventStore(filePath).readAll('conv-1'))
      .toEqual([event(1), event(2)]);
  });

  it.each(malformedStringTails)('rejects replay of $name without altering bytes', async ({ tail }) => {
    const original = Buffer.from(`${JSON.stringify(event(1))}\n${tail}`);
    await writeFile(filePath, original);
    await expect(store.readAll('conv-1')).rejects.toThrow(/line 2.*malformed JSON/i);
    expect(await readFile(filePath)).toEqual(original);
  });

  it.each(malformedStringTails)('rejects append after $name without truncating bytes', async ({ tail }) => {
    const original = Buffer.from(`${JSON.stringify(event(1))}\n${tail}`);
    await writeFile(filePath, original);
    await expect(store.append(event(2))).rejects.toThrow(/line 2.*malformed JSON/i);
    expect(await readFile(filePath)).toEqual(original);
  });

  it.each(malformedStringTails)('rejects $name in completed and middle records', async ({ tail }) => {
    for (const suffix of ['\n', `\n${JSON.stringify(event(2))}\n{"payload":`]) {
      const original = Buffer.from(`${JSON.stringify(event(1))}\n${tail}${suffix}`);
      await writeFile(filePath, original);
      await expect(store.readAll('conv-1')).rejects.toThrow(/line 2.*malformed JSON/i);
      await expect(store.append(event(3))).rejects.toThrow(/line 2.*malformed JSON/i);
      expect(await readFile(filePath)).toEqual(original);
    }
  });

  it('recovers every byte prefix of a valid final object including escaped strings', async () => {
    const firstLine = Buffer.from(`${JSON.stringify(event(1))}\n`);
    const second = {
      ...event(2),
      payload: { ...event(2).payload, text: 'quote" slash\\ \b\f\n\r\t\u0000 \u4f60\u597d' },
      metadata: [-1.25e-7, true, false, null, {}],
    };
    const record = Buffer.from(JSON.stringify(second));
    for (let length = 1; length < record.length; length += 1) {
      const original = Buffer.concat([firstLine, record.subarray(0, length)]);
      await writeFile(filePath, original);
      expect(await store.readAll('conv-1'), `prefix length ${length}`).toEqual([event(1)]);
      expect(await readFile(filePath)).toEqual(original);
      await store.append(event(2));
      expect(await readFile(filePath, 'utf8')).toBe(
        `${JSON.stringify(event(1))}\n${JSON.stringify(event(2))}\n`,
      );
    }
  }, 30_000);

  it('recovers a partial first record before appending a new first event', async () => {
    await writeFile(filePath, '{"schemaVersion":');
    expect(await store.readAll('conv-1')).toEqual([]);
    await store.append(event(0));
    expect(await readFile(filePath, 'utf8')).toBe(`${JSON.stringify(event(0))}\n`);
  });

  it('uses byte offsets when recovering a tail cut inside a UTF-8 character', async () => {
    await writeFile(filePath, Buffer.concat([
      Buffer.from(`${JSON.stringify(event(1))}\n{"payload":{"text":"`),
      Buffer.from([0xf0, 0x9f]),
    ]));
    await store.append(event(2));
    expect(await readFile(filePath, 'utf8')).toBe(
      `${JSON.stringify(event(1))}\n${JSON.stringify(event(2))}\n`,
    );
  });

  it('preserves a valid final record without a newline before appending', async () => {
    await writeFile(filePath, JSON.stringify(event(1)));
    expect(await store.readAll('conv-1')).toEqual([event(1)]);
    await store.append(event(2));
    expect(await readFile(filePath, 'utf8')).toBe(
      `${JSON.stringify(event(1))}\n${JSON.stringify(event(2))}\n`,
    );
  });

  it('reads CRLF records and preserves their bytes on append', async () => {
    const original = `${JSON.stringify(event(1))}\r\n`;
    await writeFile(filePath, original);
    expect(await store.readAll('conv-1')).toEqual([event(1)]);
    await store.append(event(2));
    expect(await readFile(filePath, 'utf8')).toBe(`${original}${JSON.stringify(event(2))}\n`);
  });

  it.each([
    '{not-json}\n',
    '{"schemaVersion":1,\n',
    '\n',
    'null\n',
    '[]\n',
    '{}\n',
    `${JSON.stringify({ ...event(2), schemaVersion: 2 })}\n`,
    `${JSON.stringify({ ...event(2), payload: {} })}\n`,
  ])('rejects corrupted completed records instead of skipping them (%#)', async (record) => {
    const original = `${JSON.stringify(event(1))}\n${record}`;
    await writeFile(filePath, original);
    await expect(store.readAll('conv-1')).rejects.toThrow(/line 2/i);
    await expect(store.append(event(3))).rejects.toThrow(/line 2/i);
    expect(await readFile(filePath, 'utf8')).toBe(original);
  });

  it('rejects a malformed middle record even with a recoverable final tail', async () => {
    await writeFile(
      filePath,
      `${JSON.stringify(event(1))}\n{bad}\n${JSON.stringify(event(2))}\n{"payload":`,
    );
    await expect(store.readAll('conv-1')).rejects.toThrow(/line 2/i);
  });

  it.each([
    '{}',
    'null',
    '[]',
    JSON.stringify({ ...event(2), schemaVersion: 2 }),
    JSON.stringify({ ...event(2), payload: { messageId: 'agent-1', runId: 'run-1', text: 5 } }),
    '{not-json}',
    '{not-json',
    '{"schemaVersion":1,"payload":"bad\\x',
    '{"schemaVersion":1,"payload":{"text":"\\uXX\\u12',
  ])('rejects invalid completed final values without a newline (%#)', async (record) => {
    const original = `${JSON.stringify(event(1))}\n${record}`;
    await writeFile(filePath, original);
    await expect(store.readAll('conv-1')).rejects.toThrow(/line 2/i);
    await expect(store.append(event(3))).rejects.toThrow(/line 2/i);
    expect(await readFile(filePath, 'utf8')).toBe(original);
  });

  it('validates records in other conversations before filtering', async () => {
    await writeFile(filePath, [
      JSON.stringify(event(1)),
      JSON.stringify({ ...event(1, 'conv-2'), payload: {} }),
      '',
    ].join('\n'));
    await expect(store.readAll('conv-1')).rejects.toThrow(/line 2/i);
  });

  it.each(['\n', ''])('rejects invalid UTF-8 inside a completed record (%#)', async (ending) => {
    const original = Buffer.from(
      `${JSON.stringify(event(1))}\n${JSON.stringify(event(2))}${ending}`,
    );
    original[original.lastIndexOf('Hello')] = 0xff;
    await writeFile(filePath, original);
    await expect(store.readAll('conv-1')).rejects.toThrow(/line 2.*UTF-8/i);
    await expect(store.append(event(3))).rejects.toThrow(/line 2.*UTF-8/i);
    expect(await readFile(filePath)).toEqual(original);
  });

  it('rejects truncated UTF-8 after an otherwise complete final record', async () => {
    const original = Buffer.concat([
      Buffer.from(JSON.stringify(event(1))),
      Buffer.from([0xf0, 0x9f]),
    ]);
    await writeFile(filePath, original);
    await expect(store.readAll('conv-1')).rejects.toThrow(/line 1.*UTF-8/i);
    await expect(store.append(event(2))).rejects.toThrow(/line 1.*UTF-8/i);
    expect(await readFile(filePath)).toEqual(original);
  });

  it.each([1, 0])('rejects duplicate or decreasing sequences on append (%#)', async (sequence) => {
    await store.append(event(1));
    await expect(store.append(event(sequence))).rejects.toThrow(/sequence/i);
    expect(await store.readAll('conv-1')).toEqual([event(1)]);
    await store.append(event(2));
    expect(await store.readAll('conv-1')).toEqual([event(1), event(2)]);
  });

  it.each([1, 0])('rejects nonincreasing sequences in replay instead of sorting (%#)', async (sequence) => {
    await writeFile(filePath, [
      JSON.stringify(event(1)),
      JSON.stringify(event(1, 'conv-2')),
      JSON.stringify(event(sequence)),
      '',
    ].join('\n'));
    await expect(store.readAll('conv-1')).rejects.toThrow(/line 3.*sequence/i);
    await expect(store.readAll('conv-2')).rejects.toThrow(/line 3.*sequence/i);
  });

  it('checks persisted sequences after reopening the journal', async () => {
    await store.append(event(7));
    const reopened = new JsonlEventStore(filePath);
    await expect(reopened.append(event(7))).rejects.toThrow(/sequence/i);
    await reopened.append(event(10));
    expect(await reopened.readAll('conv-1')).toEqual([event(7), event(10)]);
  });

  it('does not repair a trailing fragment when the proposed append is invalid', async () => {
    const original = `${JSON.stringify(event(2))}\n{"payload":`;
    await writeFile(filePath, original);
    await expect(store.append(event(1))).rejects.toThrow(/sequence/i);
    expect(await readFile(filePath, 'utf8')).toBe(original);
  });

  it.each([
    null,
    {},
    { ...event(2), schemaVersion: 2 },
    { ...event(2), sequence: Number.NaN },
    { ...event(2), payload: {} },
  ])('runtime-validates appends without altering the journal (%#)', async (input) => {
    await writeFile(filePath, `${JSON.stringify(event(1))}\n`);
    const original = await readFile(filePath, 'utf8');
    await expect(store.append(input as EventEnvelope)).rejects.toThrow(/invalid event/i);
    expect(await readFile(filePath, 'utf8')).toBe(original);
    await store.append(event(2));
    expect(await store.readAll('conv-1')).toEqual([event(1), event(2)]);
  });

  it('does not swallow filesystem errors or poison subsequent queued operations', async () => {
    await mkdir(filePath);
    await expect(store.readAll('conv-1')).rejects.toBeInstanceOf(Error);
    await expect(store.append(event(1))).rejects.toBeInstanceOf(Error);
    await rm(filePath, { recursive: true });
    await store.append(event(1));
    expect(await store.readAll('conv-1')).toEqual([event(1)]);
  });
});
