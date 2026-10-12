import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink, type FileHandle } from 'node:fs/promises';
import { dirname } from 'node:path';
import { TextDecoder } from 'node:util';
import { safeStorage } from 'electron';
import { SETTINGS_ERROR_MESSAGES } from '../../shared/zh-CN';
import {
  DEFAULT_MODEL_SETTINGS,
  type ModelSettings,
  type ModelSettingsResult,
  type ModelSettingsStore,
  type PublicModelSettings,
  type SaveModelSettingsRequest,
  type SettingsErrorCode,
  validateModelSettings,
} from '../../shared/model-settings';

type StoredSettings = {
  schemaVersion: 1;
  settings: ModelSettings;
  encryptedApiKey?: string;
};

export class SettingsStoreError extends Error {
  constructor(readonly code: SettingsErrorCode) {
    super(SETTINGS_ERROR_MESSAGES[code]);
    this.name = 'SettingsStoreError';
  }
}

function sanitizedError(error: unknown, fallback: SettingsErrorCode): SettingsStoreError {
  // Never retain a native error message, cause, or payload that might contain a key.
  return new SettingsStoreError(error instanceof SettingsStoreError ? error.code : fallback);
}

function copySettings(settings: ModelSettings): ModelSettings {
  return {
    provider: settings.provider,
    model: settings.model,
    maxOutputTokens: settings.maxOutputTokens,
    timeoutMs: settings.timeoutMs,
    dataEgressConsent: settings.dataEgressConsent,
  };
}

function secureStorageAvailable(): boolean {
  try {
    if (process.type === 'renderer' || !safeStorage.isEncryptionAvailable()) return false;
    if (process.platform === 'linux') {
      const backend = safeStorage.getSelectedStorageBackend();
      return ['gnome_libsecret', 'kwallet', 'kwallet5', 'kwallet6'].includes(backend);
    }
    return true;
  } catch {
    return false;
  }
}

function requireSecureStorage(): void {
  if (!secureStorageAvailable()) throw new SettingsStoreError('SECURE_STORAGE_UNAVAILABLE');
}

function isEncryptedKey(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 4096
    && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
    && Buffer.from(value, 'base64').toString('base64') === value;
}

function publicSettings(
  record: StoredSettings,
  configurationError?: SettingsErrorCode,
): PublicModelSettings {
  const available = secureStorageAvailable();
  const hasApiKey = record.encryptedApiKey !== undefined;
  const error = configurationError
    ?? (hasApiKey && !available ? 'SECURE_STORAGE_UNAVAILABLE' : undefined)
    ?? (record.settings.provider === 'deepseek' && !hasApiKey ? 'API_KEY_REQUIRED' : undefined);
  return {
    ...copySettings(record.settings),
    hasApiKey,
    secureStorageAvailable: available,
    ...(error ? { configurationError: error } : {}),
  };
}

export class SecureModelSettingsStore implements ModelSettingsStore {
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  readPublic(): Promise<PublicModelSettings> {
    return this.serialize(async () => {
      try {
        return publicSettings(await this.readStored());
      } catch (error) {
        return publicSettings(
          { schemaVersion: 1, settings: copySettings(DEFAULT_MODEL_SETTINGS) },
          sanitizedError(error, 'SETTINGS_READ_FAILED').code,
        );
      }
    });
  }

  async save(request: SaveModelSettingsRequest): Promise<ModelSettingsResult> {
    let captured: SaveModelSettingsRequest;
    try {
      if (!validateModelSettings(request, true)) throw new SettingsStoreError('INVALID_SETTINGS');
      // Snapshot caller-owned data before waiting on earlier IO; never spread apiKey into settings.
      captured = { ...copySettings(request), apiKey: request.apiKey };
      if (!validateModelSettings(captured, true)) throw new SettingsStoreError('INVALID_SETTINGS');
    } catch (error) {
      return { ok: false, code: sanitizedError(error, 'INVALID_SETTINGS').code };
    }

    return this.serialize<ModelSettingsResult>(async () => {
      try {
        const previous = await this.readStored();
        const settings = copySettings(captured);
        let encryptedApiKey = previous.encryptedApiKey;
        if (encryptedApiKey !== undefined || captured.apiKey) requireSecureStorage();
        if (captured.apiKey) encryptedApiKey = this.encryptApiKey(captured.apiKey);
        if (settings.provider === 'deepseek' && encryptedApiKey === undefined) {
          throw new SettingsStoreError('API_KEY_REQUIRED');
        }
        const next: StoredSettings = {
          schemaVersion: 1,
          settings,
          ...(encryptedApiKey !== undefined ? { encryptedApiKey } : {}),
        };
        await this.writeStored(next);
        return { ok: true, settings: publicSettings(next) };
      } catch (error) {
        return { ok: false, code: sanitizedError(error, 'SETTINGS_WRITE_FAILED').code };
      }
    });
  }

