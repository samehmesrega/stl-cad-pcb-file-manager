import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, readdirSync, rmSync } from 'node:fs';
import type { WriteStream } from 'node:fs';
import { mkdir, rename, rm, rmdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import busboy from 'busboy';
import express from 'express';
import type { NextFunction, Request, Response } from 'express';
import { extensionOf, formatOf, normalizeSearch, stripExtension } from '../shared/formats.ts';
import { translate } from '../shared/i18n.ts';
import type { MessageKey, MessageValues } from '../shared/i18n.ts';
import { DATA_DIR, THUMBS_DIR, TMP_DIR, db } from './db.ts';

const ROOT = path.join(import.meta.dirname, '..');
const DIST = path.join(ROOT, 'dist');
const PAGE_SIZE = 60;
/** Windows refuses longer paths in many programs, including the ones these files open in. */
const MAX_DISK_PATH = 240;
/** "Open in its program" would run these instead of opening them. */
const NEVER_OPEN = new Set(
  'exe bat cmd com msi msp ps1 psm1 vbs vbe js jse wsf wsh scr pif lnk reg hta cpl jar url appref-ms scf inf msc dll'.split(' '),
);

// Uploads cut off by a crash or a closed window leave partial files here.
for (const name of readdirSync(TMP_DIR)) rmSync(path.join(TMP_DIR, name), { force: true });

class HttpError extends Error {
  status: number;
  values?: MessageValues;
  constructor(status: number, message: MessageKey, values?: MessageValues) {
    super(message);
    this.status = status;
    this.values = values;
  }
}

type Row = Record<string, any>;

const DESIGN_SELECT = `
  SELECT d.id, d.name, d.project_id, d.product_id, d.type_id, d.design_date, d.notes, d.original_name,
         d.ext, d.category, d.size, d.thumb_state, d.thumb_version, d.created_at, d.updated_at,
         (SELECT COUNT(*) FROM design_files f WHERE f.design_id = d.id) AS extra_files,
         d.size + COALESCE((SELECT SUM(f.size) FROM design_files f WHERE f.design_id = d.id), 0) AS total_size,
         p.name AS project_name, pr.name AS product_name, t.name AS type_name
  FROM designs d
  JOIN projects p ON p.id = d.project_id
  LEFT JOIN products pr ON pr.id = d.product_id
  LEFT JOIN design_types t ON t.id = d.type_id`;

const fileRoute = (id: number, fileId: number | null, name: string) =>
  `/api/designs/${id}/file${fileId === null ? '' : `s/${fileId}`}/${encodeURIComponent(name)}`;

/** A design with the whole list of its files. The primary file comes first and has no file id. */
function getDesign(id: number): Row {
  const row = db.prepare(`${DESIGN_SELECT} WHERE d.id = ?`).get(id) as Row | undefined;
  if (!row) throw new HttpError(404, 'Design not found');
  const extras = db
    .prepare('SELECT id, rel_path, original_name, ext, size FROM design_files WHERE design_id = ? ORDER BY rel_path COLLATE NOCASE')
    .all(id) as Row[];
  row.files = [
    { id: null, rel_path: row.original_name, name: row.original_name, ext: row.ext, size: row.size, url: fileRoute(id, null, row.original_name) },
    ...extras.map((file) => ({
      id: file.id,
      rel_path: file.rel_path,
      name: file.original_name,
      ext: file.ext,
      size: file.size,
      url: fileRoute(id, file.id, file.original_name),
    })),
  ];
  return row;
}

function storedPath(id: number): { stored_path: string; name: string; ext: string; original_name: string } {
  const row = db.prepare('SELECT stored_path, name, ext, original_name FROM designs WHERE id = ?').get(id) as any;
  if (!row) throw new HttpError(404, 'Design not found');
  return row;
}

function attachedFile(designId: number, fileId: number): Row {
  const row = db.prepare('SELECT * FROM design_files WHERE id = ? AND design_id = ?').get(fileId, designId) as Row | undefined;
  if (!row) throw new HttpError(404, 'File not found');
  return row;
}

/** Names of attached files are searchable too. */
function searchTextFor(designId: number, name: string, originalName: string): string {
  const extras = db.prepare('SELECT original_name FROM design_files WHERE design_id = ?').all(designId) as Row[];
  return normalizeSearch([name, originalName, ...extras.map((file) => file.original_name)].join(' '));
}

function refreshSearch(designId: number) {
  const row = db.prepare('SELECT name, original_name FROM designs WHERE id = ?').get(designId) as Row;
  db.prepare(`UPDATE designs SET search_text = ?, updated_at = datetime('now') WHERE id = ?`)
    .run(searchTextFor(designId, row.name, row.original_name), designId);
}

function transaction<T>(work: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = work();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

/** Empty folders left behind would otherwise pile up in the library. */
async function pruneEmptyDirs(start: string) {
  const stop = path.join(DATA_DIR, 'files');
  for (let dir = start; dir.startsWith(stop) && dir !== stop; dir = path.dirname(dir)) {
    try {
      await rmdir(dir);
    } catch {
      return;
    }
  }
}

async function removeStored(relatives: string[]) {
  for (const relative of relatives) {
    const full = path.join(DATA_DIR, relative);
    await rm(full, { force: true });
    await pruneEmptyDirs(path.dirname(full));
  }
}

function requireIds(value: unknown): number[] {
  if (!Array.isArray(value) || !value.length || !value.every((id) => Number.isInteger(id) && id > 0)) {
    throw new HttpError(400, 'No designs were selected');
  }
  return [...new Set(value as number[])];
}

/** Deletes rows only and returns the files to remove once the database change has been committed. */
function deleteDesignRow(id: number): string[] {
  const { stored_path } = storedPath(id);
  const extras = db.prepare('SELECT stored_path FROM design_files WHERE design_id = ?').all(id) as Row[];
  db.prepare('DELETE FROM designs WHERE id = ?').run(id);
  return [stored_path, ...extras.map((file) => file.stored_path)];
}

async function removeThumbs(ids: number[]) {
  for (const id of ids) await rm(path.join(THUMBS_DIR, `${id}.webp`), { force: true });
}

function requireName(value: unknown): string {
  const name = typeof value === 'string' ? value.trim() : '';
  if (!name) throw new HttpError(400, 'A name is required');
  if (name.length > 200) throw new HttpError(400, 'The name is too long');
  return name;
}

function requireDate(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(value))) {
    throw new HttpError(400, 'The date is not valid');
  }
  return value;
}

