import { defineConfig } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import forgeConfig from './forge.config.mjs';

const root = fileURLToPath(new URL('.', import.meta.url));
const metadata = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as {
  name: string;
  productName?: string;
};
const packager = forgeConfig.packagerConfig ?? {};
const names = packager.name
  ? [packager.name]
  : [...new Set([metadata.name, metadata.productName].filter((name): name is string => !!name))];
const executableNames = packager.executableName ? [packager.executableName] : names;
const identifier = typeof forgeConfig.buildIdentifier === 'function'
  ? forgeConfig.buildIdentifier() : forgeConfig.buildIdentifier;
const out = resolve(root, forgeConfig.outDir ?? 'out', identifier || '');
const packagedExecutables = names.flatMap((name) => executableNames.map((executable) =>
  resolve(out, `${name}-win32-${process.arch}`, `${executable}.exe`)));

export default defineConfig({
  testDir: './tests/e2e',
  testMatch: '**/*.e2e.ts',
  outputDir: './test-results',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 90_000,
  expect: { timeout: 10_000 },
  reporter: [['list']],
  metadata: { packagedExecutables, packageName: metadata.name, productName: metadata.productName },
});
