import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { EdgeKind, GraphEdge, GraphNode } from '@cil/protocol';
import type { GraphStore } from './db/store.js';
import type { EmbeddingProvider } from './embed/index.js';
import { hash } from './hash.js';
import { log } from './log.js';
import { parseFile } from './parse/tsParser.js';
import {
  TsResolver,
  type RawEdge,
  type RawLocation,
} from './parse/tsResolver.js';
import type { FileEvent } from './watcher/index.js';

const edgeId = (src: string, kind: EdgeKind, dst: string): string =>
  hash(`${src}|${kind}|${dst}`);

const fileNodeId = (filePath: string): string => `file:${filePath}`;

const MAX_EMBED_CHARS = 4000;

/** Per-file work product handed from the structural pass to later stages. */
export interface FileWork {
  relPath: string;
  source: string;
  nodes: GraphNode[];
}

const sliceSymbolText = (sourceLines: string[], node: GraphNode): string => {
  const slice = sourceLines.slice(node.startLine, node.endLine + 1).join('\n');
  // Prepend kind + name so identifier signal is in the embedding even if
  // the body is short or trimmed.
  const text = `${node.kind} ${node.name} (${node.filePath})\n${slice}`;
  return text.length > MAX_EMBED_CHARS ? text.slice(0, MAX_EMBED_CHARS) : text;
};

export class Indexer {
  private resolver: TsResolver;

  constructor(
    private root: string,
    private store: GraphStore,
    private provider: EmbeddingProvider | null = null,
  ) {
    this.resolver = new TsResolver(root);
  }

  setProvider(provider: EmbeddingProvider | null): void {
    this.provider = provider;
  }

  /** Tree-sitter pass over a batch of file events. Returns the work products
   *  for downstream stages (semantic + embedding). */
  async applyStructural(events: FileEvent[]): Promise<FileWork[]> {
    const work: FileWork[] = [];
    for (const ev of events) {
      try {
        if (ev.type === 'unlink') {
          this.store.deleteFile(ev.relPath);
          this.resolver.removeFile(join(this.root, ev.relPath));
          continue;
        }
        if (!ev.contentHash || ev.size == null) continue;
        const prev = this.store.getFileHash(ev.relPath);
        if (prev === ev.contentHash) continue;

        const source = readFileSync(join(this.root, ev.relPath), 'utf8');
        const { nodes, edges } = parseFile(ev.relPath, source);
        this.store.upsertFile(ev.relPath, ev.contentHash, ev.size);
        this.store.replaceFileSymbols(ev.relPath, nodes, edges);
        work.push({ relPath: ev.relPath, source, nodes });
      } catch (err) {
        log.warn({ err, file: ev.relPath }, 'structural index failed');
      }
    }
    return work;
  }

  /** Hydrate the ts-morph project from the file list currently in the store. */
  hydrateResolver(): number {
    const files = this.store.listFiles().map((p) => join(this.root, p));
    return this.resolver.addFiles(files);
  }

  async applySemantic(relPath: string): Promise<void> {
    const abs = join(this.root, relPath);
    this.resolver.refreshFile(abs);
    const raw = this.resolver.extractEdges(abs);
    const resolved = this.resolveEdges(relPath, raw);
    this.store.replaceFileEdges(relPath, resolved);
  }

  /** Embed any symbols in `work` whose content_hash isn't already cached. */
  async applyEmbedding(work: FileWork): Promise<number> {
    if (!this.provider) return 0;
    const candidates = work.nodes.filter(
      (n) => n.kind !== 'file' && n.kind !== 'variable',
    );
    if (candidates.length === 0) return 0;

    const missingHashes = this.store.missingEmbeddings(
      candidates.map((c) => c.contentHash),
      this.provider.model,
    );
    if (missingHashes.length === 0) return 0;

    const missingSet = new Set(missingHashes);
    const sourceLines = work.source.split('\n');

    // Dedupe by content_hash — multiple symbols can share one hash.
    const byHash = new Map<string, GraphNode>();
    for (const n of candidates) {
      if (missingSet.has(n.contentHash) && !byHash.has(n.contentHash)) {
        byHash.set(n.contentHash, n);
      }
    }
    if (byHash.size === 0) return 0;

    const items = [...byHash.entries()].map(([h, node]) => ({
      contentHash: h,
      text: sliceSymbolText(sourceLines, node),
    }));

    try {
      const vectors = await this.provider.embed(items.map((i) => i.text));
      this.store.upsertEmbeddings(
        items.map((it, i) => ({
          contentHash: it.contentHash,
          vector: vectors[i]!,
        })),
        this.provider.model,
        this.provider.dim,
      );
      return items.length;
    } catch (err) {
      log.warn({ err, file: work.relPath }, 'embedding failed');
      return 0;
    }
  }

  /** Initial-scan orchestration: structural → ts-morph hydrate → semantic →
   *  embedding. Each stage reports its own progress. */
  async runInitialScan(
    events: FileEvent[],
    onStructural: (done: number, total: number) => void,
    onSemantic: (done: number, total: number) => void,
    onEmbedding: (done: number, total: number, embedded: number) => void,
  ): Promise<void> {
    const CHUNK = 50;
    const allWork: FileWork[] = [];
    for (let i = 0; i < events.length; i += CHUNK) {
      const slice = events.slice(i, i + CHUNK);
      const w = await this.applyStructural(slice);
      allWork.push(...w);
      onStructural(Math.min(i + CHUNK, events.length), events.length);
    }

    const added = this.hydrateResolver();
    log.info({ added }, 'ts-morph project hydrated');

    const indexedFiles = allWork.map((w) => w.relPath);
    for (let i = 0; i < indexedFiles.length; i++) {
      await this.applySemantic(indexedFiles[i]!);
      if ((i + 1) % 10 === 0 || i === indexedFiles.length - 1) {
        onSemantic(i + 1, indexedFiles.length);
      }
    }

    if (this.provider) {
      let embedded = 0;
      for (let i = 0; i < allWork.length; i++) {
        embedded += await this.applyEmbedding(allWork[i]!);
        if ((i + 1) % 5 === 0 || i === allWork.length - 1) {
          onEmbedding(i + 1, allWork.length, embedded);
        }
      }
    }
  }

  // ---- internal: edge resolution ------------------------------------------

  private resolveEdges(filePath: string, raw: RawEdge[]): GraphEdge[] {
    const fileId = fileNodeId(filePath);
    const out: GraphEdge[] = [];
    const seen = new Set<string>();
    const push = (e: GraphEdge) => {
      if (seen.has(e.id)) return;
      seen.add(e.id);
      out.push(e);
    };

    const symbols = this.store.listSymbols({ filePath, limit: 1000 });
    for (const sym of symbols) {
      if (sym.kind === 'file') continue;
      push({
        id: edgeId(fileId, 'contains', sym.id),
        src: fileId,
        dst: sym.id,
        kind: 'contains',
      });
    }

    for (const r of raw) {
      const srcId = this.resolveLocation(r.src);
      const dstId = this.resolveLocation(r.dst);
      if (!srcId || !dstId) continue;
      const ek = r.kind as EdgeKind;
      push({ id: edgeId(srcId, ek, dstId), src: srcId, dst: dstId, kind: ek });
    }
    return out;
  }

  private resolveLocation(loc: RawLocation): string | undefined {
    if (loc.kind === 'file') {
      return this.store.getFileNode(loc.filePath)?.id;
    }
    return this.store.findNodeByLocation(loc.filePath, loc.name, loc.line)?.id;
  }
}
