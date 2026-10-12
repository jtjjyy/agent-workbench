import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import { join } from 'node:path';
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

declare const MAIN_WINDOW_WEBPACK_ENTRY: string;
declare const MAIN_WINDOW_PRELOAD_WEBPACK_ENTRY: string;

let coordinator: RunCoordinator | undefined;
let allowQuit = false;

// Pi constructs the SDK internally; disable environment-enabled request logging.
process.env.OPENAI_LOG = 'off';
app.commandLine.appendSwitch('lang', 'zh-CN');

const testUserData = resolveTestUserData(process.argv);
if (testUserData) {
  mkdirSync(testUserData, { recursive: true });
  app.setPath('userData', testUserData);
}

const createWindow = async (): Promise<void> => {
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
  if (!coordinator) throw new Error('Runtime not initialized');
  const rendererUrl = resolveRendererUrl({
    isPackaged: app.isPackaged,
    appPath: app.getAppPath(),
    developmentEntry: MAIN_WINDOW_WEBPACK_ENTRY,
  });
  const dispose = registerHandlers(ipcMain, coordinator, window.webContents, rendererUrl);
  window.once('closed', dispose);
  await window.loadURL(rendererUrl);
};

if (started || !app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.whenReady().then(async () => {
    installChineseMenu();
    const store = new JsonlEventStore(join(app.getPath('userData'), 'events', 'conversation-v1.jsonl'));
    const settings = new SecureModelSettingsStore(join(app.getPath('userData'), 'settings', 'model-v1.json'));
    const workspace = new WorkspaceSession();
    const knowledge = new KnowledgeService(app.getPath('userData'));
    const skills = new SkillService(app.getPath('userData'));
    const commandApprovals = new CommandApprovals();
    const browser = new BrowserSession();
    coordinator = new RunCoordinator(store, createConfiguredProvider(settings, commandApprovals, browser), settings, workspace, async () => {
      const focused = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
      if (!focused || focused.isDestroyed()) return undefined;
      const result = await dialog.showOpenDialog(focused, {
        title: '选择只读工作区', buttonLabel: '选择工作区', properties: ['openDirectory'],
      });
      return result.canceled ? undefined : result.filePaths[0];
    }, knowledge, skills, commandApprovals);
    await coordinator.initialize();
    await createWindow();
  }).catch(() => {
    console.error('桌面客户端启动失败');
    dialog.showErrorBox(`${APP_DISPLAY_NAME}启动失败`, '无法加载本地会话记录，已有数据已保留。请查看本地诊断信息后重试。');
    app.quit();
  });
  app.on('before-quit', (event) => {
    if (allowQuit || !coordinator) return;
    event.preventDefault();
    void coordinator.shutdown().finally(() => {
      browser.close();
      allowQuit = true;
      app.quit();
    });
  });
}
app.on('window-all-closed', () => app.quit());
