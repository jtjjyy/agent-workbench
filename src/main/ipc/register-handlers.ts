import { DEFAULT_CONVERSATION_ID, validateSubmitMessageRequest, type EventEnvelope, type SubmitMessageRequest, type SubmitMessageResult } from '../../shared/contracts';

export interface WindowEndpoint {
  id: number;
  mainFrame: { url: string };
  getURL(): string;
  isDestroyed(): boolean;
  send(channel: string, payload: EventEnvelope): void;
}
export interface CommandSource {
  sender: WindowEndpoint;
  senderFrame: { url: string } | null;
}
export interface IpcRegistry {
  handle(channel: string, listener: (source: CommandSource, input: unknown) => Promise<unknown>): void;
  removeHandler(channel: string): void;
}
export interface RuntimeCommands {
  readConversation(conversationId: string): Promise<EventEnvelope[]>;
  submit(request: SubmitMessageRequest): Promise<SubmitMessageResult>;
  subscribe(listener: (event: EventEnvelope) => void): () => void;
}

export function registerHandlers(
  ipc: IpcRegistry,
  coordinator: RuntimeCommands,
  window: WindowEndpoint,
  expectedUrl: string,
): () => void {
  // Chromium canonicalizes Forge's Windows file entry before exposing its URL.
  const trustedUrl = new URL(expectedUrl).href;
  const trustedWindow = () => !window.isDestroyed()
    && window.getURL() === trustedUrl && window.mainFrame.url === trustedUrl;
  const authorize = (source: CommandSource) => {
    if (source.sender !== window || source.senderFrame !== window.mainFrame || !trustedWindow()) {
      throw new Error('Untrusted IPC sender');
    }
  };
  ipc.handle('agent:read-conversation', async (source, input) => {
    authorize(source);
    if (input !== DEFAULT_CONVERSATION_ID) throw new Error('Unknown conversation');
    return coordinator.readConversation(input);
  });
  ipc.handle('agent:submit-message', async (source, input) => {
    authorize(source);
    const validation = validateSubmitMessageRequest(input);
    if (!validation.ok) throw new Error(`Invalid command: ${validation.error}`);
    const request = input as SubmitMessageRequest;
    if (request.conversationId !== DEFAULT_CONVERSATION_ID) throw new Error('Invalid command: unknown conversation');
    // Copy only permitted fields across the application boundary.
    return coordinator.submit({ conversationId: request.conversationId, clientRequestId: request.clientRequestId, text: request.text });
  });
  const unsubscribe = coordinator.subscribe((event) => {
    if (trustedWindow()) window.send('agent:event', event);
  });
  return () => {
    unsubscribe();
    ipc.removeHandler('agent:read-conversation');
    ipc.removeHandler('agent:submit-message');
  };
}
