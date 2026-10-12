import { stream } from '@earendil-works/pi-ai/api/openai-completions';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai/utils/event-stream';
import type { AssistantMessage, Model } from '@earendil-works/pi-ai';
import type { StreamFn } from '@earendil-works/pi-agent-core';
import type { RunUsage } from '../../shared/contracts';
import { DEEPSEEK_BASE_URL, type ModelSettings } from '../../shared/model-settings';
import { ProviderError, providerStatusCode, type ProviderErrorCode } from './provider-errors';

export function deepseekModel(settings: ModelSettings): Model<'openai-completions'> {
  // Pi 要求定价结构；这里的零值不是实测费用，不向客户端报告为免费。
  return {
    id: settings.model, name: settings.model, provider: 'deepseek', api: 'openai-completions',
    baseUrl: DEEPSEEK_BASE_URL, reasoning: false, input: ['text'],
    contextWindow: 1_000_000, maxTokens: 393_216,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    compat: { supportsStore: false, supportsDeveloperRole: false, supportsUsageInStreaming: true,
      maxTokensField: 'max_tokens', thinkingFormat: 'deepseek' },
  };
}

export const EMPTY_PI_USAGE = {
  input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function rawUsage(value: unknown): RunUsage | undefined {
  if (!value || typeof value !== 'object') return;
  const usage = (value as { usage?: Record<string, unknown> }).usage;
  if (!usage || typeof usage !== 'object') return;
  const { prompt_tokens: inputTokens, completion_tokens: outputTokens, total_tokens: totalTokens } = usage;
  if (![inputTokens, outputTokens, totalTokens].every((n) => Number.isSafeInteger(n) && (n as number) >= 0)) return;
  const details = usage.prompt_tokens_details as { cached_tokens?: unknown } | undefined;
  const cached = usage.prompt_cache_hit_tokens ?? details?.cached_tokens ?? 0;
  return { inputTokens: inputTokens as number, outputTokens: outputTokens as number, totalTokens: totalTokens as number,
    cacheReadTokens: Number.isSafeInteger(cached) && (cached as number) >= 0 ? cached as number : 0 };
}

export function createDeepseekTransport(settings: ModelSettings, apiKey: string, signal: AbortSignal) {
  const model = deepseekModel(settings);
  let responseStatus: number | undefined;
  let latestUsage: RunUsage | undefined;
  let failureCode: ProviderErrorCode | undefined;
  const streamFn: StreamFn = (_model, context, options) => {
    responseStatus = undefined;
    latestUsage = undefined;
    failureCode = undefined;
    const requestSignal = options?.signal ? AbortSignal.any([signal, options.signal]) : signal;
    const restrictedFetch: typeof globalThis.fetch = async (request, init) => {
      const url = new URL(typeof request === 'string' ? request : request instanceof URL ? request.href : request.url);
      if (url.origin !== DEEPSEEK_BASE_URL || url.pathname !== '/chat/completions'
        || url.search || url.username || url.password) {
        failureCode = 'PROVIDER_REQUEST_REJECTED';
        throw new ProviderError(failureCode);
      }
      const sdkSignal = init?.signal ?? (request instanceof Request ? request.signal : undefined);
      const fetchSignal = sdkSignal ? AbortSignal.any([requestSignal, sdkSignal]) : requestSignal;
      const response = await globalThis.fetch(request, { ...init, redirect: 'error', signal: fetchSignal });
      responseStatus = response.status;
      return response;
    };
    try {
      return stream(model, context, {
        apiKey, signal: requestSignal, fetch: restrictedFetch, maxRetries: 0, timeoutMs: settings.timeoutMs,
        maxTokens: settings.maxOutputTokens, temperature: 0.2, cacheRetention: 'none',
        samplingParams: { thinking: { type: 'disabled' } },
        onProviderStreamEvent: (value) => { latestUsage = rawUsage(value) ?? latestUsage; },
      });
    } catch {
      // StreamFn 约定通过事件流报告失败，而不是直接抛出请求异常。
      failureCode ??= providerStatusCode(responseStatus);
      const failed = createAssistantMessageEventStream();
      const message: AssistantMessage = {
        role: 'assistant', content: [], api: model.api, provider: model.provider, model: model.id,
        usage: EMPTY_PI_USAGE, stopReason: requestSignal.aborted ? 'aborted' : 'error',
        errorMessage: '模型请求未完成', timestamp: Date.now(),
      };
      failed.push({ type: 'error', reason: requestSignal.aborted ? 'aborted' : 'error', error: message });
      failed.end(message);
      return failed;
    }
  };
  return { model, streamFn, usage: () => latestUsage,
    errorCode: (): ProviderErrorCode => failureCode ?? providerStatusCode(responseStatus) };
}
