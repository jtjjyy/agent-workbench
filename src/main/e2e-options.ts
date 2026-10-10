import { isAbsolute } from 'node:path';

export function resolveTestUserData(args: string[]): string | undefined {
  if (!args.includes('--awb-e2e')) return undefined;
  const overrides = args.filter((argument) => argument.startsWith('--awb-user-data='));
  if (overrides.length !== 1) throw new Error('E2E requires exactly one isolated user-data directory');
  const directory = overrides[0].slice('--awb-user-data='.length);
  if (!isAbsolute(directory)) throw new Error('E2E user-data directory must be absolute');
  return directory;
}
