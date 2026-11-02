// Toolpath parser for 3D printer, CNC and laser G-code.
import { msg } from '../../shared/i18n.ts';

export interface ToolpathLayer {
  z: number;
  /** Vertex counts reached by the end of this layer. */
  feedEnd: number;
  travelEnd: number;
}

export interface Toolpath {
  /** Pairs of xyz points, one pair per segment. */
  feed: Float32Array;
  travel: Float32Array;
  layers: ToolpathLayer[];
  min: [number, number, number];
  max: [number, number, number];
  flat: boolean;
  /** Machine style inferred from the file: printers extrude, CNC and lasers do not. */
  mode: 'print' | 'cut';
  feedLength: number;
  travelLength: number;
  seconds: number;
  lines: number;
}

class FloatList {
  data = new Float32Array(1 << 14);
  length = 0;
  push6(a: number, b: number, c: number, d: number, e: number, f: number) {
    if (this.length + 6 > this.data.length) {
      const next = new Float32Array(this.data.length * 2);
      next.set(this.data);
      this.data = next;
    }
    const { data, length } = this;
    data[length] = a;
    data[length + 1] = b;
    data[length + 2] = c;
    data[length + 3] = d;
    data[length + 4] = e;
    data[length + 5] = f;
    this.length = length + 6;
  }
  done() {
    return this.data.slice(0, this.length);
  }
}

const WORD = /([A-Z])\s*([-+]?(?:\d+\.?\d*|\.\d+))/g;
const LAYER_COMMENT = /^;\s*layer[:_ ]/i;

