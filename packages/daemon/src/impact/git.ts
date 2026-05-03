import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { sep } from 'node:path';
import { log } from '../log.js';

const exec = promisify(execFile);
const toPosix = (p: string): string => (sep === '/' ? p : p.split(sep).join('/'));

/** Per-file commit count over a window. Built once at daemon start; refresh
 *  on demand via `refresh()`. Best-effort — non-git workspaces get an empty
 *  map and downstream scoring treats every file as zero churn. */
export class GitChurn {
  private counts = new Map<string, number>();
  private ready = false;

  constructor(
    private root: string,
    private windowDays = 30,
  ) {}

  isReady(): boolean {
    return this.ready;
  }

  /** Returns commits touching `relPath` in the window. 0 if missing or non-git. */
  countFor(relPath: string): number {
    return this.counts.get(toPosix(relPath)) ?? 0;
  }

  async refresh(): Promise<void> {
    this.counts.clear();
    try {
      // One pass: list all commits in the window with the files they touched.
      const { stdout } = await exec(
        'git',
        [
          'log',
          `--since=${this.windowDays}.days.ago`,
          '--name-only',
          '--pretty=format:',
        ],
        { cwd: this.root, maxBuffer: 64 * 1024 * 1024 },
      );
      for (const line of stdout.split('\n')) {
        const path = line.trim();
        if (!path) continue;
        this.counts.set(path, (this.counts.get(path) ?? 0) + 1);
      }
      this.ready = true;
      log.info(
        { files: this.counts.size, windowDays: this.windowDays },
        'git churn loaded',
      );
    } catch (err) {
      log.info(
        { err: err instanceof Error ? err.message : String(err) },
        'git churn unavailable (non-git workspace or git not installed)',
      );
      this.ready = false;
    }
  }
}
