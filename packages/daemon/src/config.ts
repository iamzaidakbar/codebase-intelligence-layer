import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

export interface DaemonConfig {
  workspaceRoot: string;
  storageDir: string;
  dbPath: string;
}

export const resolveConfig = (
  workspaceRoot: string,
  storageDir?: string,
): DaemonConfig => {
  const root = resolve(workspaceRoot);
  const dir = storageDir ? resolve(storageDir) : join(root, '.cil');
  mkdirSync(dir, { recursive: true });
  return {
    workspaceRoot: root,
    storageDir: dir,
    dbPath: join(dir, 'graph.db'),
  };
};
