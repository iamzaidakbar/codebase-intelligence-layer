import chokidar, { type FSWatcher } from 'chokidar';
import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, relative, sep } from 'node:path';
import type { Ignore } from 'ignore';
import { hash } from '../hash.js';
import { log } from '../log.js';

const ignore = createRequire(import.meta.url)('ignore') as (
  options?: { ignorecase?: boolean },
) => Ignore;

export interface FileEvent {
  type: 'add' | 'change' | 'unlink';
  relPath: string;
  contentHash?: string;
  size?: number;
}

const SUPPORTED_EXTS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts']);
const HARD_IGNORES = ['node_modules', 'dist', '.git', '.cil'];

const toPosix = (p: string): string => (sep === '/' ? p : p.split(sep).join('/'));

const supportedExt = (relPath: string): boolean => {
  const dot = relPath.lastIndexOf('.');
  if (dot === -1) return false;
  return SUPPORTED_EXTS.has(relPath.slice(dot));
};

export class Watcher {
  private watcher?: FSWatcher;
  private ig: Ignore;
  private debounce = new Map<string, NodeJS.Timeout>();
  private readonly debounceMs = 200;

  constructor(
    private root: string,
    private onBatch: (events: FileEvent[]) => Promise<void>,
  ) {
    this.ig = ignore().add(HARD_IGNORES);
    try {
      const gi = readFileSync(join(root, '.gitignore'), 'utf8');
      this.ig.add(gi);
    } catch {
      /* no .gitignore is fine */
    }
  }

  private isIgnored(relPath: string): boolean {
    if (!relPath) return true;
    return this.ig.ignores(toPosix(relPath));
  }

  private hashFile(absPath: string): { contentHash: string; size: number } | undefined {
    try {
      const buf = readFileSync(absPath);
      return { contentHash: hash(buf), size: buf.byteLength };
    } catch (err) {
      log.warn({ err, absPath }, 'failed to read file');
      return undefined;
    }
  }

  /** Synchronous initial walk producing add events for every supported file. */
  initialScan(): FileEvent[] {
    const events: FileEvent[] = [];
    const walk = (dir: string): void => {
      let entries;
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const abs = join(dir, entry.name);
        const rel = relative(this.root, abs);
        if (this.isIgnored(rel)) continue;
        if (entry.isDirectory()) {
          walk(abs);
        } else if (entry.isFile() && supportedExt(rel)) {
          const h = this.hashFile(abs);
          if (h) events.push({ type: 'add', relPath: toPosix(rel), ...h });
        }
      }
    };
    walk(this.root);
    return events;
  }

  start(): void {
    this.watcher = chokidar.watch(this.root, {
      ignoreInitial: true,
      ignored: (p: string) => {
        const rel = relative(this.root, p);
        if (!rel) return false;
        return this.isIgnored(rel);
      },
      persistent: true,
      awaitWriteFinish: { stabilityThreshold: 50, pollInterval: 25 },
    });

    const queue = (type: FileEvent['type'], abs: string) => {
      const rel = toPosix(relative(this.root, abs));
      if (!rel) return;
      if (type !== 'unlink' && !supportedExt(rel)) return;
      if (this.isIgnored(rel)) return;

      const existing = this.debounce.get(rel);
      if (existing) clearTimeout(existing);
      this.debounce.set(
        rel,
        setTimeout(() => {
          this.debounce.delete(rel);
          if (type === 'unlink') {
            void this.onBatch([{ type, relPath: rel }]);
            return;
          }
          const h = this.hashFile(abs);
          if (h) void this.onBatch([{ type, relPath: rel, ...h }]);
        }, this.debounceMs),
      );
    };

    this.watcher
      .on('add', (p) => queue('add', p))
      .on('change', (p) => queue('change', p))
      .on('unlink', (p) => queue('unlink', p))
      .on('error', (err) => log.warn({ err }, 'watcher error'));
  }

  async stop(): Promise<void> {
    for (const t of this.debounce.values()) clearTimeout(t);
    this.debounce.clear();
    await this.watcher?.close();
  }
}
