import { mkdir, lstat, readdir, rename, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { PublicModelSettings } from '../../shared/model-settings';
import {
  DESKTOP_ERROR_MESSAGES, validateDesktopBackupRequest, type DesktopBackupRequest, type DesktopErrorCode,
  type DesktopInfo, type DesktopMigrationStatus, type DesktopResult, type DesktopStartupStage, type DesktopBridge,
} from '../../shared/desktop';
import {
  ALL_DATA_SCOPES, collectFiles, collectLegacyFiles, decodeArchive, encodeArchive, MAX_BACKUP_BYTES,
  onlyKeys, record, scopeForPath, validateFileContent, digest, fileLimit, type TaskDataValidator, type ChangeDataValidator,
} from './backup-format';
import {
  assertSafePath, DesktopServiceError, isMissing, isWithin, parseJson,
  readBounded, safeDesktopError, writePrivate,
} from './safe-files';

type DesktopMetadata = {
  schemaVersion: 1;
  dataSchemaVersion: 1;
  createdWithVersion: string;
  lastOpenedVersion: string;
  setupCompletedAt: string | null;
  setupMode: 'mock' | 'deepseek' | null;
  migration: { schemaVersion: 1; status: DesktopMigrationStatus; backupPath: string | null; completedAt: string | null };
};

export interface DesktopServiceOptions {
  dataDir: string;
  version: string;
  legacyDataDir?: string;
  legacyDataDirs?: string[];
  readModelSettings?: () => Promise<PublicModelSettings>;
  checkModelCredentials?: () => Promise<boolean>;
  isTaskActive?: () => boolean;
  // The coordinator owns this lock and checks pendingSubmissions/active before acquiring it.
  withMaintenance?: <T>(operation: () => Promise<T>) => Promise<T>;
  requireRestart?: () => void;
  validateTaskData?: TaskDataValidator;
  validateChangeData?: ChangeDataValidator;
  chooseSavePath?: (kind: 'backup' | 'diagnostics', suggestedName: string) => Promise<string | undefined>;
  chooseRestorePath?: () => Promise<string | undefined>;
  confirmRestore?: (summary: { scopes: DesktopBackupRequest['scopes']; fileCount: number; createdAt: string }) => Promise<boolean>;
}

export class DesktopService implements DesktopBridge {
  readonly dataDir: string;
  private readonly metadataPath: string;
  private readonly restorePath: string;
  private metadata: DesktopMetadata;
  private queue: Promise<void> = Promise.resolve();
  private initialized = false;
  private restartRequired = false;
  private startupStage: DesktopStartupStage = 'data';
  private lastError: DesktopErrorCode | null = null;

  constructor(private readonly options: DesktopServiceOptions) {
    if (!isAbsolute(options.dataDir) || !/^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][A-Za-z0-9.-]+)?$/u.test(options.version)) {
      throw new DesktopServiceError('DATA_READ_FAILED');
    }
    this.dataDir = resolve(options.dataDir);
    this.metadataPath = join(this.dataDir, 'desktop', 'metadata-v1.json');
    this.restorePath = join(this.dataDir, 'desktop', 'restore-v1.json');
    this.metadata = this.freshMetadata();
  }

  initialize(): Promise<DesktopInfo> {
    return this.serialize(async () => {
      if (this.initialized) return this.info();
      try {
        await assertSafePath(this.dataDir, true);
        await mkdir(this.dataDir, { recursive: true, mode: 0o700 });
        await assertSafePath(this.dataDir);
        if (!(await lstat(this.dataDir)).isDirectory()) throw new DesktopServiceError('UNSAFE_PATH');
        const hasExistingData = (await readdir(this.dataDir)).some((name) => name !== 'desktop');
        const restored = await this.readRestoreMarker();
        if (restored === 'pending' || restored === 'failed') {
          this.restartRequired = true;
          throw new DesktopServiceError('RESTORE_FAILED');
        }
        const stored = await this.readMetadata();
        if (stored) this.metadata = stored;
        else if (hasExistingData) this.metadata.migration.status = 'skipped-existing';
        else await this.migrateLegacy();
        // Startup must reject unsafe or unsupported data before any store can rewrite it.
        const currentFiles = await collectFiles(this.dataDir, ALL_DATA_SCOPES);
        decodeArchive(encodeArchive(this.options.version, ALL_DATA_SCOPES, currentFiles), this.options);
        this.metadata.lastOpenedVersion = this.options.version;
        await this.persistMetadata();
        this.initialized = true;
        this.lastError = null;
        return this.info();
      } catch (error) {
        this.lastError = safeDesktopError(error, 'DATA_READ_FAILED');
        throw new DesktopServiceError(this.lastError);
      }
    });
  }

  async info(): Promise<DesktopInfo> {
    const configuration = await this.configuration();
    return {
      schemaVersion: 1, version: this.options.version, dataDir: this.dataDir,
      initialized: this.initialized, setupCompleted: this.metadata.setupCompletedAt !== null,
      setupMode: this.metadata.setupMode, configurationReady: configuration.ready,
      configurationError: configuration.error,
      migration: { status: this.metadata.migration.status, backupPath: this.metadata.migration.backupPath },
      restartRequired: this.restartRequired, startupStage: this.startupStage, lastError: this.lastError,
    };
  }

  readDesktopInfo(): Promise<DesktopInfo> { return this.info(); }
  async waitForIdle(): Promise<void> {
    let pending: Promise<void>;
    do { pending = this.queue; await pending; } while (pending !== this.queue);
  }
  backupDesktop(request: DesktopBackupRequest): Promise<DesktopResult> { return this.backup(request); }
  restoreDesktop(): Promise<DesktopResult> { return this.restore(); }

  completeSetup(): Promise<DesktopResult> {
    return this.mutate('DATA_WRITE_FAILED', async () => {
      this.requireReady();
      return this.withMaintenance(async () => {
        const configuration = await this.configuration();
        if (!configuration.ready || !configuration.mode) {
          throw new DesktopServiceError(configuration.error === 'missing' ? 'SETUP_REQUIRED' : 'SETTINGS_INVALID');
        }
        const previous = this.metadata;
        this.metadata = { ...previous, setupCompletedAt: new Date().toISOString(), setupMode: configuration.mode };
        try { await this.persistMetadata(); }
        catch (error) { this.metadata = previous; throw error; }
        return { ok: true, info: await this.info() };
      });
    });
  }

  recordStartupStage(stage: DesktopStartupStage, code?: DesktopErrorCode): Promise<void> {
    return this.serialize(async () => {
      if (!['data', 'settings', 'tasks', 'runtime', 'window', 'ready'].includes(stage)
        || (code !== undefined && !Object.hasOwn(DESKTOP_ERROR_MESSAGES, code))) {
        throw new DesktopServiceError('DATA_WRITE_FAILED');
      }
      this.startupStage = stage;
      this.lastError = code ?? null;
      try {
        await this.writeJson(join(this.dataDir, 'desktop', 'startup-v1.json'), {
          schemaVersion: 1, stage, code: code ?? null, at: new Date().toISOString(),
        });
      } catch { throw new DesktopServiceError('DATA_WRITE_FAILED'); }
    });
  }

  exportDiagnostics(): Promise<DesktopResult> {
    return this.mutate('DIAGNOSTICS_FAILED', async () => {
      const path = await this.savePath('diagnostics');
      if (!path) return { ok: false, cancelled: true };
      const info = await this.info();
      // Do not serialize info/options wholesale: paths, configuration, logs and task text are excluded.
      const diagnostics = {
        format: 'agent-workbench-diagnostics', schemaVersion: 1,
        generatedAt: new Date().toISOString(), version: this.options.version,
        platform: process.platform, arch: process.arch,
        initialized: info.initialized, setupCompleted: info.setupCompleted,
        configurationReady: info.configurationReady, configurationError: info.configurationError,
        migrationStatus: info.migration.status, restartRequired: info.restartRequired,
        startupStage: info.startupStage, errorCode: info.lastError,
        limits: { maxBackupBytes: MAX_BACKUP_BYTES },
      };
      await writePrivate(path, Buffer.from(`${JSON.stringify(diagnostics, null, 2)}\n`, 'utf8'));
      return { ok: true, path, info };
    });
  }

  backup(request: DesktopBackupRequest = { scopes: ALL_DATA_SCOPES }): Promise<DesktopResult> {
    const captured: unknown = validateDesktopBackupRequest(request) ? { scopes: [...request.scopes] } : null;
    return this.mutate('BACKUP_FAILED', async () => {
      this.requireReady();
      if (!validateDesktopBackupRequest(captured)) throw new DesktopServiceError('INVALID_BACKUP');
      const path = await this.savePath('backup');
      if (!path) return { ok: false, cancelled: true };
      return this.withMaintenance(async () => {
        const files = await collectFiles(this.dataDir, captured.scopes);
        const bytes = encodeArchive(this.options.version, captured.scopes, files);
        decodeArchive(bytes, this.options);
        await writePrivate(path, bytes);
        return { ok: true, path, info: await this.info() };
      });
    });
  }

  restore(): Promise<DesktopResult> {
    return this.mutate('RESTORE_FAILED', async () => {
      this.requireReady();
      this.requireIdle();
      if (!this.options.chooseRestorePath || !this.options.confirmRestore) throw new DesktopServiceError('DIALOG_UNAVAILABLE');
      const path = await this.options.chooseRestorePath();
      if (!path) return { ok: false, cancelled: true };
      if (!isAbsolute(path) || isWithin(this.dataDir, path)) throw new DesktopServiceError('UNSAFE_PATH');
      if (!this.options.requireRestart) throw new DesktopServiceError('MAINTENANCE_UNAVAILABLE');
      const archive = decodeArchive(await readBounded(path, MAX_BACKUP_BYTES), this.options);
      if (!await this.options.confirmRestore({ scopes: archive.scopes, fileCount: archive.files.length, createdAt: archive.createdAt })) {
        return { ok: false, cancelled: true };
      }
      return this.withMaintenance(async () => {
        const operationId = randomUUID();
        const recoveryDir = join(this.dataDir, 'desktop', 'backups', `restore-${operationId}`);
        const stageDir = join(this.dataDir, 'desktop', 'staging', operationId);
        const allCurrent = await collectFiles(this.dataDir, ALL_DATA_SCOPES);
        const current = allCurrent.filter((file) => archive.scopes.includes(scopeForPath(file.path) as DesktopBackupRequest['scopes'][number]));
        const safetyBackupPath = join(recoveryDir, 'before-restore.awbackup.json');
        const previousMetadata = structuredClone(this.metadata);
        await writePrivate(safetyBackupPath, encodeArchive(this.options.version, ALL_DATA_SCOPES, allCurrent));
        await this.writeJson(join(recoveryDir, 'before-restore-metadata-v1.json'), previousMetadata);
        for (const file of archive.files) {
          await writePrivate(join(stageDir, ...file.path.split('/')), Buffer.from(file.content, 'base64'));
        }
        const moved: string[] = [];
        const installed: string[] = [];
        try {
          await this.writeJson(this.restorePath, {
            schemaVersion: 1, status: 'pending', operationId, safetyBackupPath, at: new Date().toISOString(),
          });
          this.restartRequired = true;
          this.options.requireRestart?.();
          for (const file of current) {
            const source = join(this.dataDir, ...file.path.split('/'));
            const target = join(recoveryDir, 'originals', ...file.path.split('/'));
            await assertSafePath(source);
            if (digest(await readBounded(source, fileLimit(file.path))) !== file.sha256) {
              throw new DesktopServiceError('DATA_READ_FAILED');
            }
            await assertSafePath(target, true);
            await mkdir(dirname(target), { recursive: true, mode: 0o700 });
            await assertSafePath(dirname(target));
            await rename(source, target);
            moved.push(file.path);
          }
          for (const file of archive.files) {
            await assertSafePath(join(stageDir, ...file.path.split('/')));
            const target = join(this.dataDir, ...file.path.split('/'));
            await assertSafePath(target, true);
            await mkdir(dirname(target), { recursive: true, mode: 0o700 });
            await assertSafePath(dirname(target));
            try { await lstat(target); throw new DesktopServiceError('UNSAFE_PATH'); }
            catch (error) { if (!isMissing(error)) throw error; }
            const staged = await readBounded(join(stageDir, ...file.path.split('/')), fileLimit(file.path));
            if (digest(staged) !== file.sha256) throw new DesktopServiceError('INVALID_BACKUP');
            installed.push(file.path);
            await writePrivate(target, staged);
          }
          // A restored key might not decrypt under this account. Require explicit configuration again.
          this.metadata = { ...previousMetadata, setupCompletedAt: null, setupMode: null };
          await this.persistMetadata();
          await this.writeJson(this.restorePath, {
            schemaVersion: 1, status: 'completed', operationId, safetyBackupPath, at: new Date().toISOString(),
          });
          return { ok: true, info: await this.info(), safetyBackupPath, restartRequired: true };
        } catch {
          let rollbackComplete = true;
          for (const path of installed.reverse()) {
            try {
              const target = join(this.dataDir, ...path.split('/'));
              const expected = archive.files.find((file) => file.path === path);
              if (!expected || digest(await readBounded(target, fileLimit(path))) !== expected.sha256) throw new DesktopServiceError('DATA_READ_FAILED');
              await assertSafePath(target); await unlink(target);
            }
            catch { rollbackComplete = false; }
          }
          for (const path of moved.reverse()) {
            try {
              const original = join(recoveryDir, 'originals', ...path.split('/'));
              const target = join(this.dataDir, ...path.split('/'));
              await assertSafePath(original); await assertSafePath(target, true);
              try { await lstat(target); throw new DesktopServiceError('UNSAFE_PATH'); }
              catch (error) { if (!isMissing(error)) throw error; }
              await rename(original, target);
            } catch { rollbackComplete = false; }
          }
          this.metadata = previousMetadata;
          try { await this.persistMetadata(); }
          catch { rollbackComplete = false; }
          this.lastError = 'RESTORE_FAILED';
          try {
            await this.writeJson(this.restorePath, {
              schemaVersion: 1, status: rollbackComplete ? 'rolled-back' : 'failed',
              operationId, safetyBackupPath, at: new Date().toISOString(),
            });
          } catch { /* Leave pending marker and preserved originals available for recovery. */ }
          return { ok: false, code: 'RESTORE_FAILED', safetyBackupPath };
        }
      });
    });
  }

  private async migrateLegacy(): Promise<void> {
    const candidates = [...new Set([this.options.legacyDataDir, ...(this.options.legacyDataDirs ?? [])]
      .filter((path): path is string => Boolean(path)).map((path) => resolve(path)))];
    for (const root of candidates) {
        if (root === this.dataDir || isWithin(this.dataDir, root)) continue;
      let files;
      try { files = await collectLegacyFiles(root, ALL_DATA_SCOPES); }
      catch (error) { if (isMissing(error)) continue; this.metadata.migration.status = 'failed'; throw new DesktopServiceError('MIGRATION_FAILED'); }
      if (files.length === 0) continue;
      const operationId = randomUUID();
      const backupPath = join(this.dataDir, 'desktop', 'backups', `migration-v1-${operationId}.awbackup.json`);
      const written: string[] = [];
      try {
        const bytes = encodeArchive(this.options.version, ALL_DATA_SCOPES, files);
        await writePrivate(backupPath, bytes);
        this.metadata.migration = { schemaVersion: 1, status: 'failed', backupPath, completedAt: null };
        await this.persistMetadata();
        decodeArchive(bytes, this.options);
        for (const file of files) {
          const path = join(this.dataDir, ...file.path.split('/'));
          await writePrivate(path, Buffer.from(file.content, 'base64'));
          written.push(path);
        }
        this.metadata.migration = { schemaVersion: 1, status: 'migrated', backupPath, completedAt: new Date().toISOString() };
        await this.persistMetadata();
        return;
      } catch {
        for (const path of written) { try { await assertSafePath(path); await unlink(path); } catch { /* Preserve leftovers and block startup. */ } }
        this.metadata.migration.status = 'failed';
        try { await this.persistMetadata(); } catch { /* Old source and any completed backup remain untouched. */ }
        throw new DesktopServiceError('MIGRATION_FAILED');
      }
    }
  }

  private freshMetadata(): DesktopMetadata {
    return {
      schemaVersion: 1, dataSchemaVersion: 1, createdWithVersion: this.options.version,
      lastOpenedVersion: this.options.version, setupCompletedAt: null, setupMode: null,
      migration: { schemaVersion: 1, status: 'none', backupPath: null, completedAt: null },
    };
  }

  private async readMetadata(): Promise<DesktopMetadata | null> {
    let value: unknown;
    try { value = parseJson(await readBounded(this.metadataPath, 16 * 1024)); }
    catch (error) { if (isMissing(error)) return null; throw new DesktopServiceError('DATA_READ_FAILED'); }
    if (!record(value) || !onlyKeys(value, ['schemaVersion', 'dataSchemaVersion', 'createdWithVersion',
      'lastOpenedVersion', 'setupCompletedAt', 'setupMode', 'migration'])
      || value.schemaVersion !== 1 || value.dataSchemaVersion !== 1
      || typeof value.createdWithVersion !== 'string' || typeof value.lastOpenedVersion !== 'string'
      || !(value.setupCompletedAt === null || (typeof value.setupCompletedAt === 'string' && Number.isFinite(Date.parse(value.setupCompletedAt))))
      || ![null, 'mock', 'deepseek'].includes(value.setupMode as null | string)
      || !record(value.migration) || !onlyKeys(value.migration, ['schemaVersion', 'status', 'backupPath', 'completedAt'])
      || value.migration.schemaVersion !== 1 || !['none', 'migrated', 'skipped-existing', 'failed'].includes(value.migration.status as string)
      || !(value.migration.backupPath === null || (typeof value.migration.backupPath === 'string'
        && isWithin(join(this.dataDir, 'desktop', 'backups'), value.migration.backupPath)))
      || !(value.migration.completedAt === null || (typeof value.migration.completedAt === 'string' && Number.isFinite(Date.parse(value.migration.completedAt))))) {
      throw new DesktopServiceError('DATA_READ_FAILED');
    }
    if (value.migration.status === 'failed') {
      this.metadata = value as unknown as DesktopMetadata;
      throw new DesktopServiceError('MIGRATION_FAILED');
    }
    return value as unknown as DesktopMetadata;
  }

  private async readRestoreMarker(): Promise<string | null> {
    let value: unknown;
    try { value = parseJson(await readBounded(this.restorePath, 16 * 1024)); }
    catch (error) { if (isMissing(error)) return null; throw new DesktopServiceError('DATA_READ_FAILED'); }
    if (!record(value) || value.schemaVersion !== 1
      || !['pending', 'completed', 'rolled-back', 'failed'].includes(value.status as string)) {
      throw new DesktopServiceError('DATA_READ_FAILED');
    }
    return value.status as string;
  }

  private async configuration(): Promise<{ ready: boolean; mode: 'mock' | 'deepseek' | null; error: DesktopInfo['configurationError'] }> {
    try {
      validateFileContent('settings/model-v1.json', await readBounded(join(this.dataDir, 'settings', 'model-v1.json'), 16 * 1024));
    } catch (error) { return { ready: false, mode: null, error: isMissing(error) ? 'missing' : 'invalid' }; }
    if (!this.options.readModelSettings) return { ready: false, mode: null, error: 'unavailable' };
    try {
      const settings = await this.options.readModelSettings();
      if (settings.configurationError || !['mock', 'deepseek'].includes(settings.provider)
        || (settings.provider === 'deepseek' && (!settings.hasApiKey || !settings.secureStorageAvailable || !settings.dataEgressConsent))) {
        return { ready: false, mode: null, error: 'invalid' };
      }
      if (settings.provider === 'deepseek' && !await this.options.checkModelCredentials?.()) {
        return { ready: false, mode: null, error: 'invalid' };
      }
      return { ready: true, mode: settings.provider, error: null };
    } catch { return { ready: false, mode: null, error: 'unavailable' }; }
  }

  private requireReady(): void {
    if (!this.initialized) throw new DesktopServiceError('NOT_INITIALIZED');
    if (this.restartRequired) throw new DesktopServiceError('RESTART_REQUIRED');
  }

  private requireIdle(): void {
    if (!this.options.isTaskActive) throw new DesktopServiceError('MAINTENANCE_UNAVAILABLE');
    if (this.options.isTaskActive()) throw new DesktopServiceError('RUN_ACTIVE');
  }

  private async withMaintenance(operation: () => Promise<DesktopResult>): Promise<DesktopResult> {
    this.requireIdle();
    if (!this.options.withMaintenance) throw new DesktopServiceError('MAINTENANCE_UNAVAILABLE');
    try { return await this.options.withMaintenance(operation); }
    catch (error) {
      if (error instanceof DesktopServiceError) throw error;
      // Coordinator messages are never propagated. Re-check only its public busy flag.
      throw new DesktopServiceError(this.options.isTaskActive?.() ? 'RUN_ACTIVE' : 'MAINTENANCE_UNAVAILABLE');
    }
  }

  private async savePath(kind: 'backup' | 'diagnostics'): Promise<string | undefined> {
    if (!this.options.chooseSavePath) throw new DesktopServiceError('DIALOG_UNAVAILABLE');
    const path = await this.options.chooseSavePath(kind, `agent-workbench-${kind}-${new Date().toISOString().slice(0, 10)}-${randomUUID().slice(0, 8)}.${kind === 'backup' ? 'awbackup.json' : 'json'}`);
    if (path && (!isAbsolute(path) || isWithin(this.dataDir, path))) throw new DesktopServiceError('UNSAFE_PATH');
    return path;
  }

  private writeJson(path: string, value: unknown): Promise<void> {
    return writePrivate(path, Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8'), true);
  }

  private persistMetadata(): Promise<void> { return this.writeJson(this.metadataPath, this.metadata); }

  private mutate(fallback: DesktopErrorCode, operation: () => Promise<DesktopResult>): Promise<DesktopResult> {
    return this.serialize(async () => {
      try { return await operation(); }
      catch (error) { this.lastError = safeDesktopError(error, fallback); return { ok: false, code: this.lastError }; }
    });
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation);
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }
}