function optionalId(value: unknown): number | null {
  if (value === null || value === undefined || value === '' || value === 'none') return null;
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, 'Invalid value');
  return id;
}

function paramId(req: Request): number {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) throw new HttpError(404, 'Not found');
  return id;
}

/** Validates that the project exists and, when given, that the product belongs to it. */
function checkPlacement(projectId: number | null, productId: number | null): number {
  if (!projectId) throw new HttpError(400, 'Choose a project');
  const project = db.prepare('SELECT id FROM projects WHERE id = ?').get(projectId);
  if (!project) throw new HttpError(400, 'Project not found');
  if (productId) {
    const product = db.prepare('SELECT id FROM products WHERE id = ? AND project_id = ?').get(productId, projectId);
    if (!product) throw new HttpError(400, 'This product does not belong to this project');
  }
  return projectId;
}

function uniqueGuard<T>(fn: () => T): T {
  try {
    return fn();
  } catch (error) {
    if (String((error as Error).message).includes('UNIQUE')) throw new HttpError(409, 'This name already exists');
    throw error;
  }
}

/** Keeps the original name on disk so the files stay recognisable outside the app. */
function diskName(fileName: string): string {
  const ext = extensionOf(fileName);
  const base = stripExtension(fileName)
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .replace(/[. ]+$/, '')
    .slice(0, 80);
  return `${randomUUID().slice(0, 8)}-${base || 'file'}${ext ? `.${ext}` : ''}`;
}

function safeSegment(segment: string): string {
  return segment.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/[. ]+$/, '').slice(0, 80);
}

/** A path sent by the browser, cut down to folders inside the design. Nothing can climb out of it. */
function safeRelative(rel: string): string {
  return rel
    .split(/[/\\]+/)
    .filter((segment) => segment && segment !== '.' && segment !== '..')
    .map(safeSegment)
    .filter(Boolean)
    .join(path.sep);
}

/** Keeps a folder's layout on disk, because programs like KiCad find a project's files by their names. */
function packagedPath(packageDir: string, rel: string, originalName: string): string {
  const relative = path.join(packageDir, safeRelative(rel) || diskName(originalName));
  const full = path.join(DATA_DIR, relative);
  if (full.length > MAX_DISK_PATH || existsSync(full)) return path.join(packageDir, diskName(originalName));
  return relative;
}

interface FileOpener {
  /** Resolves to an error message, or an empty string when the file opened. */
  open: (fullPath: string) => Promise<string>;
  reveal: (fullPath: string) => void;
}

/** Explorer opens a file with its registered program. Going through cmd would let a file name run commands. */
let fileOpener: FileOpener = {
  open: async (fullPath) => {
    spawn('explorer.exe', [fullPath], { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
    return '';
  },
  reveal: (fullPath) => {
    spawn('explorer.exe', [`/select,"${fullPath}"`], { stdio: 'ignore', detached: true, windowsVerbatimArguments: true }).on('error', () => {}).unref();
  },
};

/** The installed app passes its own, which can report a file type that has no program. */
export function setFileOpener(opener: FileOpener) {
  fileOpener = opener;
}

// A library shared on the network must not let another machine start programs on this one.
function isLocalRequest(req: Request): boolean {
  return ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress ?? '');
}

async function hashFile(fullPath: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(fullPath)) hash.update(chunk);
  return hash.digest('hex');
}

let hashing = false;

/** Fingerprints every file still missing one. Runs in the background, one file at a time. */
async function hashPendingFiles() {
  if (hashing) return;
  hashing = true;
  try {
    for (const table of ['designs', 'design_files']) {
      const next = db.prepare(`SELECT id, stored_path FROM ${table} WHERE sha256 IS NULL LIMIT 1`);
      const update = db.prepare(`UPDATE ${table} SET sha256 = ?, size = COALESCE(?, size) WHERE id = ?`);
      for (let row = next.get() as Row | undefined; row; row = next.get() as Row | undefined) {
        const full = path.join(DATA_DIR, row.stored_path);
        const current = await stat(full).catch(() => null);
        // An empty fingerprint stops a missing or unreadable file being retried forever.
        const sha = current ? await hashFile(full).catch(() => '') : '';
        update.run(sha, current?.size ?? null, row.id);
      }
    }
  } catch (error) {
    console.error('Hashing stopped:', error);
  } finally {
    hashing = false;
  }
}

