import type { AgentProvider, ProviderReply } from '../../shared/contracts';
import type { ModelSettingsStore } from '../../shared/model-settings';
import { createDeterministicProvider } from './provider';
import { ProviderError } from './provider-errors';
import { runPiAgent } from './pi-agent-runtime';
import type { CommandApprovals } from './command-approvals';
import type { BrowserSession } from '../browser/browser-session';

export function createConfiguredProvider(store: ModelSettingsStore, commandApprovals?: CommandApprovals, browser?: BrowserSession): AgentProvider {
  const mock = createDeterministicProvider({ failOnPrompt: (text) => text === '[simulate-failure]' });
  return {
    async streamReply(input, signal, onDelta): Promise<ProviderReply> {
      const config = await store.readPublic();
      if (config.configurationError) {
        throw new ProviderError(config.configurationError === 'SECURE_STORAGE_UNAVAILABLE'
          ? 'SECURE_STORAGE_UNAVAILABLE' : 'SETTINGS_READ_FAILED');
      }
      if (config.provider === 'mock') {
        await mock.streamReply(input, signal, onDelta);
        return { provider: 'mock', model: 'deterministic-local' };
      }
      if (!config.dataEgressConsent) throw new ProviderError('DATA_EGRESS_NOT_APPROVED');
      if (!config.hasApiKey) throw new ProviderError('API_KEY_REQUIRED');
      let credentials: Awaited<ReturnType<ModelSettingsStore['readCredentials']>>;
      try { credentials = await store.readCredentials(); }
      catch (error) {
        const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
        throw new ProviderError(code === 'SECURE_STORAGE_UNAVAILABLE'
          ? 'SECURE_STORAGE_UNAVAILABLE' : code === 'API_KEY_REQUIRED' ? 'API_KEY_REQUIRED' : 'SETTINGS_READ_FAILED');
      }
      signal.throwIfAborted();
      const { settings, apiKey } = credentials;
      if (settings.provider !== 'deepseek' || !settings.dataEgressConsent) {
        throw new ProviderError('DATA_EGRESS_NOT_APPROVED');
      }
      return runPiAgent(input, settings, apiKey, signal, onDelta, commandApprovals, input.runId,
        input.onApproval, browser);
    },
  };
}
