import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DxfParser } from '@mlightcad/dxf-json';
import { extensionOf, formatOf, normalizeSearch } from '../shared/formats.ts';
import { buildDrawing, cleanText, dxfSource, normalizeDxf } from '../src/loaders/cad.ts';
import { parseGcode } from '../src/loaders/gcode.ts';
import { parsePlt } from '../src/loaders/plt.ts';
import { parseRd } from '../src/loaders/rd.ts';

const bytes = (text: string) => new TextEncoder().encode(text).buffer as ArrayBuffer;

function scramble(b: number, magic: number) {
  b ^= (b >> 7) & 0xff;
  b ^= (b << 7) & 0xff;
  b ^= (b >> 7) & 0xff;
  b ^= magic;
  return (b + 1) & 0xff;
}

const abs35 = (v: number) => [(v / 2 ** 28) & 0x7f, (v >> 21) & 0x7f, (v >> 14) & 0x7f, (v >> 7) & 0x7f, v & 0x7f];
const rel14 = (v: number) => {
  const u = v < 0 ? v + 0x4000 : v;
  return [(u >> 7) & 0x7f, u & 0x7f];
};

function rdFile(magic: number) {
  // An 8 x 8 mm square cut with absolute and relative commands, repeated so magic detection has data to score.
  const commands: number[] = [];
  for (let i = 0; i < 40; i++) {
    commands.push(0x88, ...abs35(0), ...abs35(0));
    commands.push(0xaa, ...rel14(8000));
    commands.push(0xab, ...rel14(8000));
    commands.push(0xa8, ...abs35(0), ...abs35(8000));
    commands.push(0xa9, ...rel14(0), ...rel14(-8000));
  }
  commands.push(0xca, 0x06, 0x00, ...abs35(0x0000ff), 0xd7);
  return Uint8Array.from(commands.map((b) => scramble(b, magic))).buffer as ArrayBuffer;
}

test('RD: detects the scrambling magic for different controllers', () => {
  for (const magic of [0x88, 0x11, 0x38]) {
    const drawing = parseRd(rdFile(magic));
    assert.equal(drawing.unit, 'mm');
    assert.equal(drawing.bounds.maxX, 8);
    assert.equal(drawing.bounds.minY, -8);
  }
});

test('RD: explains closed RDWorks project files', () => {
  const file = new TextEncoder().encode('RDFILEVER8.0.01').buffer as ArrayBuffer;
  assert.throws(() => parseRd(file), /RDWorks/);
});

test('RD: rejects a file without cut commands', () => {
  assert.throws(() => parseRd(new Uint8Array(4096).buffer));
});

test('G-code: printer file splits extrusion from travel, one layer per Z', () => {
  const path = parseGcode(bytes('G21\nG90\nM82\nG92 E0\nG0 Z0.3\nG0 X10 Y10\nG1 X20 Y10 E1\nG1 X20 Y20 E2\nG1 E1\nG0 X10 Y10 Z0.6\nG1 X20 Y10 E3\n'));
  assert.equal(path.mode, 'print');
  assert.equal(path.layers.length, 2);
  assert.equal(path.feed.length / 6, 3);
  assert.deepEqual(path.min.slice(0, 2), [10, 10]);
  assert.equal(path.max[2], 0.6);
});

test('G-code: CNC file in inches with arcs', () => {
  const path = parseGcode(bytes('(part)\nG20 G90\nG0 X1 Y0\nM3 S1000\nG2 X-1 Y0 I-1 J0 F10\nG2 X1 Y0 R1\nM5\nG1 X0 Y0\n'));
  assert.equal(path.mode, 'cut');
  assert.ok(Math.abs(path.max[0] - 25.4) < 1e-3);
  assert.ok(Math.abs(path.min[1] + 25.4) < 0.1, 'a clockwise half circle from +X goes through -Y');
  assert.ok(Math.abs(path.max[1] - 25.4) < 0.1, 'the second arc returns through +Y');
  assert.ok(path.feedLength > 150 && path.feedLength < 170);
});

test('G-code: laser power off counts as travel', () => {
  const path = parseGcode(bytes('M3 S500\nG1 X10 F600\nG1 X20 S0\nG1 X30 S500\n'));
  assert.equal(path.feed.length / 6, 2);
  assert.equal(path.travel.length / 6, 1);
});

