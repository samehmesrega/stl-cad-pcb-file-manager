// Ruida / RDWorks .rd job files. The format is undocumented: the bytes are scrambled with a "magic" value and
// hold plain machine commands. Command layout follows the reverse engineering in the MeerK40t project.
import { DrawingBuilder } from './drawing.ts';
import type { Drawing } from './drawing.ts';
import { msg } from '../../shared/i18n.ts';

function unscramble(b: number, magic: number): number {
  b = (b - 1) & 0xff;
  b ^= magic;
  b ^= (b >> 7) & 0xff;
  b ^= (b << 7) & 0xff;
  b ^= (b >> 7) & 0xff;
  return b;
}

/** Parameter bytes after each motion opcode. Real commands always have exactly this length. */
const MOTION_LENGTH: Record<number, number> = {
  0x88: 10, 0x89: 4, 0x8a: 2, 0x8b: 2,
  0xa8: 10, 0xa9: 4, 0xaa: 2, 0xab: 2,
};

/** Every opcode seen in the protocol. A wrong magic decodes to many bytes outside this set. */
const KNOWN_OPCODES = new Set([
  0x80, 0x88, 0x89, 0x8a, 0x8b, 0xa0, 0xa5, 0xa8, 0xa9, 0xaa, 0xab,
  0xc0, 0xc1, 0xc2, 0xc3, 0xc4, 0xc5, 0xc6, 0xc7, 0xc8, 0xc9, 0xca, 0xcc, 0xcd, 0xce, 0xcf,
  0xd7, 0xd8, 0xd9, 0xda, 0xe5, 0xe6, 0xe7, 0xea, 0xeb, 0xf0, 0xf1, 0xf2,
]);

/** Controllers use different magic values, so try them all and keep the one that decodes to well-formed motion. */
function detectMagic(raw: Uint8Array): number {
  const sample = raw.subarray(0, 64 * 1024);
  let best = 0x88;
  let bestScore = 0;
  for (let magic = 0; magic < 256; magic++) {
    const lut = new Uint8Array(256);
    for (let b = 0; b < 256; b++) lut[b] = unscramble(b, magic);
    let score = 0;
    let op = -1;
    let params = 0;
    for (let i = 0; i <= sample.length; i++) {
      const value = i < sample.length ? lut[sample[i]] : 0x80;
      if (value < 0x80) {
        params++;
        continue;
      }
      const expected = MOTION_LENGTH[op];
      if (expected !== undefined) score += params === expected ? 1 : -1;
      if (!KNOWN_OPCODES.has(value)) score--;
      op = value;
      params = 0;
    }
    if (score > bestScore) {
      bestScore = score;
      best = magic;
    }
  }
  return best;
}

const u14 = (d: Uint8Array, o: number) => ((d[o] & 0x7f) << 7) | (d[o + 1] & 0x7f);
const rel = (d: Uint8Array, o: number) => {
  const value = u14(d, o);
  return value > 0x1fff ? value - 0x4000 : value;
};
const u35 = (d: Uint8Array, o: number) =>
  (d[o] & 0x7f) * 2 ** 28 + (((d[o + 1] & 0x7f) << 21) | ((d[o + 2] & 0x7f) << 14) | ((d[o + 3] & 0x7f) << 7) | (d[o + 4] & 0x7f));
