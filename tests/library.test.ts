// Runs the real server against a throwaway library folder.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { detectGrouping, displayExt, formatOf, groupPaths, isGeneratedJunk, pickPrimary } from '../shared/formats.ts';

const dataDir = mkdtempSync(path.join(tmpdir(), 'design-library-test-'));
process.env.DATA_DIR = dataDir;
const { app, setFileOpener } = await import('../server/app.ts');
const { db } = await import('../server/db.ts');

let server: Server;
let base = '';
let projectId = 0;
let otherProjectId = 0;
let productId = 0;
const opened: string[] = [];

async function call(method: string, url: string, body?: unknown) {
  const response = await fetch(base + url, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

async function upload(name: string, content: string, fields: Record<string, string> = {}, url = '/api/designs') {
  const form = new FormData();
  if (url === '/api/designs') {
    form.set('project_id', String(projectId));
    form.set('design_date', '2026-03-04');
    form.set('type_id', 'auto');
  }
  for (const [key, value] of Object.entries(fields)) form.set(key, value);
  form.set('file', new Blob([content]), name);
  const response = await fetch(base + url, { method: 'POST', body: form });
  return { status: response.status, body: await response.json() };
}

before(async () => {
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
  setFileOpener({
    open: async (fullPath) => {
      opened.push(fullPath);
      return fullPath.includes('noprogram') ? 'no associated program' : '';
    },
    reveal: (fullPath) => void opened.push(`reveal:${fullPath}`),
  });
  projectId = (await call('POST', '/api/projects', { name: 'Alpha Project' })).body.id;
  otherProjectId = (await call('POST', '/api/projects', { name: 'Unknown' })).body.id;
  productId = (await call('POST', '/api/products', { project_id: projectId, name: 'Main Product' })).body.id;
});

after(async () => {
  server.close();
  // The background hashing starts on a timer, and it must find the database still open.
  await new Promise((resolve) => setTimeout(resolve, 1600));
  db.close();
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 3 });
});

test('formats: board files have their own category and viewers', () => {
  assert.equal(formatOf('gtl').viewer, 'gerber');
  assert.equal(formatOf('kicad_pcb').viewer, 'kicad');
  assert.equal(formatOf('kicad_pro').category, 'pcb');
  assert.equal(formatOf('scad').viewer, 'scad');
  assert.equal(displayExt('gbl'), 'PCB');
  assert.equal(displayExt('stl'), 'STL');
});

test('grouping: one board with sources and Gerbers in separate folders stays one design', () => {
  const paths = [
    '1206 PCB/KiCAD Source Files/board.kicad_pcb',
    '1206 PCB/Manufacturing/Gerber File/board-F_Cu.gtl',
    '1206 PCB/3D/board.step',
    '1206 PCB/layout.png',
  ];
  assert.equal(detectGrouping(paths), 'one');
  const [group] = groupPaths(paths, 'one');
  assert.equal(group.name, '1206 PCB');
  assert.equal(group.files.length, 4);
  assert.equal(group.files[0].rel, 'KiCAD Source Files/board.kicad_pcb', 'the KiCad board is the primary file');
});

test('grouping: a folder holding several boards becomes several designs', () => {
  const paths = [
    'boards/1206/KiCAD/a.kicad_pcb',
    'boards/1206/Gerber/a-F_Cu.gtl',
    'boards/2835/KiCAD/b.kicad_pcb',
    'boards/2835/photo.png',
  ];
  assert.equal(detectGrouping(paths), 'sub');
  const groups = groupPaths(paths, 'sub');
  assert.deepEqual(groups.map((group) => group.name), ['1206', '2835']);
  assert.equal(groups[1].files.find((file) => file.rel === 'photo.png')?.index, 3);
});

test('grouping: loose Gerbers go together, and folders without boards stay file by file', () => {
  assert.equal(detectGrouping(['a-F_Cu.gtl', 'a-B_Cu.gbl']), 'one');
  assert.equal(detectGrouping(['only.gtl']), 'separate');
  assert.equal(detectGrouping(['parts/a.stl', 'parts/b.stl']), 'separate');
  assert.equal(groupPaths(['parts/a.stl', 'parts/b.stl'], 'separate').length, 2);
  assert.equal(pickPrimary(['x/readme.txt', 'x/photo.png', 'x/part.stl']), 2);
});

