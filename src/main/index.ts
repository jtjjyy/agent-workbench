import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import { dirname, join } from 'node:path';
import { mkdirSync } from 'node:fs';
import started from 'electron-squirrel-startup';
import { JsonlEventStore } from './events/event-store';
import { createConfiguredProvider } from './agent/deepseek-provider';
import { SecureModelSettingsStore } from './settings/model-settings-store';
import { RunCoordinator } from './agent/run-coordinator';
import { registerHandlers } from './ipc/register-handlers';
import { resolveTestUserData } from './e2e-options';
import { resolveRendererUrl } from './renderer-url';
import { APP_DISPLAY_NAME } from '../shared/zh-CN';
import { installChineseMenu } from './application-menu';
import { WorkspaceSession } from './workspace/workspace-session';
import { KnowledgeService } from './knowledge/knowledge-service';
import { SkillService } from './skills/skill-service';
import { CommandApprovals } from './agent/command-approvals';
import { BrowserSession } from './browser/browser-session';
import { TaskStore } from './tasks/task-store';
import { ChangeSetService } from './changes/change-set-service';
import { DesktopService } from './desktop/desktop-service';
import { canonicalDesktopRoot, legacyDesktopDataDirs, resolveDesktopRuntimeDir } from './desktop/data-paths';
import { DesktopServiceError, isMissing } from './desktop/safe-files';
import { validateDesktopChangeData, validateDesktopTaskData } from './desktop/schema-validators';
import { DESKTOP_ERROR_MESSAGES, DESKTOP_SCOPE_LABELS, DESKTOP_STARTUP_LABELS, type DesktopStartupStage } from '../shared/desktop';

declare const MAIN_WINDOW_WEBPACK_ENTRY: string;
declare const MAIN_WINDOW_PRELOAD_WEBPACK_ENTRY: string;

let coordinator: RunCoordinator | undefined;
let browser: BrowserSession | undefined;
let desktop: DesktopService | undefined;
let mainWindow: BrowserWindow | undefined;
let windowCreation: Promise<void> | undefined;
let pendingFocus = false;
let runtimeReady = false;
let shuttingDown = false;
let startupStage: DesktopStartupStage = 'data';
let startupOperation: Promise<void> | undefined;
let allowQuit = false;

// Pi constructs the SDK internally; disable environment-enabled request logging.
process.env.OPENAI_LOG = 'off';
app.commandLine.appendSwitch('lang', 'zh-CN');

const testUserData = resolveTestUserData(process.argv);
const previousUserData = app.getPath('userData');
let runtimeDirectoryFailed = false;
let desktopDataDir: string | undefined;
try {
  const requestedRuntimeDir = testUserData ?? resolveDesktopRuntimeDir(app.getPath('appData'));
  mkdirSync(requestedRuntimeDir, { recursive: true });
  // 系统应用容器可能重定向 AppData；固定实际目录后，存储层仍严格复查路径身份。
  const runtimeDir = canonicalDesktopRoot(requestedRuntimeDir);
  desktopDataDir = testUserData ? runtimeDir : join(dirname(runtimeDir), 'data-v1');
  app.setPath('userData', runtimeDir);
  app.setPath('sessionData', runtimeDir);
} catch { runtimeDirectoryFailed = true; }

const focusMainWindow = (): void => {
  if (!mainWindow || mainWindow.isDestroyed()) { pendingFocus = true; return; }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
  pendingFocus = false;
};