setTimeout(() => void hashPendingFiles(), 1500).unref();

const allFileRows = `
  SELECT sha256 FROM designs WHERE sha256 IS NOT NULL AND sha256 != '' AND size > 0
  UNION ALL
  SELECT sha256 FROM design_files WHERE sha256 IS NOT NULL AND sha256 != '' AND size > 0`;

function duplicateCount(): number {
  const row = db.prepare(`SELECT COALESCE(SUM(n - 1), 0) AS extra FROM (SELECT COUNT(*) AS n FROM (${allFileRows}) GROUP BY sha256 HAVING n > 1)`).get() as Row;
  return row.extra;
}

function pendingHashes(): number {
  const row = db.prepare(`
    SELECT (SELECT COUNT(*) FROM designs WHERE sha256 IS NULL) + (SELECT COUNT(*) FROM design_files WHERE sha256 IS NULL) AS n`).get() as Row;
  return row.n;
}

/** Another file with the same content, if the library already has one. */
function findCopy(sha256: string, exceptDesign?: number): Row | null {
  const row = db.prepare(`
    SELECT id, name FROM designs WHERE sha256 = ? AND id IS NOT ?
    UNION ALL
    SELECT d.id, d.name FROM design_files f JOIN designs d ON d.id = f.design_id WHERE f.sha256 = ? AND d.id IS NOT ?
    LIMIT 1`).get(sha256, exceptDesign ?? null, sha256, exceptDesign ?? null) as Row | undefined;
  return row ?? null;
}

export const app = express();
app.disable('x-powered-by');
app.use((req: Request, _res: Response, next: NextFunction) => {
  // No login means a random website must not be able to write to the library through the browser.
  const origin = req.headers.origin;
  if (req.method !== 'GET' && req.method !== 'HEAD' && origin) {
    let sameHost = false;
    try {
      sameHost = new URL(origin).host === req.headers.host;
    } catch {}
    if (!sameHost) return next(new HttpError(403, 'This request is not allowed'));
  }
  next();
});

const json = express.json({ limit: '256kb' });

app.get('/api/meta', (req, res) => {
  const projects = db.prepare(`
    SELECT p.id, p.name, COUNT(d.id) AS count
    FROM projects p LEFT JOIN designs d ON d.project_id = p.id
    GROUP BY p.id ORDER BY p.name`).all() as Row[];
  const products = db.prepare(`
    SELECT pr.id, pr.project_id, pr.name, COUNT(d.id) AS count
    FROM products pr LEFT JOIN designs d ON d.product_id = pr.id
    GROUP BY pr.id ORDER BY pr.name`).all() as Row[];
  for (const project of projects) project.products = products.filter((p) => p.project_id === project.id);
  res.json({
    projects,
    types: db.prepare(`
      SELECT t.id, t.name, t.slug, COUNT(d.id) AS count
      FROM design_types t LEFT JOIN designs d ON d.type_id = t.id
      GROUP BY t.id ORDER BY t.id`).all(),
    categories: db.prepare('SELECT category, COUNT(*) AS count FROM designs GROUP BY category').all(),
    exts: db.prepare('SELECT ext, COUNT(*) AS count FROM designs GROUP BY ext ORDER BY count DESC, ext').all(),
    total: (db.prepare('SELECT COUNT(*) AS n FROM designs').get() as Row).n,
    duplicates: duplicateCount(),
    can_open: isLocalRequest(req),
  });
});

app.post('/api/projects', json, (req, res) => {
  const name = requireName(req.body?.name);
  const result = uniqueGuard(() => db.prepare('INSERT INTO projects (name) VALUES (?)').run(name));
  res.status(201).json({ id: Number(result.lastInsertRowid), name });
});

app.patch('/api/projects/:id', json, (req, res) => {
  const name = requireName(req.body?.name);
  const result = uniqueGuard(() => db.prepare('UPDATE projects SET name = ? WHERE id = ?').run(name, paramId(req)));
  if (!result.changes) throw new HttpError(404, 'Project not found');
  res.json({ ok: true });
});

app.delete('/api/projects/:id', (req, res) => {
  const id = paramId(req);
  const used = db.prepare('SELECT COUNT(*) AS n FROM designs WHERE project_id = ?').get(id) as Row;
  if (used.n) throw new HttpError(409, used.n === 1 ? 'This project has {n} design. Move or delete it first.' : 'This project has {n} designs. Move or delete them first.', { n: used.n });
  db.prepare('DELETE FROM projects WHERE id = ?').run(id);
  res.json({ ok: true });
});

app.post('/api/products', json, (req, res) => {
  const name = requireName(req.body?.name);
  const projectId = checkPlacement(optionalId(req.body?.project_id), null);
  const result = uniqueGuard(() => db.prepare('INSERT INTO products (project_id, name) VALUES (?, ?)').run(projectId, name));
  res.status(201).json({ id: Number(result.lastInsertRowid), name, project_id: projectId });
});

app.patch('/api/products/:id', json, (req, res) => {
  const name = requireName(req.body?.name);
  const result = uniqueGuard(() => db.prepare('UPDATE products SET name = ? WHERE id = ?').run(name, paramId(req)));
  if (!result.changes) throw new HttpError(404, 'Product not found');
  res.json({ ok: true });
});

