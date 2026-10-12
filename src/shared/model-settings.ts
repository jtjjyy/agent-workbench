export const DEEPSEEK_BASE_URL = 'https://api.deepseek.com';
export const DEEPSEEK_MODELS = ['deepseek-flash', 'deepseek-v4-pro'] as const;
export type DeepSeekModelId = typeof DEEPSEEK_MODELS[number];

export interface ModelSettings {
  provider: 'mock' | 'deepseek';
  model: DeepSeekModelId;
  maxOutputTokens: number;
  timeoutMs: number;
  dataEgressConsent: boolean;
}

export const DEFAULT_MODEL_SETTINGS: ModelSettings = {
  provider: 'mock', model: 'deepseek-flash', maxOutputTokens: 4096,
  timeoutMs: 90_000, dataEgressConsent: false,
};

export type SettingsErrorCode = 'INVALID_SETTINGS' | 'SECURE_STORAGE_UNAVAILABLE'
  | 'SETTINGS_READ_FAILED' | 'SETTINGS_WRITE_FAILED' | 'API_KEY_REQUIRED' | 'RUN_ACTIVE';

export interface PublicModelSettings extends ModelSettings {
  hasApiKey: boolean;
  secureStorageAvailable: boolean;
  configurationError?: SettingsErrorCode;
}

export interface SaveModelSettingsRequest extends ModelSettings {
  // Omitted or empty preserves an existing key. Removal is a separate command.
  apiKey?: string;
}

export type ModelSettingsResult = { ok: true; settings: PublicModelSettings }
  | { ok: false; code: SettingsErrorCode };

export interface ModelSettingsStore {
  readPublic(): Promise<PublicModelSettings>;
  save(request: SaveModelSettingsRequest): Promise<ModelSettingsResult>;
  deleteApiKey(): Promise<ModelSettingsResult>;
  readCredentials(): Promise<{ settings: ModelSettings; apiKey: string }>;
}

export function validateModelSettings(input: unknown, allowApiKey = false): input is SaveModelSettingsRequest {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return false;
  const value = input as Record<string, unknown>;
  const allowed = ['provider', 'model', 'maxOutputTokens', 'timeoutMs', 'dataEgressConsent'];
  if (allowApiKey) allowed.push('apiKey');
  if (Object.keys(value).some((key) => !allowed.includes(key))) return false;
  return (value.provider === 'mock' || value.provider === 'deepseek')
    && DEEPSEEK_MODELS.some((model) => model === value.model)
    && Number.isSafeInteger(value.maxOutputTokens)
    && (value.maxOutputTokens as number) >= 512 && (value.maxOutputTokens as number) <= 8192
    && Number.isSafeInteger(value.timeoutMs)
    && (value.timeoutMs as number) >= 15_000 && (value.timeoutMs as number) <= 180_000
    && typeof value.dataEgressConsent === 'boolean'
    && (value.provider !== 'deepseek' || value.dataEgressConsent === true)
    && (value.apiKey === undefined || (allowApiKey && typeof value.apiKey === 'string'
      && (value.apiKey === '' || /^sk-[A-Za-z0-9_-]{16,200}$/.test(value.apiKey))));
}
