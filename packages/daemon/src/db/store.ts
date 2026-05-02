import Database from 'better-sqlite3';
import type {
  EdgeKind,
  GraphEdge,
  GraphNode,
  NodeKind,
} from '@cil/protocol';
import { migrate } from './schema.js';

interface NodeRow {
  id: string;
  kind: NodeKind;
  name: string;
  file_path: string;
  start_line: number;
  end_line: number;
  signature: string | null;
  content_hash: string;
}

interface EdgeRow {
  id: string;
  src: string;
  dst: string;
  kind: EdgeKind;
  src_file: string;
}

const rowToNode = (row: NodeRow): GraphNode => ({
  id: row.id,
  kind: row.kind,
  name: row.name,
  filePath: row.file_path,
  startLine: row.start_line,
  endLine: row.end_line,
  signature: row.signature ?? undefined,
  contentHash: row.content_hash,
});

const rowToEdge = (row: EdgeRow): GraphEdge => ({
  id: row.id,
  src: row.src,
  dst: row.dst,
  kind: row.kind,
});

export type Direction = 'in' | 'out' | 'both';

export class GraphStore {
  private db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    migrate(this.db);
  }

  // ---- file lifecycle -------------------------------------------------------

  upsertFile(path: string, contentHash: string, bytes: number): void {
    this.db
      .prepare(
        `INSERT INTO files (path, content_hash, last_indexed_at, bytes)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(path) DO UPDATE SET
           content_hash = excluded.content_hash,
           last_indexed_at = excluded.last_indexed_at,
           bytes = excluded.bytes`,
      )
      .run(path, contentHash, Date.now(), bytes);
  }

  getFileHash(path: string): string | undefined {
    const row = this.db
      .prepare(`SELECT content_hash FROM files WHERE path = ?`)
      .get(path) as { content_hash: string } | undefined;
    return row?.content_hash;
  }

  deleteFile(path: string): void {
    const tx = this.db.transaction((p: string) => {
      this.db.prepare(`DELETE FROM edges WHERE src_file = ?`).run(p);
      this.db.prepare(`DELETE FROM files WHERE path = ?`).run(p);
    });
    tx(path);
  }

  // ---- bulk replace (used by indexer) --------------------------------------

  replaceFileSymbols(
    filePath: string,
    nodes: GraphNode[],
    edges: GraphEdge[],
  ): void {
    const insertNode = this.db.prepare(
      `INSERT OR REPLACE INTO nodes
       (id, kind, name, file_path, start_line, end_line, signature, content_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insertEdge = this.db.prepare(
      `INSERT OR REPLACE INTO edges (id, src, dst, kind, src_file)
       VALUES (?, ?, ?, ?, ?)`,
    );
    const deleteNodes = this.db.prepare(
      `DELETE FROM nodes WHERE file_path = ?`,
    );
    const deleteEdges = this.db.prepare(
      `DELETE FROM edges WHERE src_file = ?`,
    );

    const tx = this.db.transaction((ns: GraphNode[], es: GraphEdge[]) => {
      deleteEdges.run(filePath);
      deleteNodes.run(filePath);
      for (const n of ns) {
        insertNode.run(
          n.id,
          n.kind,
          n.name,
          n.filePath,
          n.startLine,
          n.endLine,
          n.signature ?? null,
          n.contentHash,
        );
      }
      for (const e of es) {
        insertEdge.run(e.id, e.src, e.dst, e.kind, filePath);
      }
    });
    tx(nodes, edges);
  }

  /** Replace just the edges originating in a file (semantic pass result). */
  replaceFileEdges(filePath: string, edges: GraphEdge[]): void {
    const insertEdge = this.db.prepare(
      `INSERT OR REPLACE INTO edges (id, src, dst, kind, src_file)
       VALUES (?, ?, ?, ?, ?)`,
    );
    const deleteEdges = this.db.prepare(
      `DELETE FROM edges WHERE src_file = ?`,
    );
    const tx = this.db.transaction((es: GraphEdge[]) => {
      deleteEdges.run(filePath);
      for (const e of es) insertEdge.run(e.id, e.src, e.dst, e.kind, filePath);
    });
    tx(edges);
  }

  // ---- node lookup ---------------------------------------------------------

  getNode(id: string): GraphNode | undefined {
    const row = this.db
      .prepare(`SELECT * FROM nodes WHERE id = ?`)
      .get(id) as NodeRow | undefined;
    return row ? rowToNode(row) : undefined;
  }

  /** Locate a node by (file, name, line ± tolerance). Used to map
   *  ts-morph RawLocations to tree-sitter-produced node IDs. The ±tolerance
   *  absorbs minor disagreements between the two parsers about where a
   *  declaration starts. */
  findNodeByLocation(
    filePath: string,
    name: string,
    line: number,
    tolerance = 2,
  ): GraphNode | undefined {
    const row = this.db
      .prepare(
        `SELECT *, ABS(start_line - ?) AS distance
         FROM nodes
         WHERE file_path = ? AND name = ? AND start_line BETWEEN ? AND ?
         ORDER BY distance ASC
         LIMIT 1`,
      )
      .get(line, filePath, name, line - tolerance, line + tolerance) as
      | (NodeRow & { distance: number })
      | undefined;
    return row ? rowToNode(row) : undefined;
  }

  /** File node lookup (well-known ID scheme). */
  getFileNode(filePath: string): GraphNode | undefined {
    return this.getNode(`file:${filePath}`);
  }

  listSymbols(opts: {
    filePath?: string;
    kind?: NodeKind;
    limit?: number;
  }): GraphNode[] {
    const limit = Math.min(opts.limit ?? 200, 1000);
    const where: string[] = [];
    const params: unknown[] = [];
    if (opts.filePath) {
      where.push('file_path = ?');
      params.push(opts.filePath);
    }
    if (opts.kind) {
      where.push('kind = ?');
      params.push(opts.kind);
    }
    const sql = `SELECT * FROM nodes ${
      where.length ? 'WHERE ' + where.join(' AND ') : ''
    } ORDER BY file_path, start_line LIMIT ?`;
    params.push(limit);
    const rows = this.db.prepare(sql).all(...params) as NodeRow[];
    return rows.map(rowToNode);
  }

  // ---- edge queries --------------------------------------------------------

  /** Edges incident to a node. */
  edgesFor(
    nodeId: string,
    direction: Direction,
    kind?: EdgeKind,
  ): GraphEdge[] {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (direction === 'in' || direction === 'both') {
      clauses.push('dst = ?');
      params.push(nodeId);
    }
    if (direction === 'out' || direction === 'both') {
      clauses.push('src = ?');
      params.push(nodeId);
    }
    let sql = `SELECT * FROM edges WHERE (${clauses.join(' OR ')})`;
    if (kind) {
      sql += ' AND kind = ?';
      params.push(kind);
    }
    const rows = this.db.prepare(sql).all(...params) as EdgeRow[];
    return rows.map(rowToEdge);
  }

  getNodes(ids: readonly string[]): GraphNode[] {
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => '?').join(',');
    const rows = this.db
      .prepare(`SELECT * FROM nodes WHERE id IN (${placeholders})`)
      .all(...ids) as NodeRow[];
    return rows.map(rowToNode);
  }

  /** k-hop subgraph around a seed. Hard cap on visited nodes to prevent runaway. */
  neighborhood(
    seed: string,
    depth: number,
    direction: Direction,
    cap = 500,
  ): { nodes: GraphNode[]; edges: GraphEdge[] } {
    const visited = new Set<string>([seed]);
    const collectedEdges = new Map<string, GraphEdge>();
    let frontier: string[] = [seed];

    for (let d = 0; d < depth && frontier.length > 0; d++) {
      const nextFrontier = new Set<string>();
      for (const id of frontier) {
        const edges = this.edgesFor(id, direction);
        for (const e of edges) {
          collectedEdges.set(e.id, e);
          const other = e.src === id ? e.dst : e.src;
          if (!visited.has(other) && visited.size < cap) {
            visited.add(other);
            nextFrontier.add(other);
          }
        }
      }
      frontier = [...nextFrontier];
    }

    return {
      nodes: this.getNodes([...visited]),
      edges: [...collectedEdges.values()],
    };
  }

  // ---- file enumeration (for ts-morph project hydration) -------------------

  listFiles(): string[] {
    const rows = this.db.prepare(`SELECT path FROM files`).all() as {
      path: string;
    }[];
    return rows.map((r) => r.path);
  }

  // ---- embeddings ----------------------------------------------------------

  /** Of the supplied content_hashes, return those that don't yet have an
   *  embedding for the given model. Ordering matches the input. */
  missingEmbeddings(contentHashes: readonly string[], model: string): string[] {
    if (contentHashes.length === 0) return [];
    // Single query with parameter expansion; SQLite limit is 999 by default.
    const CHUNK = 500;
    const present = new Set<string>();
    for (let i = 0; i < contentHashes.length; i += CHUNK) {
      const slice = contentHashes.slice(i, i + CHUNK);
      const placeholders = slice.map(() => '?').join(',');
      const rows = this.db
        .prepare(
          `SELECT content_hash FROM embeddings
           WHERE model = ? AND content_hash IN (${placeholders})`,
        )
        .all(model, ...slice) as { content_hash: string }[];
      for (const r of rows) present.add(r.content_hash);
    }
    return contentHashes.filter((h) => !present.has(h));
  }

  upsertEmbeddings(
    rows: readonly { contentHash: string; vector: Float32Array }[],
    model: string,
    dim: number,
  ): void {
    const stmt = this.db.prepare(
      `INSERT OR REPLACE INTO embeddings
         (content_hash, model, dim, vector, embedded_at)
       VALUES (?, ?, ?, ?, ?)`,
    );
    const now = Date.now();
    const tx = this.db.transaction(
      (rs: readonly { contentHash: string; vector: Float32Array }[]) => {
        for (const r of rs) {
          stmt.run(
            r.contentHash,
            model,
            dim,
            Buffer.from(r.vector.buffer, r.vector.byteOffset, r.vector.byteLength),
            now,
          );
        }
      },
    );
    tx(rows);
  }

  /** Stream all embedded nodes for a model. Used for brute-force cosine search. */
  *iterEmbeddedNodes(
    model: string,
  ): Generator<{ node: GraphNode; vector: Float32Array }> {
    const stmt = this.db.prepare(
      `SELECT n.*, e.vector AS vec, e.dim AS dim
       FROM nodes n
       JOIN embeddings e ON n.content_hash = e.content_hash
       WHERE e.model = ?`,
    );
    for (const row of stmt.iterate(model) as IterableIterator<
      NodeRow & { vec: Buffer; dim: number }
    >) {
      const vector = new Float32Array(
        row.vec.buffer,
        row.vec.byteOffset,
        row.dim,
      );
      yield { node: rowToNode(row), vector };
    }
  }

  embeddingCount(model: string): number {
    return (
      this.db
        .prepare(`SELECT COUNT(*) AS c FROM embeddings WHERE model = ?`)
        .get(model) as { c: number }
    ).c;
  }

  // ---- summaries -----------------------------------------------------------

  getSummary(
    contentHash: string,
    model: string,
    promptVersion: string,
  ): string | undefined {
    const row = this.db
      .prepare(
        `SELECT summary FROM summaries
         WHERE content_hash = ? AND model = ? AND prompt_version = ?`,
      )
      .get(contentHash, model, promptVersion) as
      | { summary: string }
      | undefined;
    return row?.summary;
  }

  putSummary(
    contentHash: string,
    model: string,
    promptVersion: string,
    summary: string,
  ): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO summaries
           (content_hash, model, prompt_version, summary, generated_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(contentHash, model, promptVersion, summary, Date.now());
  }

  summaryCount(model: string, promptVersion: string): number {
    return (
      this.db
        .prepare(
          `SELECT COUNT(*) AS c FROM summaries
           WHERE model = ? AND prompt_version = ?`,
        )
        .get(model, promptVersion) as { c: number }
    ).c;
  }

  /** Garbage-collect embeddings whose content_hash no longer matches any node. */
  pruneOrphanEmbeddings(): number {
    const res = this.db
      .prepare(
        `DELETE FROM embeddings
         WHERE content_hash NOT IN (SELECT DISTINCT content_hash FROM nodes)`,
      )
      .run();
    return res.changes;
  }

  counts(): {
    files: number;
    nodes: number;
    edges: number;
    embeddings: number;
  } {
    const f = this.db.prepare(`SELECT COUNT(*) AS c FROM files`).get() as { c: number };
    const n = this.db.prepare(`SELECT COUNT(*) AS c FROM nodes`).get() as { c: number };
    const e = this.db.prepare(`SELECT COUNT(*) AS c FROM edges`).get() as { c: number };
    const m = this.db.prepare(`SELECT COUNT(*) AS c FROM embeddings`).get() as { c: number };
    return { files: f.c, nodes: n.c, edges: e.c, embeddings: m.c };
  }

  close(): void {
    this.db.close();
  }
}
