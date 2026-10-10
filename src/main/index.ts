import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import started from 'electron-squirrel-startup';
import { JsonlEventStore } from './events/event-store';
import { createDeterministicProvider } from './agent/provider';
import { RunCoordinator } from './agent/run-coordinator';
import { registerHandlers } from './ipc/register-handlers';
import { resolveTestUserData } from './e2e-options';
import { resolveRendererUrl } from './renderer-url';

declare const MAIN_WINDOW_WEBPACK_ENTRY: string;
declare const MAIN_WINDOW_PRELOAD_WEBPACK_ENTRY: string;

let coordinator: RunCoordinator | undefined;
let allowQuit = false;

const testUserData = resolveTestUserData(process.argv);
if (testUserData) {
  mkdirSync(testUserData, { recursive: true });
  app.setPath('userData', testUserData);
}

const createWindow = async (): Promise<void> => {
  const window = new BrowserWindow({
    title: 'Agent Workbench',
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
    const store = new JsonlEventStore(join(app.getPath('userData'), 'events', 'conversation-v1.jsonl'));
    coordinator = new RunCoordinator(store, createDeterministicProvider({
      failOnPrompt: (text) => text === '[simulate-failure]',
    }));
    await coordinator.initialize();
    await createWindow();
  }).catch((error: unknown) => {
    console.error('Desktop startup failed', error);
    dialog.showErrorBox('Agent Workbench startup failed', 'The local journal could not be loaded. Existing data was preserved. See local diagnostics before retrying.');
    app.quit();
  });
  app.on('before-quit', (event) => {
    if (allowQuit || !coordinator) return;
    event.preventDefault();
    void coordinator.shutdown().finally(() => {
      allowQuit = true;
      app.quit();
    });
  });
}
app.on('window-all-closed', () => app.quit());
