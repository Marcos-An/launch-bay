import { homedir } from 'node:os';
import { join } from 'node:path';

export function expandHome(path: string) {
  if (path === '~') return homedir();
  if (path.startsWith('~/')) return join(homedir(), path.slice(2));
  return path;
}
