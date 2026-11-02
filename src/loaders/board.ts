// Turns a board's Gerber and drill files into pictures: the finished board from both sides, plus each layer alone.
import { plot, read, renderBoard, renderLayers, stringifySvg } from '@tracespace/core';
import { msg } from '../../shared/i18n.ts';

export interface BoardLayer {
  name: string;
  type: string;
  side: string | null;
  color: string;
  svg: string;
  /** Layers that hide the rest when all are drawn start switched off. */
  visible: boolean;
}

export interface BoardRender {
  top: string;
  bottom: string;
  layers: BoardLayer[];
  width: number;
  height: number;
  units: string;
  /** False without a usable outline, when the finished-board view has no real shape to show. */
  hasShape: boolean;
  skipped: string[];
}

const LONGEST_SIDE_PX = 1600;
const MM_PER_INCH = 25.4;

const COLORS: Record<string, string> = {
  'copper:top': '#e0604c',
  'copper:bottom': '#4c8fe0',
  'copper:inner': '#d9a441',
  'soldermask:top': '#8f5fd0',
  'soldermask:bottom': '#4fb6a8',
  'silkscreen:top': '#f2f2ea',
  'silkscreen:bottom': '#d8d27a',
  'solderpaste:top': '#9a9a9a',
  'solderpaste:bottom': '#7a7a7a',
  'drill:all': '#ffffff',
  'outline:all': '#6fd06f',
};

// Listed from the bottom of the stack to the top.
const STACK_ORDER = ['drawing', 'solderpaste', 'soldermask', 'copper', 'silkscreen', 'drill', 'outline'];
const SIDE_ORDER = ['bottom', 'inner', 'top', 'all'];

function layerRank(layer: { type: string | null; side: string | null }) {
  return STACK_ORDER.indexOf(layer.type ?? 'drawing') * 10 + SIDE_ORDER.indexOf(layer.side ?? 'all');
}

function scalePosition(position: number[], factor: number) {
  // The third value of an arc position is an angle.
  return position.map((value, index) => (index < 2 ? value * factor : value));
}

function scaleSegments(segments: any[], factor: number) {
  for (const segment of segments) {
    segment.start = scalePosition(segment.start, factor);
    segment.end = scalePosition(segment.end, factor);
    if (segment.center) segment.center = scalePosition(segment.center, factor);
    if (segment.radius !== undefined) segment.radius *= factor;
  }
}

function scaleShape(shape: any, factor: number) {
  switch (shape.type) {
    case 'circle':
      shape.cx *= factor;
      shape.cy *= factor;
      shape.r *= factor;
      break;
    case 'rectangle':
      shape.x *= factor;
      shape.y *= factor;
      shape.xSize *= factor;
      shape.ySize *= factor;
      if (shape.r !== undefined) shape.r *= factor;
      break;
    case 'polygon':
      shape.points = shape.points.map((point: number[]) => scalePosition(point, factor));
      break;
    case 'outline':
      scaleSegments(shape.segments, factor);
      break;
    case 'layeredShape':
      for (const inner of shape.shapes) scaleShape(inner, factor);
      break;
  }
}

/**
 * KiCad writes Gerbers in millimetres and drill files in inches by default, and the plotter keeps each file in its
 * own units. Left alone, every hole lands far away from the board.
 */
function convertTree(tree: any, units: string) {
  if (tree.units === units) return;
  const factor = units === 'mm' ? MM_PER_INCH : 1 / MM_PER_INCH;
  for (const node of tree.children) {
    if (node.type === 'imageShape') scaleShape(node.shape, factor);
    else {
      if (node.width !== undefined) node.width *= factor;
      scaleSegments(node.segments, factor);
    }
  }
  tree.units = units;
}

/** Walks the drawing itself: the plotter's own size comes out as NaN for the aperture macros KiCad writes. */
function measuredSize(trees: any[]): number[] {
  const box = [Infinity, Infinity, -Infinity, -Infinity];
  const include = (x: number, y: number, margin = 0) => {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    box[0] = Math.min(box[0], x - margin);
    box[1] = Math.min(box[1], y - margin);
    box[2] = Math.max(box[2], x + margin);
    box[3] = Math.max(box[3], y + margin);
  };
  const includeSegments = (segments: any[], margin = 0) => {
    for (const segment of segments) {
      include(segment.start[0], segment.start[1], margin);
      include(segment.end[0], segment.end[1], margin);
      // An arc can bulge past both ends, and its full circle is a safe limit for a picture's frame.
      if (segment.center) include(segment.center[0], segment.center[1], segment.radius + margin);
    }
  };
  const includeShape = (shape: any) => {
    if (shape.type === 'circle') include(shape.cx, shape.cy, shape.r);
    else if (shape.type === 'rectangle') {
      include(shape.x, shape.y);
      include(shape.x + shape.xSize, shape.y + shape.ySize);
    } else if (shape.type === 'polygon') for (const point of shape.points) include(point[0], point[1]);
    else if (shape.type === 'outline') includeSegments(shape.segments);
    else if (shape.type === 'layeredShape') for (const inner of shape.shapes) includeShape(inner);
  };
  for (const tree of trees) {
    for (const node of tree.children) {
      if (node.type === 'imageShape') includeShape(node.shape);
      else includeSegments(node.segments, (node.width ?? 0) / 2);
    }
  }
  return box;
}

export async function renderBoardFiles(files: File[]): Promise<BoardRender> {
  // One unreadable file must not lose the whole board, and read() stops at the first bad one.
  const readable: File[] = [];
  const skipped: string[] = [];
  for (const file of files) {
    try {
      await read([file]);
      readable.push(file);
    } catch {
      skipped.push(file.name);
    }
  }
  if (!readable.length) throw new Error(msg('These are not valid Gerber files'));

  const readResult = await read(readable);
  const plotResult = plot(readResult);
  const trees = plotResult.plotTreesById as Record<string, any>;
  const outline = readResult.layers.find((layer) => layer.type === 'outline');
  const units: string = trees[(outline ?? readResult.layers[0]).id].units;
  for (const tree of Object.values(trees)) convertTree(tree, units);

  const hasShape = plotResult.boardShape.regions.length > 0;
  if (!hasShape) (plotResult.boardShape as any).size = measuredSize(Object.values(trees));

  const layersResult = renderLayers(plotResult);
  const board = renderBoard(layersResult);
  const [, , width, height] = layersResult.boardShapeRender.viewBox;
  if (!(width > 0 && height > 0)) throw new Error(msg('These files have nothing to display'));

  const scale = LONGEST_SIDE_PX / Math.max(width, height);
  const sized = (svg: any, color?: string) => {
    svg.properties.width = Math.round(width * scale);
    svg.properties.height = Math.round(height * scale);
    if (color) svg.properties.color = color;
    return stringifySvg(svg);
  };

  const layers: BoardLayer[] = [...readResult.layers]
    .sort((a, b) => layerRank(a) - layerRank(b))
    .map((layer) => {
      const type = layer.type ?? 'drawing';
      const side = layer.side ?? null;
      const color = COLORS[`${type}:${side}`] ?? '#c7b8a0';
      return {
        name: layer.filename,
        type,
        side,
        color,
        svg: sized(layersResult.rendersById[layer.id], color),
        visible: ['copper', 'silkscreen', 'drill', 'outline'].includes(type),
      };
    });

  return { top: sized(board.top), bottom: sized(board.bottom), layers, width, height, units, hasShape, skipped };
}
