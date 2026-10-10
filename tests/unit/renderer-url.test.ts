import { expect, test } from 'vitest';
import { resolveRendererUrl } from '../../src/main/renderer-url';
import { registerHandlers, type CommandSource, type IpcRegistry } from '../../src/main/ipc/register-handlers';

test.each([
  ['Agent Workbench', 'Agent%20Workbench'],
  ['name#alias', 'name%23alias'],
  ['name%literal', 'name%25literal'],
  ['name%20literal', 'name%2520literal'],
])('encodes literal packaged directory %s before loading or authorizing', async (directory, encoded) => {
  const url = resolveRendererUrl({
    isPackaged: true,
    appPath: `D:\\Apps\\${directory}\\resources\\app.asar`,
    developmentEntry: `file://D:\\Apps\\${directory}\\resources\\app.asar\\.webpack\\renderer\\main_window\\index.html`,
  });
  expect(url).toBe(`file:///D:/Apps/${encoded}/resources/app.asar/.webpack/renderer/main_window/index.html`);

  const handlers = new Map<string, (source: CommandSource, input: unknown) => Promise<unknown>>();
  const ipc: IpcRegistry = {
    handle: (channel, handler) => { handlers.set(channel, handler); },
    removeHandler: (channel) => { handlers.delete(channel); },
  };
  const frame = { url };
  const window = {
    id: 1, mainFrame: frame, getURL: () => frame.url,
    isDestroyed: () => false, send() {},
  };
  const dispose = registerHandlers(ipc, {
    async readConversation() { return []; },
    async submit() {},
    subscribe() { return () => {}; },
  }, window, url);
  const read = () => handlers.get('agent:read-conversation')!({ sender: window, senderFrame: frame }, 'default');
  await expect(read()).resolves.toEqual([]);
  for (const suffix of ['?query=1', '#fragment']) {
    frame.url = url + suffix;
    await expect(read()).rejects.toThrow('Untrusted IPC sender');
  }
  dispose();
});

test('keeps the development HTTP entry separate from the packaged filesystem path', () => {
  expect(resolveRendererUrl({
    isPackaged: false, appPath: 'D:\\Apps\\name#%20',
    developmentEntry: 'http://127.0.0.1:3000/main_window',
  })).toBe('http://127.0.0.1:3000/main_window');
});