const openWindow = async (): Promise<void> => {
  if (!coordinator || !desktop) throw new Error('桌面运行服务尚未初始化');
  const window = new BrowserWindow({
    title: APP_DISPLAY_NAME,
    width: 1280,
    height: 800,
    minWidth: 600,
    minHeight: 480,
    webPreferences: {
      preload: MAIN_WINDOW_PRELOAD_WEBPACK_ENTRY,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event) => event.preventDefault());
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  const rendererUrl = resolveRendererUrl({
    isPackaged: app.isPackaged,
    appPath: app.getAppPath(),
    developmentEntry: MAIN_WINDOW_WEBPACK_ENTRY,
  });
  const dispose = registerHandlers(ipcMain, coordinator, window.webContents, rendererUrl, desktop);
  mainWindow = window;
  window.once('closed', () => {
    dispose();
    if (mainWindow === window) mainWindow = undefined;
  });
  try {
    await window.loadURL(rendererUrl);
    if (pendingFocus) focusMainWindow();
  } catch (error) {
    if (!window.isDestroyed()) window.destroy();
    throw error;
  }
};

const createWindow = (): Promise<void> => {
  if (windowCreation) return windowCreation;
  if (mainWindow && !mainWindow.isDestroyed()) { focusMainWindow(); return Promise.resolve(); }
  windowCreation = openWindow().finally(() => { windowCreation = undefined; });
  return windowCreation;
};

const recordStage = async (stage: DesktopStartupStage): Promise<void> => {
  startupStage = stage;
  await desktop?.recordStartupStage(stage);
};

const startupFailed = async (error: unknown): Promise<void> => {
  runtimeReady = false;
  const code = runtimeDirectoryFailed ? 'RUNTIME_DIRECTORY_FAILED'
    : error instanceof DesktopServiceError ? error.code : 'STARTUP_FAILED';
  try { await desktop?.recordStartupStage(startupStage, 'STARTUP_FAILED'); }
  catch { /* Never expose native errors or configuration contents. */ }
  console.error(`桌面客户端启动失败：${code}；阶段：${DESKTOP_STARTUP_LABELS[startupStage]}`);
  dialog.showErrorBox(`${APP_DISPLAY_NAME}启动失败`, `${DESKTOP_ERROR_MESSAGES.STARTUP_FAILED}\n启动阶段：${DESKTOP_STARTUP_LABELS[startupStage]}\n错误码：${code}`);
  app.quit();
};

if (started || !app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    pendingFocus = true;
    if (!app.isReady() || !runtimeReady || shuttingDown) return;
    void createWindow().then(focusMainWindow).catch(startupFailed);
  });
  app.on('activate', () => {
    if (runtimeReady && !shuttingDown) void createWindow().catch(startupFailed);
  });
  startupOperation = app.whenReady().then(async () => {
    if (shuttingDown) return;
    if (runtimeDirectoryFailed || !desktopDataDir) throw new Error('无法初始化桌面运行目录');
    installChineseMenu();
    const dataDir = desktopDataDir;
    const legacyDataDirs: string[] = [];
    if (!testUserData) {
      for (const path of legacyDesktopDataDirs(app.getPath('appData'), previousUserData)) {
        try { legacyDataDirs.push(canonicalDesktopRoot(path)); }
        catch (error) { if (!isMissing(error)) throw error; }
      }
    }
    let settings: SecureModelSettingsStore | undefined;
    desktop = new DesktopService({
      dataDir, version: app.getVersion(),
      legacyDataDirs,
      readModelSettings: async () => {
        if (!settings) throw new Error('模型设置服务尚未初始化');
        return settings.readPublic();
      },
      checkModelCredentials: async () => {
        if (!settings) return false;
        try { await settings.readCredentials(); return true; } catch { return false; }
      },
      isTaskActive: () => coordinator?.isTaskActive() ?? false,
      withMaintenance: <T>(operation: () => Promise<T>): Promise<T> => {
        if (!coordinator) return Promise.reject(new Error('桌面维护服务尚未初始化'));
        return coordinator.withMaintenance(operation);
      },
      requireRestart: () => coordinator?.requireRestart(),
      validateTaskData: validateDesktopTaskData,
      validateChangeData: validateDesktopChangeData,
      chooseSavePath: async (kind, suggestedName) => {
        const window = mainWindow;
        if (!window || window.isDestroyed()) return undefined;
        const result = await dialog.showSaveDialog(window, {
          title: kind === 'backup' ? '保存本地备份' : '导出安全诊断',
          defaultPath: suggestedName, buttonLabel: '保存',
        });
        return result.canceled ? undefined : result.filePath;
      },
      chooseRestorePath: async () => {
        const window = mainWindow;
        if (!window || window.isDestroyed()) return undefined;
        const result = await dialog.showOpenDialog(window, {
          title: '选择本地备份', buttonLabel: '选择备份', properties: ['openFile'],
          filters: [{ name: '本地备份（JSON）', extensions: ['json'] }],
        });
        return result.canceled ? undefined : result.filePaths[0];
      },
      confirmRestore: async ({ scopes, fileCount, createdAt }) => {
        const window = mainWindow;
        if (!window || window.isDestroyed()) return false;
        const result = await dialog.showMessageBox(window, {
          type: 'warning', title: '确认恢复本地数据',
          message: `将恢复 ${fileCount} 个文件并替换选定数据类别。`,
          detail: `数据类别：${scopes.map((scope) => DESKTOP_SCOPE_LABELS[scope]).join('、')}\n备份时间：${createdAt}\n当前数据会先备份；恢复后必须重启。密钥不能保证跨电脑或账号解密。`,
          buttons: ['取消', '确认恢复'], defaultId: 0, cancelId: 0,
        });
        return result.response === 1;
      },
    });
    await recordStage('data');
    await desktop.initialize();
    await recordStage('settings');
    settings = new SecureModelSettingsStore(join(dataDir, 'settings', 'model-v1.json'));
    const store = new JsonlEventStore(join(dataDir, 'events', 'conversation-v1.jsonl'));
    await recordStage('tasks');
    const tasks = new TaskStore(join(dataDir, 'tasks', 'tasks-v1.json'));
    const changes = new ChangeSetService(join(dataDir, 'changes'), { allowVerification: false });
    await changes.readChangeSets();
    const workspace = new WorkspaceSession();
    const knowledge = new KnowledgeService(dataDir);
    const skills = new SkillService(dataDir);
    const commandApprovals = new CommandApprovals();
    browser = new BrowserSession();
    coordinator = new RunCoordinator(store, createConfiguredProvider(settings, commandApprovals, browser), settings, workspace, async () => {
      const focused = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
      if (!focused || focused.isDestroyed()) return undefined;
      const result = await dialog.showOpenDialog(focused, {
        title: '选择只读工作区', buttonLabel: '选择工作区', properties: ['openDirectory'],
      });
      return result.canceled ? undefined : result.filePaths[0];
    }, knowledge, skills, commandApprovals, tasks, changes);
    await coordinator.initialize();
    await recordStage('runtime');
    if (shuttingDown) return;
    runtimeReady = true;
    await recordStage('window');
    await createWindow();
    await recordStage('ready');
  }).catch(startupFailed);
  app.on('before-quit', (event) => {
    if (allowQuit) return;
    event.preventDefault();
    if (shuttingDown) return;
    shuttingDown = true;
    runtimeReady = false;
    void (async () => {
      let failed = false;
      try { await startupOperation; } catch { failed = true; }
      try { await coordinator?.shutdown(); } catch { failed = true; }
      try { await desktop?.waitForIdle(); } catch { failed = true; }
      try { browser?.close(); } catch { failed = true; }
      if (failed) {
        try { await desktop?.recordStartupStage(startupStage, 'SHUTDOWN_FAILED'); }
        catch { /* Preserve existing files without exposing native error objects. */ }
        console.error(DESKTOP_ERROR_MESSAGES.SHUTDOWN_FAILED);
      }
      allowQuit = true;
      app.quit();
    })();
  });
}
app.on('window-all-closed', () => app.quit());
