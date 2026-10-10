import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export function resolveRendererUrl(options: {
  isPackaged: boolean;
  appPath: string;
  developmentEntry: string;
}): string {
  if (!options.isPackaged) return options.developmentEntry;
  return pathToFileURL(join(options.appPath, '.webpack', 'renderer', 'main_window', 'index.html')).href;
}
