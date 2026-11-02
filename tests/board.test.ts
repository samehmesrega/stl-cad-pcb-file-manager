import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderBoardFiles } from '../src/loaders/board.ts';
import { scadDependencies } from '../src/loaders/scadClient.ts';

// The library reads files with FileReader, which only exists in browsers and workers.
(globalThis as any).FileReader ??= class {
  result: string | null = null;
  error = null;
  listeners: Record<string, () => void> = {};
  addEventListener(name: string, listener: () => void) {
    this.listeners[name] = listener;
  }
  removeEventListener() {}
  readAsText(file: File) {
    void file.text().then((text) => {
      this.result = text;
      this.listeners.load();
    });
  }
};

const square = (size: number) => `%FSLAX46Y46*%
%MOMM*%
%LPD*%
%ADD10C,0.200000*%
D10*
X0Y0D02*
X${size}000000Y0D01*
X${size}000000Y${size}000000D01*
X0Y${size}000000D01*
X0Y0D01*
M02*
`;

const pad = `%FSLAX46Y46*%
%MOMM*%
%LPD*%
%ADD10R,2.000000X2.000000*%
D10*
X10000000Y10000000D03*
M02*
`;

// A hole at 0.5 inch, 0.5 inch: right in the middle of a 25.4 mm board.
const drillInInches = `M48
INCH,TZ
T1C0.0315
%
G90
G05
T1
X5000Y5000
T0
M30
`;

const file = (name: string, content: string) => new File([content], name);

test('board: layers are identified from KiCad file names', async () => {
  const board = await renderBoardFiles([
    file('b-F_Cu.gtl', pad),
    file('b-B_Cu.gbl', pad),
    file('b-Edge_Cuts.gm1', square(25)),
    file('b-PTH.drl', drillInInches),
  ]);
  assert.deepEqual(new Set(board.layers.map((layer) => `${layer.type}:${layer.side}`)), new Set(['copper:top', 'copper:bottom', 'outline:all', 'drill:all']));
  assert.equal(board.units, 'mm');
  assert.ok(board.hasShape);
  assert.ok(board.width > 24 && board.width < 27, `width ${board.width}`);
  assert.ok(board.top.includes('<svg') && board.bottom.includes('scale(-1,1)'));
});

test('board: holes from a drill file in inches line up with a board in millimetres', async () => {
  const board = await renderBoardFiles([file('b-F_Cu.gtl', pad), file('b-Edge_Cuts.gm1', square(25)), file('b-PTH.drl', drillInInches)]);
  const drill = board.layers.find((layer) => layer.type === 'drill')!;
  const [, cx] = /cx="([\d.]+)"/.exec(drill.svg)!;
  const [, r] = /\br="([\d.]+)"/.exec(drill.svg)!;
  assert.ok(Math.abs(Number(cx) - 12.7) < 0.001, `hole at ${cx} mm, expected 12.7`);
  assert.ok(Math.abs(Number(r) - 0.4) < 0.001, `radius ${r} mm, expected 0.4`);
});

test('board: an unreadable file is skipped instead of losing the board', async () => {
  const board = await renderBoardFiles([file('b-F_Cu.gtl', pad), file('b-Edge_Cuts.gm1', square(25)), file('broken.gbr', '\u0000\u0001 not a gerber at all %%%')]);
  assert.ok(board.layers.some((layer) => layer.type === 'copper'));
  assert.ok(board.skipped.length === 0 || board.skipped.includes('broken.gbr'));
});

test('board: without an outline the picture still has a size', async () => {
  const board = await renderBoardFiles([file('single.gtl', pad)]);
  assert.equal(board.hasShape, false);
  assert.ok(board.width > 0 && board.height > 0);
});

test('board: a lone KiCad copper layer gets a real size despite its aperture macros', async () => {
  const roundRect = `%FSLAX46Y46*%
%MOMM*%
%LPD*%
%AMRoundRect*
0 Rectangle with rounded corners*
21,1,$2+$2-$1-$1,$3+$3,0,0,0*
21,1,$2+$2,$3+$3-$1-$1,0,0,0*
1,1,$1+$1,$4,$5*
1,1,$1+$1,$6,$7*
1,1,$1+$1,$8,$9*
1,1,$1+$1,$10,$11*%
%ADD10RoundRect,0.250000X-0.750000X-0.600000X0.750000X-0.600000X0.750000X0.600000X-0.750000X0.600000X0*%
G01*
D10*
X10000000Y10000000D03*
X20000000Y15000000D03*
M02*
`;
  const board = await renderBoardFiles([file('top.gtl', roundRect)]);
  assert.ok(board.width > 10 && board.width < 13, `width ${board.width}`);
  assert.ok(board.height > 5 && board.height < 8, `height ${board.height}`);
});

test('scad: finds the files a script names', () => {
  const found = scadDependencies(`use <utils/build_plate.scad>
include <units.scad>;
use <OverpassMono-Bold.ttf>
linear_extrude(file = "a.dxf");
import("shape.stl");
surface(file="height.dat");
use <MCAD/gears.scad>
cube(1);`);
  assert.deepEqual(found.sort(), ['MCAD/gears.scad', 'height.dat', 'shape.stl', 'units.scad', 'utils/build_plate.scad'].sort());
});
