const { _electron } = require('@playwright/test');
const assert = require('node:assert/strict');
const { cp, mkdir, mkdtemp, readFile } = require('node:fs/promises');
const { resolve, join } = require('node:path');

async function verify() {
  const root = resolve('work/verification');
  await mkdir(root, { recursive: true });
  const isolated = await mkdtemp(join(root, 'path # percent%20-'));
  const packageRoot = join(isolated, 'Agent Workbench');
  const profile = join(isolated, 'profile');
  await cp(resolve('out/Agent Workbench-win32-x64'), packageRoot, {
    recursive: true, force: false, errorOnExist: true,
  });
  const env = Object.fromEntries(Object.entries(process.env).filter(
    ([key]) => key.toUpperCase() !== 'ELECTRON_RUN_AS_NODE',
  ));
  const app = await _electron.launch({
    executablePath: join(packageRoot, 'Agent Workbench.exe'),
    args: ['--awb-e2e', `--awb-user-data=${profile}`],
    chromiumSandbox: true,
    env,
  });
  const child = app.process();
  try {
    const page = await app.firstWindow();
    await page.getByRole('status').filter({ hasText: /^Ready$/ }).waitFor();
    assert.ok(page.url().includes('%23'));
    assert.ok(page.url().includes('%2520'));
    const runtime = await app.evaluate(({ app }) => ({
      packaged: app.isPackaged, executable: app.getPath('exe'),
    }));
    assert.equal(runtime.packaged, true);
    assert.equal(runtime.executable, join(packageRoot, 'Agent Workbench.exe'));
    await page.getByRole('textbox', { name: 'Message', exact: true }).fill('Special path verification');
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    await page.getByRole('article', { name: 'Agent message', exact: true })
      .getByText(/No model, tools, or network requests were used/).waitFor();
    await page.getByRole('status').filter({ hasText: /^Ready$/ }).waitFor();
    const history = await page.evaluate(() => window.agent.readConversation('default'));
    assert.equal(history.at(-1).type, 'run.completed');
    const journal = await readFile(join(profile, 'events', 'conversation-v1.jsonl'), 'utf8');
    assert.deepEqual(journal.trimEnd().split('\n').map(JSON.parse), history);
    console.log(JSON.stringify({ result: 'PASS', url: page.url(), runtime, eventCount: history.length }, null, 2));
  } finally {
    await app.close();
  }
  assert.equal(child.exitCode, 0);
  console.log('Orderly exit: 0. Isolated package and profile preserved under work/verification.');
}

verify().catch((error) => { console.error(error); process.exitCode = 1; });
