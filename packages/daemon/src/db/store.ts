import Database from 'better-sqlite3';
import type { GraphEdge, GraphNode, NodeKind } from '@cil/protocol';
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

export class GraphStore {
  private db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    migrate(this.db);
  }

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

  /** Cascades to nodes via FK; edges are removed via src_file. */
  deleteFile(path: string): void {
    const tx = this.db.transaction((p: string) => {
      this.db.prepare(`DELETE FROM edges WHERE src_file = ?`).run(p);
      this.db.prepare(`DELETE FROM files WHERE path = ?`).run(p);
    });
    tx(path);
  }

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

  getNode(id: string): GraphNode | undefined {
    const row = this.db
      .prepare(`SELECT * FROM nodes WHERE id = ?`)
      .get(id) as NodeRow | undefined;
    return row ? rowToNode(row) : undefined;
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

  counts(): { files: number; nodes: number; edges: number } {
    const f = this.db.prepare(`SELECT COUNT(*) AS c FROM files`).get() as { c: number };
    const n = this.db.prepare(`SELECT COUNT(*) AS c FROM nodes`).get() as { c: number };
    const e = this.db.prepare(`SELECT COUNT(*) AS c FROM edges`).get() as { c: number };
    return { files: f.c, nodes: n.c, edges: e.c };
  }

  close(): void {
    this.db.close();
  }
}
