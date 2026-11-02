// Converts parsed DWG (libredwg) and DXF (dxf-json) databases to a Drawing.
// The two parsers share entity names and most fields; `Source` holds the differences.
import { DrawingBuilder } from './drawing.ts';
import type { Drawing, DrawingLabel } from './drawing.ts';
import { msg } from '../../shared/i18n.ts';

type Entity = Record<string, any>;
type Matrix = [number, number, number, number, number, number];
type Point = { x: number; y: number };

export interface CadBlock {
  base: Point;
  entities: Entity[];
}

export interface CadLayer {
  name: string;
  colorIndex?: number;
  color?: number;
  off?: boolean;
  frozen?: boolean;
}

export interface CadSource {
  entities: Entity[];
  blocks: Map<string, CadBlock>;
  layers: CadLayer[];
  insUnits?: number;
  /** DWG angles are radians, DXF angles are degrees. */
  radians: boolean;
  /** Bit marking a closed LWPOLYLINE: 0x200 in libredwg, 1 in DXF. */
  closedFlag: number;
  format: string;
}

const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];
const TAU = Math.PI * 2;
const ARC_STEP = Math.PI / 45;
const MAX_INSERT_DEPTH = 16;

const multiply = (m: Matrix, n: Matrix): Matrix => [
  m[0] * n[0] + m[2] * n[1],
  m[1] * n[0] + m[3] * n[1],
  m[0] * n[2] + m[2] * n[3],
  m[1] * n[2] + m[3] * n[3],
  m[0] * n[4] + m[2] * n[5] + m[4],
  m[1] * n[4] + m[3] * n[5] + m[5],
];
const translate = (x: number, y: number): Matrix => [1, 0, 0, 1, x, y];
const scale = (x: number, y: number): Matrix => [x, 0, 0, y, 0, 0];
const rotate = (a: number): Matrix => [Math.cos(a), Math.sin(a), -Math.sin(a), Math.cos(a), 0, 0];