app.delete('/api/products/:id', (req, res) => {
  const id = paramId(req);
  const used = db.prepare('SELECT COUNT(*) AS n FROM designs WHERE product_id = ?').get(id) as Row;
  if (used.n) throw new HttpError(409, used.n === 1 ? 'This product has {n} design. Move or delete it first.' : 'This product has {n} designs. Move or delete them first.', { n: used.n });
  db.prepare('DELETE FROM products WHERE id = ?').run(id);
  res.json({ ok: true });
});

app.post('/api/types', json, (req, res) => {
  const name = requireName(req.body?.name);
  const result = uniqueGuard(() => db.prepare('INSERT INTO design_types (name) VALUES (?)').run(name));
  res.status(201).json({ id: Number(result.lastInsertRowid), name });
});

app.patch('/api/types/:id', json, (req, res) => {
  const name = requireName(req.body?.name);
  const result = uniqueGuard(() => db.prepare('UPDATE design_types SET name = ? WHERE id = ?').run(name, paramId(req)));
  if (!result.changes) throw new HttpError(404, 'Type not found');
  res.json({ ok: true });
});

app.delete('/api/types/:id', (req, res) => {
  db.prepare('DELETE FROM design_types WHERE id = ?').run(paramId(req));
  res.json({ ok: true });
});

function csvIds(value: unknown): number[] {
  return typeof value === 'string' ? value.split(',').map(Number).filter((n) => Number.isInteger(n) && n > 0) : [];
}

function designFilter(q: Request['query']): { clause: string; params: (string | number)[] } {
  const where: string[] = [];
  const params: (string | number)[] = [];
  const add = (sql: string, ...values: (string | number)[]) => {
    where.push(sql);
    params.push(...values);
  };

  if (typeof q.q === 'string') {
    for (const token of normalizeSearch(q.q).split(' ').filter(Boolean)) {
      add(`d.search_text LIKE ? ESCAPE '\\'`, `%${token.replace(/[\\%_]/g, '\\$&')}%`);
    }
  }
  if (q.project) add('d.project_id = ?', Number(q.project));
  if (q.product === 'none') where.push('d.product_id IS NULL');
  else if (q.product) add('d.product_id = ?', Number(q.product));
  const types = csvIds(q.type);
  const noType = typeof q.type === 'string' && q.type.split(',').includes('none');
  if (types.length || noType) {
    const parts = [];
    if (types.length) parts.push(`d.type_id IN (${types.map(() => '?').join(',')})`);
    if (noType) parts.push('d.type_id IS NULL');
    add(`(${parts.join(' OR ')})`, ...types);
  }
  if (typeof q.cat === 'string' && q.cat) {
    const cats = q.cat.split(',');
    add(`d.category IN (${cats.map(() => '?').join(',')})`, ...cats);
  }
  if (typeof q.ext === 'string' && q.ext) add('d.ext = ?', q.ext.toLowerCase());
  if (typeof q.from === 'string' && q.from) add('d.design_date >= ?', requireDate(q.from));
  if (typeof q.to === 'string' && q.to) add('d.design_date <= ?', requireDate(q.to));
  return { clause: where.length ? `WHERE ${where.join(' AND ')}` : '', params };
}

// Selecting "all results" has to reach the pages the grid has not loaded yet.
app.get('/api/designs/ids', (req, res) => {
  const { clause, params } = designFilter(req.query);
  const rows = db.prepare(`SELECT d.id FROM designs d ${clause}`).all(...params) as Row[];
  res.json(rows.map((row) => row.id));
});

app.get('/api/designs', (req, res) => {
  const q = req.query;
  const sorts: Record<string, string> = {
    date: 'd.design_date DESC, d.id DESC',
    date_asc: 'd.design_date ASC, d.id ASC',
    name: 'd.name COLLATE NOCASE ASC, d.id DESC',
    added: 'd.id DESC',
    size: 'total_size DESC, d.id DESC',
  };
  const order = sorts[String(q.sort)] ?? sorts.date;
  const page = Math.max(1, Number(q.page) || 1);
  const { clause, params } = designFilter(q);
  const total = (db.prepare(`SELECT COUNT(*) AS n FROM designs d ${clause}`).get(...params) as Row).n;
  const items = db
    .prepare(`${DESIGN_SELECT} ${clause} ORDER BY ${order} LIMIT ? OFFSET ?`)
    .all(...params, PAGE_SIZE, (page - 1) * PAGE_SIZE);
  res.json({ items, total, page, pageSize: PAGE_SIZE });
});

interface ReceivedFile {
  tmpPath: string;
  originalName: string;
  size: number;
  sha256: string;
  fields: Record<string, string>;
}