  deleteApiKey(): Promise<ModelSettingsResult> {
    return this.serialize<ModelSettingsResult>(async () => {
      try {
        const previous = await this.readStored();
        const next: StoredSettings = {
          schemaVersion: 1,
          settings: { ...copySettings(previous.settings), provider: 'mock', dataEgressConsent: false },
        };
        await this.writeStored(next);
        return { ok: true, settings: publicSettings(next) };
      } catch (error) {
        return { ok: false, code: sanitizedError(error, 'SETTINGS_WRITE_FAILED').code };
      }
    });
  }

  readCredentials(): Promise<{ settings: ModelSettings; apiKey: string }> {
    return this.serialize(async () => {
      try {
        const record = await this.readStored();
        if (record.encryptedApiKey === undefined) throw new SettingsStoreError('API_KEY_REQUIRED');
        requireSecureStorage();
        let apiKey: string;
        try {
          apiKey = safeStorage.decryptString(Buffer.from(record.encryptedApiKey, 'base64'));
        } catch {
          throw new SettingsStoreError('SETTINGS_READ_FAILED');
        }
        if (!apiKey || !validateModelSettings({ ...record.settings, apiKey }, true)) {
          throw new SettingsStoreError('SETTINGS_READ_FAILED');
        }
        return { settings: copySettings(record.settings), apiKey };
      } catch (error) {
        throw sanitizedError(error, 'SETTINGS_READ_FAILED');
      }
    });
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation);
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }

  private encryptApiKey(apiKey: string): string {
    requireSecureStorage();
    try {
      const encrypted = safeStorage.encryptString(apiKey);
      const encoded = encrypted.toString('base64');
      if (!Buffer.isBuffer(encrypted) || !isEncryptedKey(encoded)) {
        throw new SettingsStoreError('SECURE_STORAGE_UNAVAILABLE');
      }
      return encoded;
    } catch {
      throw new SettingsStoreError('SECURE_STORAGE_UNAVAILABLE');
    }
  }

  private async readStored(): Promise<StoredSettings> {
    let bytes: Buffer;
    try {
      bytes = await readFile(this.filePath);
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
        return { schemaVersion: 1, settings: copySettings(DEFAULT_MODEL_SETTINGS) };
      }
      throw new SettingsStoreError('SETTINGS_READ_FAILED');
    }

    try {
      if (bytes.length > 16384) throw new SettingsStoreError('SETTINGS_READ_FAILED');
      const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new SettingsStoreError('SETTINGS_READ_FAILED');
      }
      const record = value as Record<string, unknown>;
      if (Object.keys(record).some((key) => !['schemaVersion', 'settings', 'encryptedApiKey'].includes(key))
        || record.schemaVersion !== 1 || !validateModelSettings(record.settings)) {
        throw new SettingsStoreError('SETTINGS_READ_FAILED');
      }
      const hasApiKey = Object.hasOwn(record, 'encryptedApiKey');
      if (hasApiKey && !isEncryptedKey(record.encryptedApiKey)) {
        throw new SettingsStoreError('SETTINGS_READ_FAILED');
      }
      return {
        schemaVersion: 1,
        settings: copySettings(record.settings),
        ...(hasApiKey ? { encryptedApiKey: record.encryptedApiKey as string } : {}),
      };
    } catch {
      // Malformed files and future schemas remain untouched, including during mutations.
      throw new SettingsStoreError('SETTINGS_READ_FAILED');
    }
  }

  private async writeStored(record: StoredSettings): Promise<void> {
    let temporaryPath: string | undefined;
    let file: FileHandle | undefined;
    let created = false;
    try {
      // Build the on-disk shape explicitly so credentials cannot enter JSON through extra fields.
      const serialized = JSON.stringify({
        schemaVersion: 1,
        settings: copySettings(record.settings),
        ...(record.encryptedApiKey !== undefined ? { encryptedApiKey: record.encryptedApiKey } : {}),
      });
      await mkdir(dirname(this.filePath), { recursive: true, mode: 0o700 });
      temporaryPath = `${this.filePath}.${randomUUID()}.tmp`;
      file = await open(temporaryPath, 'wx', 0o600);
      created = true;
      await file.writeFile(`${serialized}\n`, 'utf8');
      await file.sync();
      await file.close();
      file = undefined;
      await rename(temporaryPath, this.filePath);
    } catch {
      if (file) {
        try { await file.close(); } catch { /* Keep cleanup errors out of public errors. */ }
      }
      if (created && temporaryPath !== undefined) {
        try { await unlink(temporaryPath); } catch { /* Cleanup is best effort if the OS refuses it. */ }
      }
      throw new SettingsStoreError('SETTINGS_WRITE_FAILED');
    }
  }
}
