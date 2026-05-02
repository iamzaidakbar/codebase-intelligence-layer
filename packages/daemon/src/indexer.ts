import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { GraphStore } from './db/store.js';
import { parseFile } from './parse/tsParser.js';
import type { FileEvent } from './watcher/index.js';
import { log } from './log.js';

export class Indexer {
  constructor(
    private root: string,
    private store: GraphStore,
  ) {}

  async apply(events: FileEvent[]): Promise<void> {
    for (const ev of events) {
      try {
        if (ev.type === 'unlink') {
          this.store.deleteFile(ev.relPath);
          continue;
        }
        if (!ev.contentHash || ev.size == null) continue;
        const prev = this.store.getFileHash(ev.relPath);
        if (prev === ev.contentHash) continue; // unchanged

        const source = readFileSync(join(this.root, ev.relPath), 'utf8');
        const { nodes, edges } = parseFile(ev.relPath, source);
        this.store.upsertFile(ev.relPath, ev.contentHash, ev.size);
        this.store.replaceFileSymbols(ev.relPath, nodes, edges);
      } catch (err) {
        log.warn({ err, file: ev.relPath }, 'index failed');
      }
    }
  }
}