test('grouping: KiCad generated files are recognized', () => {
  assert.ok(isGeneratedJunk('b/KiCAD/board-backups/board-2023.zip'));
  assert.ok(isGeneratedJunk('b/KiCAD/fp-info-cache'));
  assert.ok(!isGeneratedJunk('b/Gerber/Gerber 1206.zip'));
});

test('a folder upload keeps its layout on disk and lists every file', async () => {
  const created = await upload('board.kicad_pcb', '(kicad_pcb)', { name: 'Board 1206', rel_path: 'KiCAD Source Files/board.kicad_pcb' });
  assert.equal(created.status, 201);
  assert.equal(created.body.category, 'pcb');
  assert.equal(created.body.type_name, 'PCB');

  const added = await upload('board.kicad_sch', '(kicad_sch)', { rel_path: 'KiCAD Source Files/board.kicad_sch' }, `/api/designs/${created.body.id}/files`);
  assert.equal(added.status, 201);
  assert.equal(added.body.extra_files, 1);
  assert.equal(added.body.total_size, '(kicad_pcb)'.length + '(kicad_sch)'.length);

  const rows = db.prepare('SELECT stored_path FROM designs WHERE id = ? UNION ALL SELECT stored_path FROM design_files WHERE design_id = ?').all(created.body.id, created.body.id) as any[];
  assert.equal(path.dirname(rows[0].stored_path), path.dirname(rows[1].stored_path), 'KiCad finds a project by neighbouring file names');
  assert.equal(path.basename(rows[0].stored_path), 'board.kicad_pcb');

  const fetched = await fetch(base + added.body.files[1].url);
  assert.equal(await fetched.text(), '(kicad_sch)');
  const found = await call('GET', '/api/designs?q=kicad_sch');
  assert.ok(found.body.items.some((item: any) => item.id === created.body.id), 'attached file names are searchable');
});

test('a path from the browser cannot climb out of the design folder', async () => {
  const created = await upload('a.gbr', 'G04 a*', { name: 'Escape', rel_path: '../../../../../evil/a.gbr' });
  assert.equal(created.status, 201);
  const row = db.prepare('SELECT stored_path FROM designs WHERE id = ?').get(created.body.id) as any;
  assert.ok(path.resolve(dataDir, row.stored_path).startsWith(path.join(dataDir, 'files')));
  assert.ok(!row.stored_path.includes('..'));
  await call('DELETE', `/api/designs/${created.body.id}`);
});

test('deleting a design removes all of its files and its folder', async () => {
  const created = await upload('x.step', 'step-one', { name: 'Package', rel_path: 'x.step' });
  await upload('y.png', 'png-one', { rel_path: 'pics/y.png' }, `/api/designs/${created.body.id}/files`);
  const rows = db.prepare('SELECT stored_path FROM designs WHERE id = ? UNION ALL SELECT stored_path FROM design_files WHERE design_id = ?').all(created.body.id, created.body.id) as any[];
  assert.equal((await call('DELETE', `/api/designs/${created.body.id}`)).status, 200);
  for (const row of rows) assert.ok(!existsSync(path.join(dataDir, row.stored_path)));
  assert.ok(!existsSync(path.dirname(path.join(dataDir, rows[0].stored_path))));
});