const abs = (d: Uint8Array, o: number) => {
  const value = u35(d, o) % 2 ** 32;
  return value >= 2 ** 31 ? value - 2 ** 32 : value;
};
const hexColor = (c: number) => {
  const r = c & 0xff;
  const g = (c >> 8) & 0xff;
  const b = (c >> 16) & 0xff;
  return `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
};

interface Part {
  color?: string;
  speed?: number;
  minPower?: number;
  maxPower?: number;
}

export function parseRd(buffer: ArrayBuffer): Drawing {
  const raw = new Uint8Array(buffer);
  // Some RDWorks versions also save closed project files with the .rd extension. They hold no machine commands.
  if (new TextDecoder('latin1').decode(raw.subarray(1, 10)) === 'RDFILEVER') {
    throw new Error(msg('This is a locked RDWorks project file, not a machine file. Open it in RDWorks and use Save to UFile to preview it here.'));
  }
  const magic = detectMagic(raw);
  const data = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) data[i] = unscramble(raw[i], magic);

  const parts = new Map<number, Part>();
  const partOf = (index: number) => {
    let part = parts.get(index);
    if (!part) parts.set(index, (part = {}));
    return part;
  };
  const paths: { part: number; pts: number[] }[] = [];
  let current: { part: number; pts: number[] } | null = null;
  let part = 0;
  let x = 0;
  let y = 0;
  let cuts = 0;
  let name = '';

  const moveTo = (nx: number, ny: number) => {
    x = nx;
    y = ny;
    current = null;
  };
  const cutTo = (nx: number, ny: number) => {
    if (!current || current.part !== part) {
      current = { part, pts: [x, y] };
      paths.push(current);
    }
    x = nx;
    y = ny;
    current.pts.push(x, y);
    cuts++;
  };

  let i = 0;
  while (i < data.length) {
    const start = i++;
    while (i < data.length && data[i] < 0x80) i++;
    const c = data.subarray(start, i);
    const len = c.length;
    const op = c[0];

    if (op === 0x88 && len >= 11) moveTo(abs(c, 1), abs(c, 6));
    else if (op === 0x89 && len >= 5) moveTo(x + rel(c, 1), y + rel(c, 3));
    else if (op === 0x8a && len >= 3) moveTo(x + rel(c, 1), y);
    else if (op === 0x8b && len >= 3) moveTo(x, y + rel(c, 1));
    else if (op === 0xa8 && len >= 11) cutTo(abs(c, 1), abs(c, 6));
    else if (op === 0xa9 && len >= 5) cutTo(x + rel(c, 1), y + rel(c, 3));
    else if (op === 0xaa && len >= 3) cutTo(x + rel(c, 1), y);
    else if (op === 0xab && len >= 3) cutTo(x, y + rel(c, 1));
    else if (op === 0xca && c[1] === 0x02 && len >= 3) part = c[2];
    else if (op === 0xca && c[1] === 0x06 && len >= 8) partOf(c[2]).color = hexColor(u35(c, 3));
    else if (op === 0xc9 && c[1] === 0x04 && len >= 8) partOf(c[2]).speed = u35(c, 3) / 1000;
    else if (op === 0xc6 && c[1] === 0x31 && len >= 5) partOf(c[2]).minPower = u14(c, 3) / 163.84;
    else if (op === 0xc6 && c[1] === 0x32 && len >= 5) partOf(c[2]).maxPower = u14(c, 3) / 163.84;
    else if (op === 0xe7 && c[1] === 0x01) name = String.fromCharCode(...c.subarray(2)).replace(/\0.*$/, '');
    else if (op === 0xd7) break;
  }

  if (!cuts) throw new Error(msg('RD: no cutting paths were found in this file'));

  const builder = new DrawingBuilder();
  const layerIndex = new Map<number, number>();
  for (const partNumber of [...new Set(paths.map((p) => p.part))].sort((a, b) => a - b)) {
    const info = parts.get(partNumber) ?? {};
    const detail = [
      info.speed !== undefined ? `${+info.speed.toFixed(1)} mm/s` : '',
      info.maxPower !== undefined ? `${+(info.minPower ?? 0).toFixed(1)}–${+info.maxPower.toFixed(1)}%` : '',
    ].filter(Boolean).join(' · ');
    layerIndex.set(partNumber, builder.addLayer({ name: `Layer ${partNumber}`, color: info.color ?? '#ff5a1f', detail }));
  }
  for (const path of paths) {
    // Coordinates are micrometres with Y growing down the bed.
    const pts = path.pts.map((v, index) => (index % 2 ? -v / 1000 : v / 1000));
    const layer = layerIndex.get(path.part)!;
    builder.addStroke(layer, builder.layers[layer].color, pts);
  }
  const info: [string, string][] = [[msg('Cutting paths'), String(paths.length)]];
  if (name) info.unshift([msg('File name on the machine'), name]);
  return builder.build('mm', info);
}
