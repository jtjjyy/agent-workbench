import { mkdir, open, readFile, truncate } from 'node:fs/promises';
import { dirname } from 'node:path';
import { TextDecoder } from 'node:util';
import {
  type EventEnvelope,
  type EventStore,
  validateEventEnvelope,
} from '../../shared/contracts';

type Journal = {
  events: EventEnvelope[];
  truncateAt: number | null;
  needsNewline: boolean;
};

function isIncompleteObject(text: string, error: unknown): boolean {
  if (!(error instanceof SyntaxError) || !text.trimStart().startsWith('{')) {
    return false;
  }
  const message = error.message;
  const position = /at position (\d+)/.exec(message);
  // Only EOF parser errors are recoverable; malformed tokens remain corruption.
  return message.includes('Unexpected end of JSON input')
    || message.includes('Unterminated string in JSON')
    || (position !== null && Number(position[1]) >= text.trimEnd().length);
}

export class JsonlEventStore implements EventStore {
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  async append(event: EventEnvelope): Promise<void> {
    const validation = validateEventEnvelope(event);
    if (validation.ok === false) {
      throw new Error(`Invalid event: ${validation.error}`);
    }
    // Capture caller-owned values before this operation waits on earlier IO.
    const serialized = JSON.stringify(event);
    const snapshot: unknown = JSON.parse(serialized);
    const snapshotValidation = validateEventEnvelope(snapshot);
    if (snapshotValidation.ok === false) {
      throw new Error(`Invalid event: ${snapshotValidation.error}`);
    }
    const captured = snapshot as EventEnvelope;

    return this.serialize(async () => {
      const journal = await this.readJournal();
      const previous = journal.events.findLast(
        (record) => record.conversationId === captured.conversationId,
      );
      if (previous && captured.sequence <= previous.sequence) {
        throw new Error('Invalid event: sequence must strictly increase per conversation');
      }

      await mkdir(dirname(this.filePath), { recursive: true });
      if (journal.truncateAt !== null) {
        // Windows append-only handles cannot truncate an interrupted record.
        await truncate(this.filePath, journal.truncateAt);
      }
      const file = await open(this.filePath, 'a');
      try {
        const separator = journal.needsNewline ? '\n' : '';
        await file.writeFile(`${separator}${serialized}\n`, 'utf8');
      } finally {
        await file.close();
      }
    });
  }

  readAll(conversationId: string): Promise<EventEnvelope[]> {
    return this.serialize(async () => {
      const journal = await this.readJournal();
      return journal.events.filter((event) => event.conversationId === conversationId);
    });
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation);
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }

  private async readJournal(): Promise<Journal> {
    let bytes: Buffer;
    try {
      bytes = await readFile(this.filePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { events: [], truncateAt: null, needsNewline: false };
      }
      throw error;
    }

    const events: EventEnvelope[] = [];
    const sequences = new Map<string, number>();
    let start = 0;
    let line = 1;
    while (start < bytes.length) {
      const newline = bytes.indexOf(0x0a, start);
      const complete = newline !== -1;
      const end = complete ? newline : bytes.length;
      const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
      let text: string;
      try {
        text = decoder.decode(bytes.subarray(start, end), { stream: !complete });
      } catch (error) {
        throw new Error(`Invalid event journal at line ${line}: invalid UTF-8`, { cause: error });
      }
      let incompleteEncoding = false;
      if (!complete) {
        try {
          text += decoder.decode();
        } catch {
          incompleteEncoding = true;
        }
      }
      let value: unknown;
      try {
        value = JSON.parse(text);
      } catch (error) {
        if (!complete && isIncompleteObject(text, error)) {
          return { events, truncateAt: start, needsNewline: false };
        }
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(`Invalid event journal at line ${line}: malformed JSON: ${detail}`, {
          cause: error,
        });
      }
      if (incompleteEncoding) {
        throw new Error(`Invalid event journal at line ${line}: incomplete UTF-8 after JSON`);
      }

      const validation = validateEventEnvelope(value);
      if (validation.ok === false) {
        throw new Error(`Invalid event journal at line ${line}: ${validation.error}`);
      }
      const event = value as EventEnvelope;
      const previous = sequences.get(event.conversationId);
      if (previous !== undefined && event.sequence <= previous) {
        throw new Error(
          `Invalid event journal at line ${line}: sequence must strictly increase per conversation`,
        );
      }
      sequences.set(event.conversationId, event.sequence);
      events.push(event);

      if (!complete) {
        return { events, truncateAt: null, needsNewline: true };
      }
      start = newline + 1;
      line += 1;
    }
    return { events, truncateAt: null, needsNewline: false };
  }
}