test('PLT: converts plotter units to millimetres and keeps pens apart', () => {
  const drawing = parsePlt(bytes('IN;SP1;PU0,0;PD400,0,400,400;SP2;PU0,0;PD40,40;'));
  assert.equal(drawing.bounds.maxX, 10);
  assert.equal(drawing.layers.length, 2);
});

const R12_WITH_BLOCK = [
  '0', 'SECTION', '2', 'BLOCKS',
  '0', 'BLOCK', '8', '0', '2', 'B1', '70', '0', '10', '0', '20', '0', '3', 'B1',
  '0', 'LINE', '8', '0', '10', '0', '20', '0', '11', '10', '21', '0',
  '0', 'ENDBLK', '8', '0',
  '0', 'ENDSEC',
  '0', 'SECTION', '2', 'ENTITIES',
  '0', 'INSERT', '8', 'CUT', '2', 'B1', '10', '100', '20', '50', '41', '2', '42', '2', '50', '90',
  '0', 'TEXT', '8', 'CUT', '10', '1', '20', '1', '40', '3', '1', 'لوحة',
  '0', 'ENDSEC', '0', 'EOF', '',
].join('\n');

test('DXF: R12 blocks without AcDbBlockEnd still parse, and inserts apply scale and rotation', () => {
  const drawing = buildDrawing(dxfSource(new DxfParser().parseSync(normalizeDxf(R12_WITH_BLOCK))));
  assert.equal(drawing.labels[0].text, 'لوحة');
  const line = drawing.groups[0].pts;
  assert.ok(Math.abs(line[0] - 100) < 1e-9 && Math.abs(line[1] - 50) < 1e-9);
  assert.ok(Math.abs(line[2] - 100) < 1e-9 && Math.abs(line[3] - 70) < 1e-9, '10 units along X, doubled, turned 90 degrees');
});

test('DXF: bulges become arcs and mirrored arcs flip across the Y axis', () => {
  const dxf = [
    '0', 'SECTION', '2', 'ENTITIES',
    '0', 'LWPOLYLINE', '8', '0', '90', '2', '70', '0', '10', '0', '20', '0', '42', '1', '10', '10', '20', '0',
    '0', 'ARC', '8', 'M', '10', '20', '20', '0', '40', '5', '50', '0', '51', '90', '210', '0', '220', '0', '230', '-1',
    '0', 'ENDSEC', '0', 'EOF', '',
  ].join('\n');
  const drawing = buildDrawing(dxfSource(new DxfParser().parseSync(normalizeDxf(dxf))));
  const bulged = drawing.groups.find((g) => drawing.layers[g.layer].name === '0')!;
  let lowest = 0;
  for (let i = 1; i < bulged.pts.length; i += 2) lowest = Math.min(lowest, bulged.pts[i]);
  assert.ok(Math.abs(lowest + 5) < 0.05, 'a bulge of 1 is a half circle of radius 5, to the right of travel');
  const mirrored = drawing.groups.find((g) => drawing.layers[g.layer].name === 'M')!;
  assert.ok(mirrored.pts[0] < -20, 'the arc centre is at X = -20 in world coordinates');
});

test('DXF: an empty drawing fails instead of showing a blank sheet', () => {
  const dxf = ['0', 'SECTION', '2', 'ENTITIES', '0', 'ENDSEC', '0', 'EOF', ''].join('\n');
  assert.throws(() => buildDrawing(dxfSource(new DxfParser().parseSync(dxf))));
});

test('CAD text: strips MTEXT markup and decodes escapes', () => {
  assert.deepEqual(cleanText('{\\fArial|b0;Plate}\\P%%c10 \\U+0644\\U+0648'), ['Plate', 'Ø10 لو']);
});

test('search normalisation forgives Arabic spelling variants', () => {
  assert.equal(normalizeSearch('لَوحة_إسم-٣'), 'لوحه اسم 3');
  assert.equal(normalizeSearch('أحمد مصطفى'), 'احمد مصطفي');
});

test('formats: unknown files are stored without a viewer', () => {
  assert.equal(formatOf('STEP').viewer, 'model');
  assert.equal(formatOf('rd').category, 'machine');
  assert.equal(formatOf('xyz').viewer, 'none');
  assert.equal(extensionOf('a.b.GCODE'), 'gcode');
  assert.equal(extensionOf('noextension'), '');
});