test('bulk edit moves designs, and a product from another project is refused as a whole', async () => {
  const a = (await upload('bulk-a.stl', 'bulk-a')).body.id;
  const b = (await upload('bulk-b.stl', 'bulk-b', { product_id: String(productId) })).body.id;

  const refused = await call('POST', '/api/designs/bulk', { ids: [a, b], project_id: otherProjectId, product_id: productId });
  assert.equal(refused.status, 400);
  assert.equal((await call('GET', `/api/designs/${a}`)).body.project_id, projectId, 'nothing moved after the refusal');

  assert.equal((await call('POST', '/api/designs/bulk', { ids: [a, b], project_id: otherProjectId })).status, 200);
  const moved = (await call('GET', `/api/designs/${b}`)).body;
  assert.equal(moved.project_id, otherProjectId);
  assert.equal(moved.product_id, null, 'its product belonged to the old project');

  assert.equal((await call('POST', '/api/designs/bulk', { ids: [a], design_date: '2020-01-02', type_id: null })).status, 200);
  const dated = (await call('GET', `/api/designs/${a}`)).body;
  assert.equal(dated.design_date, '2020-01-02');
  assert.equal(dated.type_id, null);
  assert.equal(dated.project_id, otherProjectId, 'fields left out stay as they are');

  const ids = (await call('GET', `/api/designs/ids?project=${otherProjectId}`)).body;
  assert.ok(ids.includes(a) && ids.includes(b));
  assert.equal((await call('POST', '/api/designs/bulk-delete', { ids: [a, b] })).body.deleted, 2);
  assert.equal((await call('GET', `/api/designs/${a}`)).status, 404);
});

test('merge puts everything in one design, and split takes a file back out', async () => {
  const target = (await upload('merge-t.step', 'merge-t')).body.id;
  const source = (await upload('merge-s.stl', 'merge-s')).body.id;
  const merged = await call('POST', '/api/designs/merge', { target_id: target, ids: [target, source] });
  assert.equal(merged.status, 200);
  assert.equal(merged.body.extra_files, 1);
  assert.equal((await call('GET', `/api/designs/${source}`)).status, 404);
  const attached = merged.body.files[1];
  assert.equal(await (await fetch(base + attached.url)).text(), 'merge-s', 'the file survived the merge');

  const split = await call('POST', `/api/designs/${target}/files/${attached.id}/split`);
  assert.equal(split.status, 201);
  assert.equal(split.body.design.extra_files, 0);
  assert.equal(await (await fetch(base + split.body.created.files[0].url)).text(), 'merge-s');
  await call('POST', '/api/designs/bulk-delete', { ids: [target, split.body.created.id] });
});

test('duplicates are found by content, and the last copy can never be removed', async () => {
  const a = await upload('dup-one.stl', 'identical content');
  assert.equal(a.body.duplicate_of, null);
  const b = await upload('dup-two-other-name.stl', 'identical content');
  assert.equal(b.body.duplicate_of.id, a.body.id, 'the upload reports the copy it matches');
  const holder = await upload('holder.step', 'holder');
  const c = await upload('dup-three.stl', 'identical content', {}, `/api/designs/${holder.body.id}/files`);
  await upload('unique.stl', 'something else');

  const { groups } = (await call('GET', '/api/duplicates')).body;
  const group = groups.find((entry: any) => entry.items.some((item: any) => item.design.id === a.body.id));
  assert.equal(group.items.length, 3);
  assert.equal(group.size, 'identical content'.length);
  assert.ok((await call('GET', '/api/meta')).body.duplicates >= 2);

  const fileId = c.body.files[1].id;
  const allOfThem = await call('POST', '/api/duplicates/remove', { design_ids: [a.body.id, b.body.id], file_ids: [fileId] });
  assert.equal(allOfThem.status, 409);
  assert.equal((await call('GET', `/api/designs/${a.body.id}`)).status, 200, 'the refused removal left everything in place');

  const refusedPackage = await call('POST', '/api/duplicates/remove', { design_ids: [holder.body.id] });
  assert.equal(refusedPackage.status, 409, 'a design with other files inside is not removed this way');

  assert.equal((await call('POST', '/api/duplicates/remove', { design_ids: [b.body.id], file_ids: [fileId] })).status, 200);
  assert.equal((await call('GET', `/api/designs/${b.body.id}`)).status, 404);
  assert.equal((await call('GET', `/api/designs/${holder.body.id}`)).body.extra_files, 0);
  assert.equal((await call('GET', `/api/designs/${a.body.id}`)).status, 200);
  await call('POST', '/api/designs/bulk-delete', { ids: [a.body.id, holder.body.id] });
});

