import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DEFAULT_TYPES } from '../shared/formats.ts';

// Lives outside the app folder so reinstalling or uninstalling the program never touches the library.
export const DATA_DIR = path.resolve(process.env.DATA_DIR ?? path.join(homedir(), 'Documents', 'Design Library'));
export const FILES_DIR = path.join(DATA_DIR, 'files');
export const THUMBS_DIR = path.join(DATA_DIR, 'thumbs');
export const TMP_DIR = path.join(DATA_DIR, 'tmp');

for (const dir of [FILES_DIR, THUMBS_DIR, TMP_DIR]) mkdirSync(dir, { recursive: true });

// The installed app and start.bat can have the library open at the same time, so writers wait for each other.
export const db = new DatabaseSync(path.join(DATA_DIR, 'library.db'), { timeout: 5000 });

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS projects (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE COLLATE NOCASE,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS products (
    id INTEGER PRIMARY KEY,
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name TEXT NOT NULL COLLATE NOCASE,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (project_id, name)
  );

  CREATE TABLE IF NOT EXISTS design_types (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE COLLATE NOCASE,
    slug TEXT UNIQUE
  );

  CREATE TABLE IF NOT EXISTS designs (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    search_text TEXT NOT NULL,
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
    product_id INTEGER REFERENCES products(id) ON DELETE RESTRICT,
    type_id INTEGER REFERENCES design_types(id) ON DELETE SET NULL,
    design_date TEXT NOT NULL,
    notes TEXT NOT NULL DEFAULT '',
    original_name TEXT NOT NULL,
    stored_path TEXT NOT NULL,
    ext TEXT NOT NULL,
    category TEXT NOT NULL,
    size INTEGER NOT NULL,
    -- none: not generated yet, ok: stored in thumbs/, failed: the browser could not render one
    thumb_state TEXT NOT NULL DEFAULT 'none',
    thumb_version INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS designs_project ON designs(project_id);
  CREATE INDEX IF NOT EXISTS designs_product ON designs(product_id);
  CREATE INDEX IF NOT EXISTS designs_type ON designs(type_id);
  CREATE INDEX IF NOT EXISTS designs_date ON designs(design_date);
  CREATE INDEX IF NOT EXISTS designs_category ON designs(category);
`);

const typeCount = db.prepare('SELECT COUNT(*) AS n FROM design_types').get() as { n: number };
if (typeCount.n === 0) {
  const insert = db.prepare('INSERT INTO design_types (name, slug) VALUES (?, ?)');
  for (const type of DEFAULT_TYPES) insert.run(type.name, type.slug);
}

// Existing libraries move forward here. Only ever add: an older copy of the app must still open the same library.
const { user_version: schemaVersion } = db.prepare('PRAGMA user_version').get() as { user_version: number };
if (schemaVersion < 1) {
  db.exec(`
    BEGIN IMMEDIATE;
    -- Empty until hashed in the background. An empty string marks a file that could not be read.
    ALTER TABLE designs ADD COLUMN sha256 TEXT;
    -- Set when the files arrived as a folder, which keeps them in their original layout on disk.
    ALTER TABLE designs ADD COLUMN package_dir TEXT;
    CREATE TABLE IF NOT EXISTS design_files (
      id INTEGER PRIMARY KEY,
      design_id INTEGER NOT NULL REFERENCES designs(id) ON DELETE CASCADE,
      rel_path TEXT NOT NULL,
      original_name TEXT NOT NULL,
      stored_path TEXT NOT NULL,
      ext TEXT NOT NULL,
      size INTEGER NOT NULL,
      sha256 TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS design_files_design ON design_files(design_id);
    CREATE INDEX IF NOT EXISTS design_files_sha ON design_files(sha256);
    CREATE INDEX IF NOT EXISTS designs_sha ON designs(sha256);
    INSERT OR IGNORE INTO design_types (name, slug) VALUES ('PCB', 'pcb');
    PRAGMA user_version = 1;
    COMMIT;
  `);
}
