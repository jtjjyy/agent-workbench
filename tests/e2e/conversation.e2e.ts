import { _electron, expect, test as base, type ElectronApplication, type Page, type TestInfo } from '@playwright/test';
import { mkdtemp, readFile, realpath, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import type { AgentBridge, EventEnvelope, SubmitMessageRequest } from '../../src/shared/contracts';
import { EVENT_LABELS, RUN_ERROR_MESSAGES } from '../../src/shared/zh-CN';

type Desktop = {
  userData: string;
  launch(): Promise<{ app: ElectronApplication; page: Page }>;
  quit(app: ElectronApplication): Promise<void>;
};

async function resolveExecutable(info: TestInfo): Promise<string> {
  if (process.platform !== 'win32') throw new Error('This packaged E2E requires a Windows host and Windows Forge artifact.');
  const candidates = info.config.metadata.packagedExecutables as string[];
  const found: string[] = [];
  for (const candidate of candidates) {
    try {
      if ((await stat(candidate)).isFile()) found.push(candidate);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  if (found.length !== 1) {
    throw new Error([
      found.length ? 'Ambiguous Forge packages; retain only the intended artifact or set packagerConfig.name/executableName.'
        : 'Packaged executable absent. Controller must run npm run package before this suite.',
      `Package: ${info.config.metadata.packageName}; product: ${info.config.metadata.productName}`,
      'Checked:', ...candidates,
      'No Electron application launched; this is a harness prerequisite failure, NOT behavioral RED.',
    ].join('\n'));
  }
  return found[0];
}

async function readJournal(userData: string, mode: 'idle' | 'live' = 'idle'): Promise<EventEnvelope[]> {
  const text = await readFile(join(userData, 'events', 'conversation-v1.jsonl'), 'utf8');
  if (mode === 'idle') {
    expect(text.endsWith('\n'), 'The journal should end with a complete JSONL record').toBe(true);
  }
  // A live read may overlap the next append; parse every completed record, never its partial tail.
  return text.split('\n').slice(0, -1).map((line) => JSON.parse(line) as EventEnvelope);
}

const test = base.extend<{ desktop: Desktop }>({
  // Playwright requires a destructured fixture argument even when no browser fixture is used.
  // eslint-disable-next-line no-empty-pattern
  desktop: async ({}, use, info) => {
    const executablePath = await resolveExecutable(info);
    const tempRoot = await realpath(tmpdir());
    const userData = await mkdtemp(join(tempRoot, 'awb-packaged-e2e-'));
    const apps = new Set<ElectronApplication>();
    const quit = async (app: ElectronApplication) => {
      const child = app.process();
      // Playwright closes Electron through app.quit(), allowing before-quit journal draining.
      await app.close();
      await expect.poll(() => child.exitCode, {
        message: 'Orderly Electron shutdown must exit successfully before profile reuse or cleanup',
      }).toBe(0);
      apps.delete(app);
    };
    const cleanup = async () => {
      // Never remove an active profile. If any close fails, preserve it for diagnosis.
      const closed = await Promise.allSettled([...apps].map(quit));
      const failed = closed.find((result) => result.status === 'rejected');
      if (failed?.status === 'rejected') throw failed.reason;
      const target = await realpath(userData);
      if (dirname(target) !== tempRoot || !basename(target).startsWith('awb-packaged-e2e-')
        || resolve(target) === resolve(tempRoot)) {
        throw new Error(`Refusing to remove an unverified temporary profile: ${target}`);
      }
      await rm(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    };
    try {
      await use({
        userData,
        quit,
        async launch() {
          const env = Object.fromEntries(Object.entries(process.env).filter(
            (entry): entry is [string, string] =>
              entry[0].toUpperCase() !== 'ELECTRON_RUN_AS_NODE' && entry[1] !== undefined,
          ));
          let app: ElectronApplication;
          try {
            app = await _electron.launch({
              executablePath,
              args: ['--awb-e2e', `--awb-user-data=${userData}`],
              env,
              chromiumSandbox: true,
              timeout: 30_000,
            });
          } catch (error) {
            throw new Error(
              `Packaged Electron launch failed: ${executablePath}. Check EnableNodeCliInspectArguments: Playwright requires the inspector fuse enabled. No launched assertion was reached.`,
              { cause: error },
            );
          }
          apps.add(app);
          const runtime = await app.evaluate(({ app }) => ({
            isPackaged: app.isPackaged,
            executable: app.getPath('exe'),
            userData: app.getPath('userData'),
            appPath: app.getAppPath(),
          }));
          expect(runtime.isPackaged).toBe(true);
          expect(await realpath(runtime.executable)).toBe(await realpath(executablePath));
          expect(await realpath(runtime.userData), 'The test-only profile override must be applied before startup').toBe(userData);
          const packagedPath = relative(dirname(executablePath), runtime.appPath);
          expect(isAbsolute(packagedPath) || packagedPath.startsWith('..'), 'App resources must belong to the resolved package').toBe(false);
          const page = await app.firstWindow();
          await expect(page.getByRole('heading', { name: '开发者智能体工作台', exact: true })).toBeVisible();
          await expect(page.getByRole('status')).toHaveText('就绪');
          await expect(page.getByRole('textbox', { name: '消息', exact: true })).toBeEnabled();
          return { app, page };
        },
      });
    } finally {
      await cleanup();
    }
  },
});

async function history(page: Page): Promise<EventEnvelope[]> {
  return page.evaluate(() => window.agent!.readConversation('default'));
}

async function submit(page: Page, text: string) {
  await page.getByRole('textbox', { name: '消息', exact: true }).fill(text);
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
}

async function snapshot(page: Page) {
  return page.evaluate(() => ({
    transcript: [...document.querySelectorAll('.transcript article')].map((message) => ({
      role: message.getAttribute('aria-label'),
      text: message.querySelector('.message-text')?.textContent,
      failed: !!message.querySelector('.message-failed'),
    })),
    trace: [...document.querySelectorAll('.trace-row')].map((row) => ({
      sequence: Number(row.querySelector('.trace-sequence')?.textContent),
      type: row.querySelector('.trace-type')?.textContent,
      occurredAt: row.querySelector('time')?.getAttribute('datetime'),
      visibleTime: row.querySelector('time')?.textContent,
    })),
  }));
}

async function assertTrace(page: Page, events: EventEnvelope[]) {
  expect(events.length).toBeGreaterThan(0);
  expect(events.map((event) => event.sequence)).toEqual(events.map((_, index) => index + 1));
  expect(new Set(events.map((event) => event.eventId)).size).toBe(events.length);
  for (const event of events) {
    expect(Number.isFinite(Date.parse(event.occurredAt))).toBe(true);
    expect(event.conversationId).toBe('default');
  }
  await expect(page.locator('.trace-row')).toHaveCount(events.length);
  const rendered = await snapshot(page);
  expect(rendered.trace.map(({ sequence, type, occurredAt }) => ({ sequence, type, occurredAt })))
    .toEqual(events.map(({ sequence, type, occurredAt }) => ({ sequence, type: EVENT_LABELS[type], occurredAt })));
  const visibleTimes = await page.evaluate((timestamps) => timestamps.map((timestamp) =>
    new Date(timestamp).toLocaleTimeString('zh-CN', { hour12: false })), events.map((event) => event.occurredAt));
  expect(rendered.trace.map((event) => event.visibleTime)).toEqual(visibleTimes);
}

async function captureLayout(app: ElectronApplication, page: Page, info: TestInfo, width: number, height: number) {
  const window = await app.browserWindow(page);
  await window.evaluate((window, size) => window.setContentSize(size.width, size.height), { width, height });
  await expect.poll(() => page.evaluate(() => ({ width: innerWidth, height: innerHeight }))).toEqual({ width, height });
  const path = info.outputPath(`conversation-${width}x${height}.png`);
  await page.screenshot({ path });
  await info.attach(`conversation-${width}x${height}`, { path, contentType: 'image/png' });
  const issues = await page.evaluate(() => {
    const problems: string[] = [];
    const rect = (selector: string) => {
      const element = document.querySelector<HTMLElement>(selector);
      if (!element) throw new Error(`Missing layout element: ${selector}`);
      return element.getBoundingClientRect();
    };
    const disjoint = (a: DOMRect, b: DOMRect) =>
      a.right <= b.left + 1 || b.right <= a.left + 1 || a.bottom <= b.top + 1 || b.bottom <= a.top + 1;
    for (const selector of ['.workbench-header', '.conversation', '.event-trace', '.transcript', '.composer', 'textarea', '.send-button']) {
      const box = rect(selector);
      if (box.width <= 0 || box.height <= 0 || box.left < -1 || box.top < -1
        || box.right > innerWidth + 1 || box.bottom > innerHeight + 1) problems.push(`${selector} is clipped or empty`);
    }
    for (const [a, b] of [
      ['.workbench-header', '.workbench-body'], ['.conversation', '.event-trace'],
      ['.transcript', '.composer'], ['textarea', '.send-button'],
      ['h1', '.provider-label'], ['.provider-label', '.connection-status'],
    ]) {
      if (!disjoint(rect(a), rect(b))) problems.push(`${a} overlaps ${b}`);
    }
    for (const selector of ['.message', '.trace-row']) {
      const rows = [...document.querySelectorAll<HTMLElement>(selector)];
      for (const [index, row] of rows.entries()) {
        if (row.scrollWidth > row.clientWidth + 1) problems.push(`${selector}[${index}] overflows horizontally`);
        if (index && !disjoint(rows[index - 1].getBoundingClientRect(), row.getBoundingClientRect())) {
          problems.push(`${selector}[${index}] overlaps previous row`);
        }
      }
    }
    for (const row of document.querySelectorAll('.trace-row')) {
      const cells = [...row.children].map((cell) => cell.getBoundingClientRect());
      if (!disjoint(cells[0], cells[1]) || !disjoint(cells[1], cells[2])) problems.push('Trace columns overlap');
    }
    for (const selector of ['h1', '.provider-label', '.connection-status', '.message-text', '.trace-type']) {
      for (const element of document.querySelectorAll<HTMLElement>(selector)) {
        if (element.scrollWidth > element.clientWidth + 1 || element.scrollHeight > element.clientHeight + 1) {
          problems.push(`${selector} text is clipped`);
        }
      }
    }
    if (document.documentElement.scrollWidth > innerWidth) problems.push('Document overflows horizontally');
    return problems;
  });
  expect(issues, `Layout at ${width}x${height}; see attached screenshot`).toEqual([]);
}

test('packaged renderer is isolated and its named bridge rejects malformed requests without journal writes', async ({ desktop }) => {
  const { app, page } = await desktop.launch();
  const browserWindow = await app.browserWindow(page);
  const preferences = await browserWindow.evaluate((window) => window.webContents.getLastWebPreferences());
  expect(preferences).toMatchObject({ sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true });
  expect(await page.evaluate(() => {
    const globals = window as unknown as Record<string, unknown>;
    return {
      require: typeof globals.require, process: typeof globals.process,
      keys: Object.keys(window.agent!).sort(),
      types: Object.values(window.agent!).map((value) => typeof value),
    };
  })).toEqual({
    require: 'undefined', process: 'undefined',
    keys: ['cancelRun', 'chooseWorkspace', 'clearWorkspace', 'decideFileEdit', 'deleteModelApiKey', 'onEvent', 'readConversation',
      'readModelSettings', 'readPendingFileEdit', 'readWorkspace', 'saveModelSettings', 'setWorkspaceConsent', 'submitMessage'],
    types: Array(13).fill('function'),
  });
  const before = await history(page);
  expect(before.map((event) => event.type)).toEqual(['conversation.created']);
  const errors = await page.evaluate(async () => {
    const bridge = window.agent as AgentBridge;
    const invalid: unknown[] = [null, {}, { conversationId: 'default', clientRequestId: 'bad', text: ' ' },
      { conversationId: 'default', clientRequestId: 'bad', text: 42 },
      { conversationId: 'default', clientRequestId: 'bad', text: 'x'.repeat(20_001) },
      { conversationId: 'elsewhere', clientRequestId: 'bad', text: 'Do not persist this' }];
    const errors: string[] = [];
    for (const request of invalid) {
      try {
        await bridge.submitMessage(request as SubmitMessageRequest);
        errors.push('ACCEPTED');
      } catch (error) { errors.push(String(error)); }
    }
    return errors;
  });
  expect(errors).toHaveLength(6);
  for (const error of errors) expect(error).toMatch(/Invalid command:/);
  expect(await history(page)).toEqual(before);
  expect(await readJournal(desktop.userData)).toEqual(before);
});

test('streams a full conversation and restores exact transcript and timestamped event order after orderly restart', async ({ desktop }, info) => {
  const { app, page } = await desktop.launch();
  const prompt = 'Explain why this local conversation survives a restart.';
  const answer = `本地模拟回复：${prompt}\n\n本次未调用真实模型、工具或网络请求。`;
  const broadcasts: EventEnvelope[] = [];
  const persistenceErrors: string[] = [];
  const observations: Promise<void>[] = [];
  await page.exposeFunction('recordPackagedEvent', (event: EventEnvelope) => {
    broadcasts.push(event);
    const observation = (async () => {
      try {
        const persisted = await readJournal(desktop.userData, 'live');
        if (!persisted.some((record) => JSON.stringify(record) === JSON.stringify(event))) {
          persistenceErrors.push(`Broadcast sequence ${event.sequence} was not present in the journal`);
        }
      } catch (error) { persistenceErrors.push(String(error)); }
    })();
    observations.push(observation);
    return observation;
  });
  await page.evaluate(() => {
    const record = (window as unknown as { recordPackagedEvent(event: EventEnvelope): Promise<void> }).recordPackagedEvent;
    window.agent!.onEvent((event) => { void record(event); });
  });
  await submit(page, prompt);
  const agent = page.getByRole('article', { name: '智能体消息', exact: true });
  await expect(agent.locator('.message-status')).toHaveText('生成中');
  await expect.poll(async () => {
    const text = await agent.locator('.message-text').textContent();
    return !!text && text.length < answer.length;
  }, { intervals: [10, 20, 30] }).toBe(true);
  await expect(agent.locator('.message-text')).toHaveText(answer);
  await expect(page.getByRole('status')).toHaveText('就绪');
  const events = await history(page);
  expect(events.slice(0, 4).map((event) => event.type)).toEqual([
    'conversation.created', 'message.user.created', 'run.started', 'message.agent.created',
  ]);
  const deltas = events.slice(4, -1);
  expect(deltas.length).toBeGreaterThan(1);
  expect(deltas.every((event) => event.type === 'message.agent.delta')).toBe(true);
  expect(deltas.map((event) => event.type === 'message.agent.delta' ? event.payload.text : '').join('')).toBe(answer);
  expect(events.at(-1)?.type).toBe('run.completed');
  await expect.poll(() => broadcasts).toEqual(events.slice(1));
  await Promise.all(observations);
  expect(persistenceErrors).toEqual([]);
  expect(await readJournal(desktop.userData)).toEqual(events);
  await assertTrace(page, events);
  const before = await snapshot(page);
  expect(before.transcript).toEqual([
    { role: '你的消息', text: prompt, failed: false },
    { role: '智能体消息', text: answer, failed: false },
  ]);
  await captureLayout(app, page, info, 1280, 800);
  await captureLayout(app, page, info, 600, 480);
  await desktop.quit(app);
  expect(await readJournal(desktop.userData)).toEqual(events);
  const restored = await desktop.launch();
  expect(await history(restored.page)).toEqual(events);
  await assertTrace(restored.page, events);
  expect(await snapshot(restored.page)).toEqual(before);
});

test('persists provider failure, accepts the next prompt, and keeps duplicate request IDs idempotent across restart', async ({ desktop }) => {
  const { app, page } = await desktop.launch();
  await submit(page, '[simulate-failure]');
  await expect(page.getByRole('alert')).toHaveText(RUN_ERROR_MESSAGES.PROVIDER_FAILED);
  await expect(page.getByRole('status')).toHaveText('就绪');
  const failed = await history(page);
  expect(failed.map((event) => event.type)).toEqual([
    'conversation.created', 'message.user.created', 'run.started', 'message.agent.created', 'run.failed',
  ]);
  expect(failed.at(-1)).toMatchObject({ payload: { code: 'PROVIDER_FAILED' } });
  await expect(page.locator('.message-failed')).toHaveText('失败');
  expect(await readJournal(desktop.userData)).toEqual(failed);
  const prompt = 'Continue successfully after the local failure.';
  const answer = `本地模拟回复：${prompt}\n\n本次未调用真实模型、工具或网络请求。`;
  await submit(page, prompt);
  await expect(page.getByRole('article', { name: '智能体消息', exact: true }).last().locator('.message-text')).toHaveText(answer);
  await expect(page.getByRole('status')).toHaveText('就绪');
  await expect(page.getByRole('alert')).toHaveCount(0);
  const events = await history(page);
  expect(events.at(-1)?.type).toBe('run.completed');
  const userEvent = events.find((event) => event.type === 'message.user.created' && event.payload.text === prompt);
  if (!userEvent || userEvent.type !== 'message.user.created') throw new Error('Successful prompt was not persisted');
  const request = { conversationId: 'default', clientRequestId: userEvent.payload.clientRequestId, text: prompt };
  await page.evaluate((request) => window.agent!.submitMessage(request), request);
  expect(await history(page)).toEqual(events);
  await assertTrace(page, events);
  const before = await snapshot(page);
  expect(before.transcript).toEqual([
    { role: '你的消息', text: '[simulate-failure]', failed: false },
    { role: '智能体消息', text: '', failed: true },
    { role: '你的消息', text: prompt, failed: false },
    { role: '智能体消息', text: answer, failed: false },
  ]);
  await desktop.quit(app);
  expect(await readJournal(desktop.userData)).toEqual(events);
  const restored = await desktop.launch();
  await restored.page.evaluate((request) => window.agent!.submitMessage(request), request);
  expect(await history(restored.page)).toEqual(events);
  expect(await readJournal(desktop.userData)).toEqual(events);
  await assertTrace(restored.page, events);
  expect(await snapshot(restored.page)).toEqual(before);
});
