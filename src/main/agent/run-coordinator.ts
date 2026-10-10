import { randomUUID } from 'node:crypto';
import {
  DEFAULT_CONVERSATION_ID,
  validateSubmitMessageRequest,
  type AgentProvider,
  type EventEnvelope,
  type EventPayloads,
  type EventStore,
  type EventType,
  type SubmitMessageRequest,
  type SubmitMessageResult,
} from '../../shared/contracts';

export class RunCoordinator {
  private nextSequence = 1;
  private initialization: Promise<void> | undefined;
  private queue: Promise<void> = Promise.resolve();
  private readonly seen = new Map<string, string>();
  private readonly listeners = new Set<(event: EventEnvelope) => void>();
  private readonly abort = new AbortController();
  private storageFailed = false;
  private stopping = false;

  constructor(private readonly store: EventStore, private readonly provider: AgentProvider) {}

  initialize(): Promise<void> {
    return this.initialization ??= this.restore();
  }

  private async restore(): Promise<void> {
    const events = await this.store.readAll(DEFAULT_CONVERSATION_ID);
    const unfinished = new Set<string>();
    for (const event of events) {
      if (event.sequence !== this.nextSequence) throw new Error('Conversation journal has a sequence gap');
      this.nextSequence++;
      if (event.type === 'message.user.created') this.seen.set(event.payload.clientRequestId, event.payload.text);
      if (event.type === 'run.started') unfinished.add(event.payload.runId);
      if (event.type === 'run.completed' || event.type === 'run.failed') unfinished.delete(event.payload.runId);
    }
    if (events.length === 0) await this.persist('conversation.created', { title: 'Local conversation' });
    // An unfinished local response is marked interrupted, never automatically rerun.
    for (const runId of unfinished) {
      await this.persist('run.failed', { runId, code: 'RUN_INTERRUPTED', message: 'Previous run was interrupted. It was not replayed.' });
    }
  }

  async submit(request: SubmitMessageRequest): Promise<SubmitMessageResult> {
    const validation = validateSubmitMessageRequest(request);
    if (!validation.ok) throw new Error(validation.error);
    this.requireConversation(request.conversationId);
    try {
      await this.initialize();
      if (this.stopping || this.storageFailed) throw new Error('Runtime unavailable. Reopen the application.');
      const task = this.queue.then(() => this.run(request));
      this.queue = task.catch(() => {});
      await task;
    } catch (error) {
      if (this.storageFailed) return { status: 'unavailable', code: 'JOURNAL_WRITE_FAILED' };
      throw error;
    }
  }

  private async run(request: SubmitMessageRequest): Promise<void> {
    if (this.stopping || this.storageFailed) throw new Error('Runtime unavailable. Reopen the application.');
    const previous = this.seen.get(request.clientRequestId);
    if (previous !== undefined) {
      if (previous !== request.text) throw new Error('Request key already belongs to a different prompt');
      return;
    }
    const messageId = randomUUID();
    const runId = randomUUID();
    const agentMessageId = randomUUID();
    await this.persist('message.user.created', { messageId, clientRequestId: request.clientRequestId, text: request.text });
    this.seen.set(request.clientRequestId, request.text);
    await this.persist('run.started', { runId, sourceMessageId: messageId });
    await this.persist('message.agent.created', { messageId: agentMessageId, runId });
    try {
      await this.provider.streamReply({ text: request.text }, this.abort.signal, async (text) => {
        await this.persist('message.agent.delta', { messageId: agentMessageId, runId, text });
      });
      await this.persist('run.completed', { runId, messageId: agentMessageId });
    } catch (error) {
      if (this.storageFailed) throw error;
      await this.persist('run.failed', {
        runId,
        code: this.abort.signal.aborted ? 'RUN_CANCELLED' : 'PROVIDER_FAILED',
        message: this.abort.signal.aborted ? 'Run stopped during application shutdown.' : 'Local provider failed. You can submit another prompt.',
      });
    }
  }

  async readConversation(conversationId: string): Promise<EventEnvelope[]> {
    this.requireConversation(conversationId);
    await this.initialize();
    return this.store.readAll(conversationId);
  }

  private requireConversation(conversationId: string): void {
    if (conversationId !== DEFAULT_CONVERSATION_ID) throw new Error('Unknown conversation');
  }

  private async persist<T extends EventType>(type: T, payload: EventPayloads[T]): Promise<void> {
    const event = {
      schemaVersion: 1, eventId: randomUUID(), conversationId: DEFAULT_CONVERSATION_ID,
      sequence: this.nextSequence, occurredAt: new Date().toISOString(), type, payload,
    } as EventEnvelope;
    try {
      await this.store.append(event);
    } catch {
      this.storageFailed = true;
      throw new Error('Local journal write failed. Reopen the application before continuing.');
    }
    this.nextSequence++;
    for (const listener of this.listeners) {
      try { listener(event); } catch { console.error('Event subscriber failed'); }
    }
  }

  subscribe(listener: (event: EventEnvelope) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  async shutdown(): Promise<void> {
    this.stopping = true;
    this.abort.abort();
    await this.queue;
  }
}