function aciColor(index: number): string {
  const fixed: Record<number, string> = {
    1: '#ff0000', 2: '#ffff00', 3: '#00ff00', 4: '#00ffff', 5: '#0000ff',
    6: '#ff00ff', 7: '#ffffff', 8: '#808080', 9: '#c0c0c0',
    250: '#333333', 251: '#505050', 252: '#696969', 253: '#808080', 254: '#bebebe', 255: '#ffffff',
  };
  if (fixed[index]) return fixed[index];
  if (index < 10 || index > 249) return '#ffffff';
  const hue = (Math.floor(index / 10) - 1) * 15;
  const shade = index % 10;
  const value = [1, 1, 0.65, 0.65, 0.5, 0.5, 0.3, 0.3, 0.15, 0.15][shade];
  const saturation = shade % 2 ? 0.5 : 1;
  const channel = (n: number) => {
    const k = (n + hue / 60) % 6;
    return Math.round(255 * value * (1 - saturation * Math.max(0, Math.min(k, 4 - k, 1))));
  };
  return `#${[channel(5), channel(3), channel(1)].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}

const rgbColor = (value: number) => `#${(value & 0xffffff).toString(16).padStart(6, '0')}`;

/** Turns MTEXT markup and CAD escape codes into plain lines. */
export function cleanText(input: unknown): string[] {
  if (typeof input !== 'string') return [];
  const text = input
    .replace(/\\U\+([0-9a-fA-F]{4})/g, (_m, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/%%[cC]/g, 'Ø')
    .replace(/%%[dD]/g, '°')
    .replace(/%%[pP]/g, '±')
    .replace(/%%[uUoOkK]/g, '')
    .replace(/\\[pP];?(?![a-z])/g, '\n')
    .replace(/\\[fFHQTWACL][^;\\]*;/g, '')
    .replace(/\\[LlOoKk]/g, '')
    .replace(/\\S([^;]*)[\^/#]([^;]*);/g, '$1/$2')
    .replace(/\\~/g, ' ')
    .replace(/\\([\\{}])/g, '$1')
    .replace(/[{}]/g, '');
  return text.split('\n').map((line) => line.trim()).filter(Boolean);
}

function arcPoints(cx: number, cy: number, r: number, a0: number, a1: number): number[] {
  const steps = Math.max(2, Math.ceil(Math.abs(a1 - a0) / ARC_STEP));
  const out: number[] = [];
  for (let i = 0; i <= steps; i++) {
    const a = a0 + ((a1 - a0) * i) / steps;
    out.push(cx + r * Math.cos(a), cy + r * Math.sin(a));
  }
  return out;
}

/** Expands polyline vertices, replacing bulges with arcs. */
function bulgePoints(vertices: (Point & { bulge?: number })[], closed: boolean): number[] {
  const out: number[] = [];
  const count = vertices.length;
  for (let i = 0; i < count; i++) {
    const a = vertices[i];
    out.push(a.x, a.y);
    if (!closed && i === count - 1) break;
    const b = vertices[(i + 1) % count];
    const bulge = a.bulge ?? 0;
    if (Math.abs(bulge) < 1e-9) continue;
    const chord = Math.hypot(b.x - a.x, b.y - a.y);
    if (chord < 1e-12) continue;
    const sweep = 4 * Math.atan(bulge);
    const radius = chord / (2 * Math.sin(Math.abs(sweep) / 2));
    const offset = radius * Math.cos(Math.abs(sweep) / 2) * Math.sign(bulge);
    const cx = (a.x + b.x) / 2 - (offset * (b.y - a.y)) / chord;
    const cy = (a.y + b.y) / 2 + (offset * (b.x - a.x)) / chord;
    const start = Math.atan2(a.y - cy, a.x - cx);
    const arc = arcPoints(cx, cy, Math.abs(radius), start, start + sweep);
    for (let k = 2; k < arc.length - 2; k++) out.push(arc[k]);
  }
  if (closed && count) out.push(vertices[0].x, vertices[0].y);
  return out;
}

function ellipsePoints(c: Point, major: Point, ratio: number, a0: number, a1: number): number[] {
  while (a1 <= a0) a1 += TAU;
  const rx = Math.hypot(major.x, major.y);
  const ry = rx * ratio;
  const rotation = Math.atan2(major.y, major.x);
  const cos = Math.cos(rotation);
  const sin = Math.sin(rotation);
  const steps = Math.max(8, Math.ceil((a1 - a0) / ARC_STEP));
  const out: number[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = a0 + ((a1 - a0) * i) / steps;
    const x = rx * Math.cos(t);
    const y = ry * Math.sin(t);
    out.push(c.x + x * cos - y * sin, c.y + x * sin + y * cos);
  }
  return out;
}

/** De Boor evaluation of a (possibly rational) B-spline. */
function splinePoints(degree: number, control: Point[], knots: number[], weights?: number[]): number[] {
  const n = control.length;
  if (n < 2) return [];
  degree = Math.min(degree, n - 1);
  if (knots.length !== n + degree + 1) {
    knots = [];
    for (let i = 0; i < n + degree + 1; i++) knots.push(i <= degree ? 0 : i >= n ? n - degree : i - degree);
  }
  const low = knots[degree];
  const high = knots[n];
  const steps = Math.min(800, Math.max(24, n * 12));
  const out: number[] = [];
  for (let step = 0; step <= steps; step++) {
    const t = low + ((high - low) * step) / steps;
    let span = degree;
    while (span < n - 1 && t >= knots[span + 1]) span++;
    const px: number[] = [], py: number[] = [], pw: number[] = [];
    for (let j = 0; j <= degree; j++) {
      const p = control[span - degree + j];
      const w = weights?.[span - degree + j] ?? 1;
      px[j] = p.x * w;
      py[j] = p.y * w;
      pw[j] = w;
    }
    for (let r = 1; r <= degree; r++) {
      for (let j = degree; j >= r; j--) {
        const i = span - degree + j;
        const denominator = knots[i + degree - r + 1] - knots[i];
        const alpha = denominator ? (t - knots[i]) / denominator : 0;
        px[j] = (1 - alpha) * px[j - 1] + alpha * px[j];
        py[j] = (1 - alpha) * py[j - 1] + alpha * py[j];
        pw[j] = (1 - alpha) * pw[j - 1] + alpha * pw[j];
      }
    }
    out.push(px[degree] / pw[degree], py[degree] / pw[degree]);
  }
  return out;
}

/** Smooth curve through fit points, for splines stored without control points. */
function catmullRom(points: Point[], closed: boolean): number[] {
  const out: number[] = [];
  const n = points.length;
  const at = (i: number) => (closed ? points[(i + n) % n] : points[Math.max(0, Math.min(n - 1, i))]);
  const segments = closed ? n : n - 1;
  for (let i = 0; i < segments; i++) {
    const [p0, p1, p2, p3] = [at(i - 1), at(i), at(i + 1), at(i + 2)];
    for (let s = 0; s < 16; s++) {
      const t = s / 16;
      const t2 = t * t;
      const t3 = t2 * t;
      out.push(
        0.5 * (2 * p1.x + (p2.x - p0.x) * t + (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 + (3 * p1.x - p0.x - 3 * p2.x + p3.x) * t3),
        0.5 * (2 * p1.y + (p2.y - p0.y) * t + (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 + (3 * p1.y - p0.y - 3 * p2.y + p3.y) * t3),
      );
    }
  }
  const last = closed ? points[0] : points[n - 1];
  out.push(last.x, last.y);
  return out;
}

const UNIT_NAMES: Record<number, string> = {
  1: 'in', 2: 'ft', 4: 'mm', 5: 'cm', 6: 'm', 8: 'µin', 9: 'mil', 14: 'dm',
};

export function buildDrawing(source: CadSource): Drawing {
  const builder = new DrawingBuilder();
  const layerIndex = new Map<string, number>();
  const layerColors = new Map<string, string>();
  const skipped = new Map<string, number>();
  const toRad = source.radians ? 1 : Math.PI / 180;
  // POINT entities have no size of their own, so their marker scales with the drawing.
  const pointSize = roughExtent(source.entities) / 400 || 1;
  let drawn = 0;

  const layerColor = (layer: CadLayer) =>
    layer.color !== undefined && layer.color !== null && layer.color > 0 && layer.color !== 0xffffff
      ? rgbColor(layer.color)
      : aciColor(Math.abs(layer.colorIndex ?? 7) || 7);

  for (const layer of source.layers) {
    const color = layerColor(layer);
    layerColors.set(layer.name, color);
    layerIndex.set(layer.name, builder.addLayer({
      name: layer.name,
      color,
      hidden: Boolean(layer.off || layer.frozen || (layer.colorIndex ?? 7) < 0),
    }));
  }
  const layerOf = (name: string) => {
    let index = layerIndex.get(name);
    if (index === undefined) {
      index = builder.addLayer({ name, color: '#ffffff' });
      layerIndex.set(name, index);
      layerColors.set(name, '#ffffff');
    }
    return index;
  };

  const emit = (layer: number, color: string, points: number[], m: Matrix, fill = false) => {
    const out = new Array<number>(points.length);
    for (let i = 0; i < points.length; i += 2) {
      out[i] = m[0] * points[i] + m[2] * points[i + 1] + m[4];
      out[i + 1] = m[1] * points[i] + m[3] * points[i + 1] + m[5];
    }
    builder.addStroke(layer, color, out, fill);
    drawn++;
  };

  const emitText = (layer: number, color: string, m: Matrix, value: {
    text: unknown; x: number; y: number; height: number; rotation: number;
    align: DrawingLabel['align']; baseline: DrawingLabel['baseline'];
  }) => {
    const lines = cleanText(value.text);
    const size = Math.hypot(m[0], m[1]) || 1;
    const rotation = value.rotation + Math.atan2(m[1], m[0]);
    const height = value.height * size;
    lines.forEach((text, lineIndex) => {
      const dy = lineIndex * value.height * 1.5;
      const lx = value.x + dy * Math.sin(value.rotation);
      const ly = value.y - dy * Math.cos(value.rotation);
      builder.addLabel({
        layer, color, text, height, rotation,
        x: m[0] * lx + m[2] * ly + m[4],
        y: m[1] * lx + m[3] * ly + m[5],
        align: value.align,
        baseline: value.baseline,
      });
    });
    if (lines.length) drawn++;
  };

  const plainText = (e: Entity, layer: number, color: string, m: Matrix) => {
    const halign = e.halign ?? e.horizontalJustification ?? 0;
    const valign = e.valign ?? e.verticalJustification ?? 0;
    const aligned = (halign || valign) && e.endPoint && (e.endPoint.x || e.endPoint.y);
    const at = aligned ? e.endPoint : e.startPoint;
    if (!at) return;
    emitText(layer, color, m, {
      text: e.text,
      x: at.x,
      y: at.y,
      height: e.textHeight ?? e.height ?? 1,
      rotation: (e.rotation ?? 0) * toRad,
      align: halign === 1 || halign === 4 ? 'center' : halign === 2 ? 'right' : 'left',
      baseline: valign === 3 ? 'top' : valign === 2 ? 'middle' : 'alphabetic',
    });
  };

  const hatch = (e: Entity, layer: number, color: string, m: Matrix) => {
    const fill = e.solidFill === 1;
    for (const path of e.boundaryPaths ?? []) {
      if (path.vertices) {
        emit(layer, color, bulgePoints(path.vertices, path.isClosed !== false), m, fill);
        continue;
      }
      const points: number[] = [];
      for (const edge of path.edges ?? []) {
        if (edge.type === 1) {
          points.push(edge.start.x, edge.start.y, edge.end.x, edge.end.y);
        } else if (edge.type === 2) {
          const ccw = edge.isCCW !== false;
          const start = edge.startAngle * toRad;
          let end = edge.endAngle * toRad;
          while (end <= start) end += TAU;
          points.push(...(ccw
            ? arcPoints(edge.center.x, edge.center.y, edge.radius, start, end)
            : arcPoints(edge.center.x, edge.center.y, edge.radius, -start, -end)));
        } else if (edge.type === 3) {
          const ratio = edge.lengthOfMinorAxis ?? edge.axisRatio ?? 1;
          const ccw = edge.isCCW !== false;
          const start = (edge.startAngle ?? 0) * toRad;
          const end = (edge.endAngle ?? 360) * toRad;
          const curve = ellipsePoints(edge.center, edge.end, ratio, ccw ? start : TAU - end, ccw ? end : TAU - start);
          points.push(...curve);
        } else if (edge.type === 4 && edge.controlPoints?.length) {
          points.push(...splinePoints(edge.degree ?? 3, edge.controlPoints, edge.knots ?? [], edge.weights));
        }
      }
      emit(layer, color, points, m, fill);
    }
  };

  const visit = (e: Entity, m: Matrix, parentLayer: string | null, parentColor: string | null, depth: number) => {
    if (e.isVisible === false || e.isInPaperSpace) return;

    const layerName = e.layer === '0' && parentLayer ? parentLayer : (e.layer ?? '0');
    const layer = layerOf(layerName);
    const index = e.colorIndex;
    let color: string;
    if (index === 0 && parentColor) color = parentColor;
    else if (index === undefined || index === 256 || index === 0) color = (parentColor && e.layer === '0' ? parentColor : layerColors.get(layerName)) ?? '#ffffff';
    else if (e.color !== undefined && e.color !== null && e.color > 0 && e.color !== 0xffffff) color = rgbColor(e.color);
    else color = aciColor(Math.abs(index));

    // Arcs, circles and polylines on a downward normal are stored mirrored in X.
    const normal = e.extrusionDirection ?? e.normal;
    const ocs: Matrix = normal && normal.z < -0.5 ? multiply(m, scale(-1, 1)) : m;

    switch (e.type) {
      case 'LINE':
        emit(layer, color, [e.startPoint.x, e.startPoint.y, e.endPoint.x, e.endPoint.y], m);
        break;
      case 'CIRCLE':
        emit(layer, color, arcPoints(e.center.x, e.center.y, e.radius, 0, TAU), ocs);
        break;
      case 'ARC': {
        const start = e.startAngle * toRad;
        let end = e.endAngle * toRad;
        while (end <= start) end += TAU;
        emit(layer, color, arcPoints(e.center.x, e.center.y, e.radius, start, end), ocs);
        break;
      }
      case 'ELLIPSE':
        emit(layer, color, ellipsePoints(e.center, e.majorAxisEndPoint, e.axisRatio, e.startAngle ?? 0, e.endAngle ?? TAU), m);
        break;
      case 'LWPOLYLINE':
        emit(layer, color, bulgePoints(e.vertices ?? [], Boolean((e.flag ?? 0) & source.closedFlag)), ocs);
        break;
      case 'POLYLINE':
      case 'POLYLINE2D':
      case 'POLYLINE3D': {
        const vertices = (e.vertices ?? []).filter((v: Entity) => !((v.flag ?? 0) & 16));
        const is3d = e.type === 'POLYLINE3D' || Boolean((e.flag ?? 0) & 8);
        emit(layer, color, bulgePoints(vertices, Boolean((e.flag ?? 0) & 1)), is3d ? m : ocs);
        break;
      }
      case 'SPLINE': {
        const closed = Boolean((e.flag ?? 0) & 1);
        if (e.controlPoints?.length) {
          emit(layer, color, splinePoints(e.degree ?? 3, e.controlPoints, e.knots ?? [], e.weights), m);
        } else if (e.fitPoints?.length) {
          emit(layer, color, catmullRom(e.fitPoints, closed), m);
        }
        break;
      }
      case 'POINT': {
        const p = e.position;
        emit(layer, color, [p.x - pointSize, p.y, p.x + pointSize, p.y], m);
        emit(layer, color, [p.x, p.y - pointSize, p.x, p.y + pointSize], m);
        break;
      }
      case 'SOLID':
      case 'TRACE': {
        const c = e.points ?? [e.corner1, e.corner2, e.corner3, e.corner4].filter(Boolean);
        if (c.length >= 3) {
          // SOLID vertices are stored in a Z order.
          const order = c.length === 4 ? [c[0], c[1], c[3], c[2]] : c;
          emit(layer, color, order.concat(order[0]).flatMap((p: Point) => [p.x, p.y]), ocs, true);
        }
        break;
      }
      case '3DFACE': {
        const c: Point[] = e.vertices ?? [e.corner1, e.corner2, e.corner3, e.corner4].filter(Boolean);
        emit(layer, color, c.concat(c[0]).flatMap((p) => [p.x, p.y]), m);
        break;
      }
      case 'HATCH':
        hatch(e, layer, color, ocs);
        break;
      case 'TEXT':
        plainText(e, layer, color, ocs);
        break;
      case 'ATTRIB': {
        // libredwg nests the text fields, dxf-json keeps them on the entity.
        const inner = typeof e.text === 'object' && e.text ? e.text : e;
        plainText(inner, layer, color, m);
        break;
      }
      case 'MTEXT': {
        const attachment = e.attachmentPoint ?? 1;
        const at = e.insertionPoint;
        if (!at) break;
        const column = (attachment - 1) % 3;
        const row = Math.floor((attachment - 1) / 3);
        const direction = e.direction ?? e.xAxisDirection;
        const rotation = direction && (direction.x || direction.y)
          ? Math.atan2(direction.y, direction.x)
          : (e.rotation ?? 0) * toRad;
        emitText(layer, color, ocs, {
          text: e.text,
          x: at.x,
          y: at.y,
          height: e.textHeight ?? e.height ?? 1,
          rotation,
          align: column === 1 ? 'center' : column === 2 ? 'right' : 'left',
          baseline: row === 0 ? 'top' : row === 1 ? 'middle' : 'alphabetic',
        });
        break;
      }
      case 'INSERT':
      case 'DIMENSION':
      case 'ARC_DIMENSION': {
        for (const attrib of e.attribs ?? []) visit(attrib, m, layerName, color, depth);
        const block = source.blocks.get(e.name);
        if (!block || depth >= MAX_INSERT_DEPTH) break;
        if (e.type !== 'INSERT') {
          // A dimension's block already holds world coordinates.
          for (const child of block.entities) visit(child, m, layerName, color, depth + 1);
          break;
        }
        const at = e.insertionPoint ?? { x: 0, y: 0 };
        const columns = Math.max(1, e.columnCount ?? 1);
        const rows = Math.max(1, e.rowCount ?? 1);
        const angle = (e.rotation ?? 0) * toRad;
        const local = multiply(
          multiply(rotate(angle), scale(e.xScale ?? 1, e.yScale ?? 1)),
          translate(-block.base.x, -block.base.y),
        );
        for (let row = 0; row < rows; row++) {
          for (let column = 0; column < columns; column++) {
            const dx = column * (e.columnSpacing ?? 0);
            const dy = row * (e.rowSpacing ?? 0);
            const place = translate(
              at.x + dx * Math.cos(angle) - dy * Math.sin(angle),
              at.y + dx * Math.sin(angle) + dy * Math.cos(angle),
            );
            const inner = multiply(ocs, multiply(place, local));
            for (const child of block.entities) visit(child, inner, layerName, color, depth + 1);
          }
        }
        break;
      }
      case 'MLINE': {
        const points = (e.vertices ?? []).flatMap((v: Entity) => [v.vertex.x, v.vertex.y]);
        emit(layer, color, points, m);
        break;
      }
      // Infinite construction lines and defs that are not meant to be drawn.
      case 'XLINE':
      case 'RAY':
      case 'ATTDEF':
      case 'VIEWPORT':
      case 'LIGHT':
      case 'WIPEOUT':
      case 'SEQEND':
      case 'VERTEX':
        break;
      default:
        skipped.set(e.type, (skipped.get(e.type) ?? 0) + 1);
    }
  };

  for (const entity of source.entities) visit(entity, IDENTITY, null, null, 0);
  if (!drawn) throw new Error(msg('This file has nothing that can be drawn'));

  const info: [string, string][] = [
    [msg('Format'), source.format],
    [msg('Entities'), String(drawn)],
  ];
  if (skipped.size) {
    info.push([msg('Not shown'), [...skipped].map(([type, count]) => `${type} ×${count}`).join(', ')]);
  }

  // Layers nothing was drawn on only add noise to the panel.
  const drawing = builder.build(UNIT_NAMES[source.insUnits ?? 0] ?? '', info);
  return compactLayers(drawing);
}

function roughExtent(entities: Entity[]): number {
  let min = Infinity, max = -Infinity;
  for (const e of entities) {
    for (const p of [e.startPoint, e.endPoint, e.center, e.insertionPoint, e.position]) {
      if (p && Number.isFinite(p.x)) {
        min = Math.min(min, p.x);
        max = Math.max(max, p.x);
      }
    }
  }
  return Number.isFinite(min) ? max - min : 0;
}

function compactLayers(drawing: Drawing): Drawing {
  const used = new Set<number>();
  for (const group of drawing.groups) used.add(group.layer);
  for (const label of drawing.labels) used.add(label.layer);
  const remap = new Map<number, number>();
  const layers = drawing.layers.filter((_layer, index) => {
    if (!used.has(index)) return false;
    remap.set(index, remap.size);
    return true;
  });
  for (const group of drawing.groups) group.layer = remap.get(group.layer)!;
  for (const label of drawing.labels) label.layer = remap.get(label.layer)!;
  return { ...drawing, layers };
}

/** Maps a DWG database from libredwg-web to a CadSource. */
export function dwgSource(db: any): CadSource {
  const blocks = new Map<string, CadBlock>();
  for (const record of db.tables.BLOCK_RECORD.entries) {
    blocks.set(record.name, { base: record.basePoint ?? { x: 0, y: 0 }, entities: record.entities ?? [] });
  }
  return {
    entities: db.entities,
    blocks,
    layers: db.tables.LAYER.entries,
    insUnits: db.header?.INSUNITS,
    radians: true,
    closedFlag: 0x200,
    format: 'DWG',
  };
}

/** Maps a DXF database from dxf-json to a CadSource. */
export function dxfSource(db: any): CadSource {
  const blocks = new Map<string, CadBlock>();
  for (const [name, block] of Object.entries<any>(db.blocks ?? {})) {
    blocks.set(name, { base: block.position ?? { x: 0, y: 0 }, entities: block.entities ?? [] });
  }
  return {
    entities: db.entities ?? [],
    blocks,
    layers: db.tables?.LAYER?.entries ?? [],
    insUnits: db.header?.$INSUNITS,
    radians: false,
    closedFlag: 1,
    format: 'DXF',
  };
}

/**
 * dxf-json only ends a block at an "AcDbBlockEnd" marker, which R12 files never write, and without it the
 * parser swallows the rest of the file and reports no entities. Laser and CNC tools often export R12.
 */
export function normalizeDxf(text: string): string {
  return text.replace(/\n[ \t]*0\r?\n[ \t]*ENDBLK\r?\n/g, (match) => `${match}100\nAcDbBlockEnd\n`);
}

/** DXF text is UTF-8 from AutoCAD 2007 on, and in the drawing's code page before that. */
export function decodeDxf(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, Math.min(bytes.length, 8192)));
  const version = /\$ACADVER\s*\r?\n\s*1\s*\r?\n\s*AC(\d+)/.exec(head)?.[1];
  const codePage = /\$DWGCODEPAGE\s*\r?\n\s*3\s*\r?\n\s*ANSI_(\d+)/i.exec(head)?.[1];
  if (version && Number(version) < 1021 && codePage) {
    try {
      return new TextDecoder(`windows-${codePage}`).decode(bytes);
    } catch {}
  }
  return new TextDecoder('utf-8').decode(bytes);
}