export function parseGcode(buffer: ArrayBuffer): Toolpath {
  const text = new TextDecoder('latin1').decode(buffer);
  const feed = new FloatList();
  const travel = new FloatList();
  const layers: ToolpathLayer[] = [];

  let x = 0, y = 0, z = 0, e = 0;
  let offX = 0, offY = 0, offZ = 0, offE = 0;
  let absolute = true;
  let absoluteE = true;
  let scale = 1;
  let motion = 0;
  let rate = 0;
  let toolOff = false;
  let sZero = false;
  let sawExtrusion = false;
  let feedLength = 0, travelLength = 0, seconds = 0, lineCount = 0;
  let layerZ = NaN;
  let forceLayer = false;
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];

  const closeLayer = () => {
    if (layers.length) {
      const last = layers[layers.length - 1];
      last.feedEnd = feed.length / 3;
      last.travelEnd = travel.length / 3;
    }
  };
  const openLayer = (atZ: number) => {
    closeLayer();
    layers.push({ z: atZ, feedEnd: feed.length / 3, travelEnd: travel.length / 3 });
    layerZ = atZ;
  };

  const extend = (px: number, py: number, pz: number) => {
    if (px < min[0]) min[0] = px;
    if (py < min[1]) min[1] = py;
    if (pz < min[2]) min[2] = pz;
    if (px > max[0]) max[0] = px;
    if (py > max[1]) max[1] = py;
    if (pz > max[2]) max[2] = pz;
  };

  const segment = (nx: number, ny: number, nz: number, cutting: boolean) => {
    const length = Math.hypot(nx - x, ny - y, nz - z);
    if (length === 0) return;
    if (cutting) {
      if (forceLayer || !layers.length || Math.abs(nz - layerZ) > 1e-4) {
        openLayer(nz);
        forceLayer = false;
      }
      feed.push6(x, y, z, nx, ny, nz);
      feedLength += length;
      extend(x, y, z);
      extend(nx, ny, nz);
    } else {
      travel.push6(x, y, z, nx, ny, nz);
      travelLength += length;
    }
    if (rate > 0) seconds += length / (rate / 60);
    x = nx;
    y = ny;
    z = nz;
  };

  let position = 0;
  while (position < text.length) {
    let end = text.indexOf('\n', position);
    if (end < 0) end = text.length;
    const rawLine = text.slice(position, end);
    position = end + 1;
    lineCount++;

    const commentAt = rawLine.indexOf(';');
    if (commentAt >= 0 && LAYER_COMMENT.test(rawLine.slice(commentAt))) forceLayer = true;
    let line = commentAt >= 0 ? rawLine.slice(0, commentAt) : rawLine;
    if (line.includes('(')) line = line.replace(/\([^)]*\)/g, '');
    line = line.toUpperCase();
    if (!line.trim()) continue;

    let g: number | null = null;
    let hasMotionWord = false;
    let vX: number | undefined, vY: number | undefined, vZ: number | undefined, vE: number | undefined;
    let vI: number | undefined, vJ: number | undefined, vR: number | undefined;
    WORD.lastIndex = 0;
    let word: RegExpExecArray | null;
    while ((word = WORD.exec(line))) {
      const value = Number(word[2]);
      switch (word[1]) {
        case 'G':
          if (value === 0 || value === 1 || value === 2 || value === 3) {
            motion = value;
            hasMotionWord = true;
          } else if (value === 90) absolute = true;
          else if (value === 91) absolute = false;
          else if (value === 20) scale = 25.4;
          else if (value === 21) scale = 1;
          else g = value;
          break;
        case 'M':
          if (value === 82) absoluteE = true;
          else if (value === 83) absoluteE = false;
          else if (value === 3 || value === 4) toolOff = false;
          else if (value === 5) toolOff = true;
          break;
        case 'X': vX = value; break;
        case 'Y': vY = value; break;
        case 'Z': vZ = value; break;
        case 'E': vE = value; break;
        case 'I': vI = value; break;
        case 'J': vJ = value; break;
        case 'R': vR = value; break;
        case 'F': rate = value * scale; break;
        case 'S': sZero = value === 0; break;
      }
    }

    if (g === 92) {
      if (vX !== undefined) offX = x - vX * scale;
      if (vY !== undefined) offY = y - vY * scale;
      if (vZ !== undefined) offZ = z - vZ * scale;
      if (vE !== undefined) offE = e - vE;
      continue;
    }
    if (g === 28) {
      x = 0; y = 0; z = 0;
      continue;
    }
    if (g !== null && !hasMotionWord) continue;
    if (vX === undefined && vY === undefined && vZ === undefined && vE === undefined) continue;

    const nx = vX === undefined ? x : absolute ? vX * scale + offX : x + vX * scale;
    const ny = vY === undefined ? y : absolute ? vY * scale + offY : y + vY * scale;
    const nz = vZ === undefined ? z : absolute ? vZ * scale + offZ : z + vZ * scale;

    let extruding = false;
    if (vE !== undefined) {
      sawExtrusion = true;
      const nextE = absoluteE ? vE + offE : e + vE;
      extruding = nextE > e + 1e-6;
      e = nextE;
    }
    const cutting = sawExtrusion ? extruding : motion !== 0 && !toolOff && !sZero;

    if ((motion === 2 || motion === 3) && (vI !== undefined || vJ !== undefined || vR !== undefined)) {
      let cx: number, cy: number;
      if (vR !== undefined) {
        const r = vR * scale;
        const dx = nx - x, dy = ny - y;
        const d = Math.hypot(dx, dy) || 1e-9;
        const h = Math.sqrt(Math.max(0, r * r - (d * d) / 4));
        const side = (motion === 3 ? 1 : -1) * (r >= 0 ? 1 : -1);
        cx = x + dx / 2 - (side * h * dy) / d;
        cy = y + dy / 2 + (side * h * dx) / d;
      } else {
        cx = x + (vI ?? 0) * scale;
        cy = y + (vJ ?? 0) * scale;
      }
      const radius = Math.hypot(x - cx, y - cy);
      const a0 = Math.atan2(y - cy, x - cx);
      let a1 = Math.atan2(ny - cy, nx - cx);
      if (motion === 3 && a1 <= a0 + 1e-9) a1 += Math.PI * 2;
      if (motion === 2 && a1 >= a0 - 1e-9) a1 -= Math.PI * 2;
      const steps = Math.max(2, Math.min(180, Math.ceil(Math.abs(a1 - a0) / (Math.PI / 36))));
      const startZ = z;
      for (let s = 1; s <= steps; s++) {
        const t = s / steps;
        const a = a0 + (a1 - a0) * t;
        const last = s === steps;
        segment(last ? nx : cx + radius * Math.cos(a), last ? ny : cy + radius * Math.sin(a), startZ + (nz - startZ) * t, cutting);
      }
    } else {
      segment(nx, ny, nz, cutting);
    }
  }
  closeLayer();

  if (!feed.length && !travel.length) throw new Error(msg('G-code: no moves were found in this file'));
  if (!Number.isFinite(min[0])) {
    // Only rapid moves: frame on those.
    const data = travel.data;
    for (let i = 0; i < travel.length; i += 3) extend(data[i], data[i + 1], data[i + 2]);
    layers.push({ z: 0, feedEnd: 0, travelEnd: travel.length / 3 });
  }

  return {
    feed: feed.done(),
    travel: travel.done(),
    layers,
    min,
    max,
    flat: max[2] - min[2] < 1e-3,
    mode: sawExtrusion ? 'print' : 'cut',
    feedLength,
    travelLength,
    seconds,
    lines: lineCount,
  };
}
