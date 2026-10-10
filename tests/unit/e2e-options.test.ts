import { expect, test } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { resolveTestUserData } from '../../src/main/e2e-options';

test('normal launch ignores a supplied data override without explicit E2E flag', () => {
  expect(resolveTestUserData([`--awb-user-data=${join(tmpdir(), 'awb-test')}`])).toBeUndefined();
});
test('explicit E2E accepts one absolute user data path', () => {
  const directory = join(tmpdir(), 'awb-test');
  expect(resolveTestUserData(['--awb-e2e', `--awb-user-data=${directory}`])).toBe(directory);
});
test('explicit E2E rejects missing, duplicate, empty or relative paths', () => {
  for (const args of [
    ['--awb-e2e'], ['--awb-e2e', '--awb-user-data='],
    ['--awb-e2e', '--awb-user-data=relative/path'],
    ['--awb-e2e', `--awb-user-data=${tmpdir()}`, `--awb-user-data=${tmpdir()}`],
  ]) expect(() => resolveTestUserData(args)).toThrow();
});