/** Streams one uploaded file to the temp folder, then hands it over. Whatever is left there afterwards gets removed. */
function receiveFile(req: Request, next: NextFunction, handle: (file: ReceivedFile) => Promise<void>) {
  const fields: Record<string, string> = {};
  let tmpPath: string | null = null;
  let originalName = '';
  let size = 0;
  const hash = createHash('sha256');
  let output: WriteStream | null = null;
  let written: Promise<void> | null = null;
  let finished = false;

  const fail = (error: unknown) => {
    if (finished) return;
    finished = true;
    // Windows cannot delete a file that is still open, so close the stream before removing it.
    const leftover = tmpPath;
    output?.destroy();
    void Promise.resolve(written)
      .catch(() => {})
      .finally(() => {
        if (leftover) rm(leftover, { force: true, maxRetries: 3 }).catch(() => {});
      });
    next(error);
  };

  let form: busboy.Busboy;
  try {
    form = busboy({ headers: req.headers, defParamCharset: 'utf8', limits: { files: 1, fieldSize: 64 * 1024 } });
  } catch {
    return next(new HttpError(400, 'Invalid upload request'));
  }

  form.on('field', (key, value) => {
    fields[key] = value;
  });
  form.on('file', (_field, stream, info) => {
    originalName = info.filename ?? '';
    tmpPath = path.join(TMP_DIR, randomUUID());
    stream.on('data', (chunk: Buffer) => {
      size += chunk.length;
      hash.update(chunk);
    });
    output = createWriteStream(tmpPath);
    written = pipeline(stream, output);
    written.catch(fail);
  });
  form.on('error', fail);
  form.on('close', async () => {
    try {
      if (!written || !tmpPath || !originalName) throw new HttpError(400, 'No file was received');
      await written;
      if (!size) throw new HttpError(400, 'The file is empty');
      await handle({ tmpPath, originalName, size, sha256: hash.digest('hex'), fields });
      finished = true;
    } catch (error) {
      fail(error);
    }
  });
  req.on('close', () => {
    if (!req.complete) {
      form.destroy();
      fail(new HttpError(499, 'Upload cancelled'));
    }
  });
  req.pipe(form);
}

function autoTypeId(ext: string): number | null {
  const slug = formatOf(ext).autoType;
  const auto = slug ? (db.prepare('SELECT id FROM design_types WHERE slug = ?').get(slug) as Row | undefined) : undefined;
  return auto?.id ?? null;
}