test('background hashing fills in old files and re-reads the size of an edited one', async () => {
  const created = await upload('edit-me.stl', 'first version');
  const row = db.prepare('SELECT stored_path, sha256 FROM designs WHERE id = ?').get(created.body.id) as any;
  assert.ok(row.sha256);
  const opened1 = await call('POST', `/api/designs/${created.body.id}/open`, {});
  assert.equal(opened1.status, 200);
  assert.equal((db.prepare('SELECT sha256 FROM designs WHERE id = ?').get(created.body.id) as any).sha256, null, 'the program may save over it');

  const full = path.join(dataDir, row.stored_path);
  writeFileSync(full, 'second, longer version');
  await call('GET', '/api/duplicates');
  for (let i = 0; i < 40 && (db.prepare('SELECT sha256 FROM designs WHERE id = ?').get(created.body.id) as any).sha256 === null; i++) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const after = db.prepare('SELECT sha256, size FROM designs WHERE id = ?').get(created.body.id) as any;
  assert.ok(after.sha256 && after.sha256 !== row.sha256);
  assert.equal(after.size, readFileSync(full).length);
  await call('DELETE', `/api/designs/${created.body.id}`);
});

test('opening: goes to the system, reports a missing program, and refuses to run programs', async () => {
  opened.length = 0;
  const fine = await upload('part.kicad_pcb', 'open-a', { name: 'Part' });
  assert.equal((await call('POST', `/api/designs/${fine.body.id}/open`, {})).status, 200);
  assert.ok(opened[0].endsWith('part.kicad_pcb'));

  const attached = await upload('notes.pdf', 'open-b', {}, `/api/designs/${fine.body.id}/files`);
  assert.equal((await call('POST', `/api/designs/${fine.body.id}/open`, { file_id: attached.body.files[1].id })).status, 200);
  assert.ok(opened[1].endsWith('notes.pdf'));

  assert.equal((await call('POST', `/api/designs/${fine.body.id}/reveal`, {})).status, 200);
  assert.ok(opened[2].startsWith('reveal:'));

  const noProgram = await upload('noprogram.xyz', 'open-c');
  const failed = await call('POST', `/api/designs/${noProgram.body.id}/open`, {});
  assert.equal(failed.status, 422);
  assert.match(failed.body.error, /no associated program/);

  for (const name of ['virus.exe', 'run.BAT', 'x.ps1', 'link.lnk', 'a.js']) {
    const risky = await upload(name, `open-${name}`);
    const before = opened.length;
    const refused = await call('POST', `/api/designs/${risky.body.id}/open`, {});
    assert.equal(refused.status, 400, name);
    assert.equal(opened.length, before, `${name} must not reach the system`);
  }

  const meta = await call('GET', '/api/meta');
  assert.equal(meta.body.can_open, true);
});

test('scad lookup finds a neighbour by file name, its own project first', async () => {
  const main = await upload('main.scad', 'use <units.scad>');
  const near = await upload('units.scad', '// near');
  const far = await upload('units.scad', '// far', { project_id: String(otherProjectId) });
  assert.ok(near.body.id && far.body.id);
  const found = await call('GET', `/api/scad-lookup?name=${encodeURIComponent('MCAD/units.scad')}&design=${main.body.id}`);
  assert.equal(found.status, 200);
  assert.equal(await (await fetch(base + found.body.url)).text(), '// near');
  assert.equal((await call('GET', `/api/scad-lookup?name=missing.scad&design=${main.body.id}`)).status, 404);
});

test('errors come back in the language the page asks for', async () => {
  const missing = (language?: string) => fetch(`${base}/api/designs/999999`, { headers: language ? { 'X-UI-Language': language } : {} }).then((r) => r.json());
  assert.equal((await missing()).error, 'Design not found');
  assert.equal((await missing('en')).error, 'Design not found');
  assert.equal((await missing('ar')).error, 'التصميم غير موجود');
});

test('a new library starts with English type names', async () => {
  const names = (await call('GET', '/api/meta')).body.types.map((type: any) => type.name);
  assert.ok(names.includes('Laser cutting') && names.includes('PCB'));
  assert.ok(!names.some((name: string) => /[؀-ۿ]/.test(name)));
});

test('migration: stays at the current version and keeps the PCB type once', () => {
  const version = db.prepare('PRAGMA user_version').get() as any;
  assert.equal(version.user_version, 1);
  const types = db.prepare(`SELECT COUNT(*) AS n FROM design_types WHERE slug = 'pcb'`).get() as any;
  assert.equal(types.n, 1);
});
