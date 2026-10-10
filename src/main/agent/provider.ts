import type { AgentProvider } from '../../shared/contracts';

export function createDeterministicProvider(options: {
  chunkDelayMs?: number;
  failOnPrompt?: (text: string) => boolean;
} = {}): AgentProvider {
  const delay = options.chunkDelayMs ?? 35;
  if (!Number.isFinite(delay) || delay < 0) throw new Error('Invalid chunk delay');
  return {
    async streamReply(input, signal, onDelta) {
      signal.throwIfAborted();
      if (options.failOnPrompt?.(input.text)) throw new Error('Simulated provider failure');
      const response = `Local mock response: ${input.text}\n\nNo model, tools, or network requests were used.`;
      for (let offset = 0; offset < response.length; offset += 12) {
        signal.throwIfAborted();
        if (delay > 0) {
          await new Promise<void>((resolve, reject) => {
            const abort = () => {
              clearTimeout(timer);
              signal.removeEventListener('abort', abort);
              reject(new Error('Provider cancelled'));
            };
            const timer = setTimeout(() => {
              signal.removeEventListener('abort', abort);
              resolve();
            }, delay);
            signal.addEventListener('abort', abort, { once: true });
          });
        }
        signal.throwIfAborted();
        await onDelta(response.slice(offset, offset + 12));
      }
    },
  };
}