app.post('/api/designs', (req, res, next) => {
  receiveFile(req, next, async ({ tmpPath, originalName, size, sha256, fields }) => {
    const productId = optionalId(fields.product_id);
    const projectId = checkPlacement(optionalId(fields.project_id), productId);
    const ext = extensionOf(originalName);
    const format = formatOf(ext);
    const date = requireDate(fields.design_date);
    const name = requireName(fields.name || stripExtension(originalName));
    const typeId = fields.type_id === 'auto' ? autoTypeId(ext) : optionalId(fields.type_id);

    const monthDir = path.join('files', date.slice(0, 4), date.slice(5, 7));
    const packageDir = fields.rel_path ? path.join(monthDir, `${randomUUID().slice(0, 8)}-${safeSegment(name) || 'design'}`) : null;
    const relative = packageDir ? packagedPath(packageDir, fields.rel_path, originalName) : path.join(monthDir, diskName(originalName));
    await mkdir(path.dirname(path.join(DATA_DIR, relative)), { recursive: true });
    await rename(tmpPath, path.join(DATA_DIR, relative));

    try {
      const copy = findCopy(sha256);
      const result = db
        .prepare(`
          INSERT INTO designs (name, search_text, project_id, product_id, type_id, design_date, notes,
                               original_name, stored_path, ext, category, size, sha256, package_dir)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(
          name,
          normalizeSearch(`${name} ${originalName}`),
          projectId,
          productId,
          typeId,
          date,
          (fields.notes ?? '').slice(0, 5000),
          originalName,
          relative,
          ext,
          format.category,
          size,
          sha256,
          packageDir,
        );
      res.status(201).json({ ...getDesign(Number(result.lastInsertRowid)), duplicate_of: copy });
    } catch (error) {
      await removeStored([relative]);
      throw error;
    }
  });
});

app.post('/api/designs/bulk', json, (req, res) => {
  const ids = requireIds(req.body?.ids);
  const body = req.body;
  const date = 'design_date' in body ? requireDate(body.design_date) : null;
  transaction(() => {
    for (const id of ids) {
      const current = db.prepare('SELECT * FROM designs WHERE id = ?').get(id) as Row | undefined;
      if (!current) throw new HttpError(404, 'Design not found');
      const projectId = 'project_id' in body ? optionalId(body.project_id) : current.project_id;
      // A product belongs to one project, so moving to another project drops it unless a new one was picked.
      const productId = 'product_id' in body ? optionalId(body.product_id) : projectId === current.project_id ? current.product_id : null;
      checkPlacement(projectId, productId);
      db.prepare(`
        UPDATE designs SET project_id = ?, product_id = ?, type_id = ?, design_date = ?, updated_at = datetime('now') WHERE id = ?`)
        .run(projectId, productId, 'type_id' in body ? optionalId(body.type_id) : current.type_id, date ?? current.design_date, id);
    }
  });
  res.json({ updated: ids.length });
});

app.post('/api/designs/bulk-delete', json, async (req, res) => {
  const ids = requireIds(req.body?.ids);
  const stored = transaction(() => ids.flatMap(deleteDesignRow));
  await removeStored(stored);
  await removeThumbs(ids);
  res.json({ deleted: ids.length });
});

app.post('/api/designs/merge', json, async (req, res) => {
  const targetId = requireIds([req.body?.target_id])[0];
  const ids = requireIds(req.body?.ids).filter((id) => id !== targetId);
  if (!ids.length) throw new HttpError(400, 'Choose at least two designs');
  transaction(() => {
    const target = db.prepare('SELECT notes FROM designs WHERE id = ?').get(targetId) as Row | undefined;
    if (!target) throw new HttpError(404, 'Design not found');
    let notes = target.notes as string;
    for (const id of ids) {
      const source = db.prepare('SELECT * FROM designs WHERE id = ?').get(id) as Row | undefined;
      if (!source) throw new HttpError(404, 'Design not found');
      db.prepare(`
        INSERT INTO design_files (design_id, rel_path, original_name, stored_path, ext, size, sha256)
        VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(targetId, source.original_name, source.original_name, source.stored_path, source.ext, source.size, source.sha256);
      db.prepare('UPDATE design_files SET design_id = ? WHERE design_id = ?').run(targetId, id);
      if (source.notes) notes = notes ? `${notes}\n${source.notes}` : source.notes;
      db.prepare('DELETE FROM designs WHERE id = ?').run(id);
    }
    db.prepare('UPDATE designs SET notes = ? WHERE id = ?').run(notes.slice(0, 5000), targetId);
    refreshSearch(targetId);
  });
  await removeThumbs(ids);
  res.json(getDesign(targetId));
});

app.get('/api/duplicates', (_req, res) => {
  const rows = db.prepare(`
    WITH files AS (
      SELECT sha256, size, id AS design_id, NULL AS file_id, original_name AS file_name FROM designs
      WHERE sha256 IS NOT NULL AND sha256 != '' AND size > 0
      UNION ALL
      SELECT sha256, size, design_id, id AS file_id, rel_path AS file_name FROM design_files
      WHERE sha256 IS NOT NULL AND sha256 != '' AND size > 0
    )
    SELECT * FROM files WHERE sha256 IN (SELECT sha256 FROM files GROUP BY sha256 HAVING COUNT(*) > 1)
    ORDER BY size DESC, sha256, design_id`).all() as Row[];
  const groups = new Map<string, { sha256: string; size: number; items: Row[] }>();
  const designs = new Map<number, Row>();
  for (const row of rows) {
    let design = designs.get(row.design_id);
    if (!design) {
      design = db.prepare(`${DESIGN_SELECT} WHERE d.id = ?`).get(row.design_id) as Row;
      designs.set(row.design_id, design);
    }
    const group = groups.get(row.sha256) ?? { sha256: row.sha256, size: row.size, items: [] as Row[] };
    // Removing the main file of a many-file design would take its other files with it.
    group.items.push({ design, file_id: row.file_id, file_name: row.file_name, removable: row.file_id !== null || !design.extra_files });
    groups.set(row.sha256, group);
  }
  const pending = pendingHashes();
  if (pending) void hashPendingFiles();
  res.json({ pending, groups: [...groups.values()] });
});

app.post('/api/duplicates/remove', json, async (req, res) => {
  const designIds = Array.isArray(req.body?.design_ids) && req.body.design_ids.length ? requireIds(req.body.design_ids) : [];
  const fileIds = Array.isArray(req.body?.file_ids) && req.body.file_ids.length ? requireIds(req.body.file_ids) : [];
  if (!designIds.length && !fileIds.length) throw new HttpError(400, 'No files were selected');
  const stored = transaction(() => {
    const paths: string[] = [];
    // Each removal goes only after checking a copy is still left, so one group can never lose its last file.
    const hasOtherCopy = (sha: string) => Boolean(findCopyAny(sha));
    for (const id of designIds) {
      const row = db.prepare('SELECT sha256 FROM designs WHERE id = ?').get(id) as Row | undefined;
      if (!row) throw new HttpError(404, 'Design not found');
      const extras = db.prepare('SELECT COUNT(*) AS n FROM design_files WHERE design_id = ?').get(id) as Row;
      if (extras.n) throw new HttpError(409, 'This design has other files inside, so it cannot be deleted from here');
      if (!row.sha256) throw new HttpError(409, 'This file has not been fingerprinted yet');
      paths.push(...deleteDesignRow(id));
      if (!hasOtherCopy(row.sha256)) throw new HttpError(409, 'All copies of a file cannot be deleted');
    }
    for (const id of fileIds) {
      const row = db.prepare('SELECT * FROM design_files WHERE id = ?').get(id) as Row | undefined;
      if (!row) throw new HttpError(404, 'File not found');
      if (!row.sha256) throw new HttpError(409, 'This file has not been fingerprinted yet');
      db.prepare('DELETE FROM design_files WHERE id = ?').run(id);
      if (!hasOtherCopy(row.sha256)) throw new HttpError(409, 'All copies of a file cannot be deleted');
      refreshSearch(row.design_id);
      paths.push(row.stored_path);
    }
    return paths;
  });
  await removeStored(stored);
  await removeThumbs(designIds);
  res.json({ removed: designIds.length + fileIds.length });
});

function findCopyAny(sha256: string): Row | undefined {
  return db.prepare('SELECT id FROM designs WHERE sha256 = ? UNION ALL SELECT id FROM design_files WHERE sha256 = ? LIMIT 1').get(sha256, sha256) as Row | undefined;
}

// A .scad file names its neighbours by file name, and in the library they are usually separate designs.
app.get('/api/scad-lookup', (req, res) => {
  const name = path.basename(String(req.query.name ?? '').replace(/\\/g, '/'));
  if (!name) throw new HttpError(400, 'A name is required');
  const near = Number(req.query.design) || 0;
  const project = (db.prepare('SELECT project_id FROM designs WHERE id = ?').get(near) as Row | undefined)?.project_id ?? 0;
  const own = db.prepare('SELECT id, original_name FROM design_files WHERE design_id = ? AND original_name = ? COLLATE NOCASE LIMIT 1').get(near, name) as Row | undefined;
  if (own) {
    res.json({ url: fileRoute(near, own.id, own.original_name) });
    return;
  }
  const design = db.prepare(`
    SELECT id, original_name FROM designs WHERE original_name = ? COLLATE NOCASE
    ORDER BY project_id = ? DESC, id LIMIT 1`).get(name, project) as Row | undefined;
  if (design) {
    res.json({ url: fileRoute(design.id, null, design.original_name) });
    return;
  }
  const attached = db.prepare('SELECT id, design_id, original_name FROM design_files WHERE original_name = ? COLLATE NOCASE LIMIT 1').get(name) as Row | undefined;
  if (!attached) throw new HttpError(404, 'Not found');
  res.json({ url: fileRoute(attached.design_id, attached.id, attached.original_name) });
});

app.get('/api/designs/:id', (req, res) => {
  res.json(getDesign(paramId(req)));
});

app.post('/api/designs/:id/files', (req, res, next) => {
  const id = paramId(req);
  receiveFile(req, next, async ({ tmpPath, originalName, size, sha256, fields }) => {
    const design = db.prepare('SELECT stored_path, package_dir FROM designs WHERE id = ?').get(id) as Row | undefined;
    if (!design) throw new HttpError(404, 'Design not found');
    const rel = fields.rel_path || originalName;
    const relative = design.package_dir
      ? packagedPath(design.package_dir, rel, originalName)
      : path.join(path.dirname(design.stored_path), diskName(originalName));
    await mkdir(path.dirname(path.join(DATA_DIR, relative)), { recursive: true });
    await rename(tmpPath, path.join(DATA_DIR, relative));
    try {
      const copy = findCopy(sha256, id);
      db.prepare(`
        INSERT INTO design_files (design_id, rel_path, original_name, stored_path, ext, size, sha256)
        VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(id, rel.replace(/\\/g, '/'), originalName, relative, extensionOf(originalName), size, sha256);
      refreshSearch(id);
      res.status(201).json({ ...getDesign(id), duplicate_of: copy });
    } catch (error) {
      await removeStored([relative]);
      throw error;
    }
  });
});

function paramFileId(req: Request): number {
  const id = Number(req.params.fileId);
  if (!Number.isInteger(id) || id <= 0) throw new HttpError(404, 'Not found');
  return id;
}

app.delete('/api/designs/:id/files/:fileId', async (req, res) => {
  const id = paramId(req);
  const file = attachedFile(id, paramFileId(req));
  db.prepare('DELETE FROM design_files WHERE id = ?').run(file.id);
  refreshSearch(id);
  await removeStored([file.stored_path]);
  res.json(getDesign(id));
});

/** Takes a file out of a design and makes it a design of its own. The file stays where it is on disk. */
app.post('/api/designs/:id/files/:fileId/split', (req, res) => {
  const id = paramId(req);
  const file = attachedFile(id, paramFileId(req));
  const parent = db.prepare('SELECT project_id, product_id, design_date FROM designs WHERE id = ?').get(id) as Row;
  const created = transaction(() => {
    const name = stripExtension(file.original_name);
    const result = db.prepare(`
      INSERT INTO designs (name, search_text, project_id, product_id, type_id, design_date, original_name, stored_path, ext, category, size, sha256)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        name,
        normalizeSearch(`${name} ${file.original_name}`),
        parent.project_id,
        parent.product_id,
        autoTypeId(file.ext),
        parent.design_date,
        file.original_name,
        file.stored_path,
        file.ext,
        formatOf(file.ext).category,
        file.size,
        file.sha256,
      );
    db.prepare('DELETE FROM design_files WHERE id = ?').run(file.id);
    refreshSearch(id);
    return Number(result.lastInsertRowid);
  });
  res.status(201).json({ design: getDesign(id), created: getDesign(created) });
});

function locateForOpening(req: Request): { full: string; ext: string; designId: number; fileId: number | null } {
  if (!isLocalRequest(req)) throw new HttpError(403, 'Files can only be opened from the computer that holds the library');
  const designId = paramId(req);
  const fileId = optionalId(req.body?.file_id);
  const row = fileId ? attachedFile(designId, fileId) : storedPath(designId);
  return { full: path.join(DATA_DIR, row.stored_path), ext: row.ext, designId, fileId };
}

app.post('/api/designs/:id/open', json, async (req, res) => {
  const { full, ext, designId, fileId } = locateForOpening(req);
  if (NEVER_OPEN.has(ext)) throw new HttpError(400, 'Program files are not opened from the library. Download the file first if you trust it.');
  if (!existsSync(full)) throw new HttpError(404, 'The file is missing from this computer');
  const failure = await fileOpener.open(full);
  if (failure) throw new HttpError(422, 'Could not open the file: {reason}', { reason: failure });
  // Whatever program opens it can save over it, so the fingerprint and the size get read again later.
  if (fileId) db.prepare('UPDATE design_files SET sha256 = NULL WHERE id = ?').run(fileId);
  else db.prepare('UPDATE designs SET sha256 = NULL WHERE id = ?').run(designId);
  res.json({ ok: true });
});

app.post('/api/designs/:id/reveal', json, (req, res) => {
  const { full } = locateForOpening(req);
  if (!existsSync(full)) throw new HttpError(404, 'The file is missing from this computer');
  fileOpener.reveal(full);
  res.json({ ok: true });
});

app.patch('/api/designs/:id', json, (req, res) => {
  const id = paramId(req);
  const current = db.prepare('SELECT * FROM designs WHERE id = ?').get(id) as Row | undefined;
  if (!current) throw new HttpError(404, 'Design not found');
  const body = req.body ?? {};

  const name = 'name' in body ? requireName(body.name) : current.name;
  const projectId = 'project_id' in body ? optionalId(body.project_id) : current.project_id;
  const productId = 'product_id' in body ? optionalId(body.product_id) : current.product_id;
  const typeId = 'type_id' in body ? optionalId(body.type_id) : current.type_id;
  const date = 'design_date' in body ? requireDate(body.design_date) : current.design_date;
  const notes = 'notes' in body ? String(body.notes ?? '').slice(0, 5000) : current.notes;
  checkPlacement(projectId, productId);

  db.prepare(`
    UPDATE designs SET name = ?, search_text = ?, project_id = ?, product_id = ?, type_id = ?, design_date = ?,
                       notes = ?, updated_at = datetime('now')
    WHERE id = ?`).run(
    name,
    searchTextFor(id, name, current.original_name),
    projectId,
    productId,
    typeId,
    date,
    notes,
    id,
  );
  res.json(getDesign(id));
});

app.delete('/api/designs/:id', async (req, res) => {
  const id = paramId(req);
  const stored = deleteDesignRow(id);
  await removeStored(stored);
  await removeThumbs([id]);
  res.json({ ok: true });
});

function sendStored(req: Request, res: Response, storedRelative: string, downloadName: string) {
  // Uploaded files must never run as pages on this origin if opened directly.
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:");
  if (req.query.download) res.attachment(downloadName);
  res.sendFile(storedRelative, { root: DATA_DIR, dotfiles: 'allow' });
}

// The optional name at the end is for readers like KiCanvas, which work out a file's type from its URL.
app.get('/api/designs/:id/file{/:name}', (req, res) => {
  const { stored_path, name, ext } = storedPath(paramId(req));
  sendStored(req, res, stored_path, ext && !name.toLowerCase().endsWith(`.${ext}`) ? `${name}.${ext}` : name);
});

app.get('/api/designs/:id/files/:fileId{/:name}', (req, res) => {
  const file = attachedFile(paramId(req), paramFileId(req));
  sendStored(req, res, file.stored_path, file.original_name);
});

app.get('/api/designs/:id/thumb', (req, res) => {
  res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  res.sendFile(`${paramId(req)}.webp`, { root: THUMBS_DIR });
});

app.put(
  '/api/designs/:id/thumb',
  express.raw({ type: 'image/webp', limit: '4mb' }),
  async (req, res) => {
    const id = paramId(req);
    storedPath(id);
    const body = req.body as Buffer;
    const isWebp = Buffer.isBuffer(body) && body.subarray(0, 4).toString('latin1') === 'RIFF' && body.subarray(8, 12).toString('latin1') === 'WEBP';
    if (!isWebp) throw new HttpError(400, 'The preview image is not valid');
    await writeFile(path.join(THUMBS_DIR, `${id}.webp`), body);
    db.prepare(`UPDATE designs SET thumb_state = 'ok', thumb_version = thumb_version + 1 WHERE id = ?`).run(id);
    res.json(getDesign(id));
  },
);

app.post('/api/designs/:id/thumb-failed', (req, res) => {
  const id = paramId(req);
  db.prepare(`UPDATE designs SET thumb_state = 'failed' WHERE id = ? AND thumb_state = 'none'`).run(id);
  res.json({ ok: true });
});

app.all('/api/{*rest}', () => {
  throw new HttpError(404, 'Not found');
});

// WASM runtimes load their files from these paths at run time.
app.use('/vendor/occt', express.static(path.join(ROOT, 'node_modules/occt-import-js/dist')));
app.use('/vendor/libredwg', express.static(path.join(ROOT, 'node_modules/@mlightcad/libredwg-web/wasm')));
app.use('/vendor/fonts', express.static(path.join(ROOT, 'node_modules/pdfjs-dist/standard_fonts')));
app.use('/vendor/kicanvas', express.static(path.join(ROOT, 'public/vendor/kicanvas')));

if (existsSync(DIST)) {
  app.use(express.static(DIST));
  app.get('/{*rest}', (_req, res) => res.sendFile(path.join(DIST, 'index.html')));
}

app.use((error: any, req: Request, res: Response, _next: NextFunction) => {
  const status = error.status ?? error.statusCode ?? 500;
  if (status >= 500) console.error(error);
  if (res.headersSent) return res.end();
  // The page says which language it is showing, because the server has no setting of its own.
  const language = req.get('x-ui-language') === 'ar' ? 'ar' : 'en';
  res.status(status).json({ error: translate(language, status >= 500 ? 'Something went wrong on the server' : error.message, error.values) });
});
