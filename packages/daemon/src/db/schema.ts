import type Database from 'better-sqlite3';

const SCHEMA_VERSION = 3;

const MIGRATIONS: string[] = [
  // v1 -> initial schema
  `
  CREATE TABLE IF NOT EXISTS files (
    path TEXT PRIMARY KEY,
    content_hash TEXT NOT NULL,
    last_indexed_at INTEGER NOT NULL,
    bytes INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS nodes (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    name TEXT NOT NULL,
    file_path TEXT NOT NULL,
    start_line INTEGER NOT NULL,
    end_line INTEGER NOT NULL,
    signature TEXT,
    content_hash TEXT NOT NULL,
    FOREIGN KEY (file_path) REFERENCES files(path) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_nodes_file ON nodes(file_path);
  CREATE INDEX IF NOT EXISTS idx_nodes_kind ON nodes(kind);
  CREATE INDEX IF NOT EXISTS idx_nodes_name ON nodes(name);
  CREATE INDEX IF NOT EXISTS idx_nodes_content_hash ON nodes(content_hash);

  CREATE TABLE IF NOT EXISTS edges (
    id TEXT PRIMARY KEY,
    src TEXT NOT NULL,
    dst TEXT NOT NULL,
    kind TEXT NOT NULL,
    src_file TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_edges_src ON edges(src, kind);
  CREATE INDEX IF NOT EXISTS idx_edges_dst ON edges(dst, kind);
  CREATE INDEX IF NOT EXISTS idx_edges_src_file ON edges(src_file);
  `,
  // v2 -> content-addressed embeddings
  `
  CREATE TABLE IF NOT EXISTS embeddings (
    content_hash TEXT NOT NULL,
    model TEXT NOT NULL,
    dim INTEGER NOT NULL,
    vector BLOB NOT NULL,
    embedded_at INTEGER NOT NULL,
    PRIMARY KEY (content_hash, model)
  );
  CREATE INDEX IF NOT EXISTS idx_embeddings_model ON embeddings(model);
  `,
  // v3 -> content-addressed LLM summaries
  `
  CREATE TABLE IF NOT EXISTS summaries (
    content_hash TEXT NOT NULL,
    model TEXT NOT NULL,
    prompt_version TEXT NOT NULL,
    summary TEXT NOT NULL,
    generated_at INTEGER NOT NULL,
    PRIMARY KEY (content_hash, model, prompt_version)
  );
  CREATE INDEX IF NOT EXISTS idx_summaries_model ON summaries(model);
  `,
];

export const migrate = (db: Database.Database): void => {
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(
    `CREATE TABLE IF NOT EXISTS schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);`,
  );
  const row = db
    .prepare(`SELECT value FROM schema_meta WHERE key = 'version'`)
    .get() as { value: string } | undefined;
  const current = row ? parseInt(row.value, 10) : 0;
  for (let v = current; v < SCHEMA_VERSION; v++) {
    const migration = MIGRATIONS[v];
    if (migration) db.exec(migration);
  }
  db.prepare(
    `INSERT OR REPLACE INTO schema_meta (key, value) VALUES ('version', ?)`,
  ).run(String(SCHEMA_VERSION));
};
