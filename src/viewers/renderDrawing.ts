import type { Bounds, Drawing } from '../loaders/drawing.ts';

export interface View {
  scale: number;
  /** Screen position, in CSS pixels, of the drawing's centre. */
  x: number;
  y: number;
}

export interface PreparedDrawing {
  drawing: Drawing;
  centerX: number;
  centerY: number;
  paths: { path: Path2D; layer: number; color: string; fill: boolean }[];
}

/** Black is a common layer colour in laser and CAD files, and it would vanish on the dark stage. */
function readable(color: string): string {
  const value = parseInt(color.slice(1), 16);
  const luminance = 0.2126 * ((value >> 16) & 255) + 0.7152 * ((value >> 8) & 255) + 0.0722 * (value & 255);
  return luminance < 48 ? '#f1efe7' : color;
}

/** Paths are stored relative to the drawing's centre: canvas uses 32-bit floats, so large coordinates would jitter. */
export function prepareDrawing(drawing: Drawing): PreparedDrawing {
  const centerX = (drawing.bounds.minX + drawing.bounds.maxX) / 2;
  const centerY = (drawing.bounds.minY + drawing.bounds.maxY) / 2;
  const paths = drawing.groups.map((group) => {
    const path = new Path2D();
    const { pts, starts } = group;
    const count = pts.length / 2;
    let next = 1;
    for (let i = 0; i < count; i++) {
      const x = pts[i * 2] - centerX;
      const y = pts[i * 2 + 1] - centerY;
      if (i === starts[next - 1]) {
        path.moveTo(x, y);
        next++;
      } else {
        path.lineTo(x, y);
      }
    }
    return { path, layer: group.layer, color: readable(group.color), fill: group.fill };
  });
  return { drawing, centerX, centerY, paths };
}

export function fitView(bounds: Bounds, width: number, height: number, margin = 32): View {
  const w = Math.max(bounds.maxX - bounds.minX, 1e-9);
  const h = Math.max(bounds.maxY - bounds.minY, 1e-9);
  const scale = Math.min((width - margin * 2) / w, (height - margin * 2) / h);
  return { scale: scale > 0 ? scale : 1, x: width / 2, y: height / 2 };
}

export function renderDrawing(
  ctx: CanvasRenderingContext2D,
  prepared: PreparedDrawing,
  view: View,
  hiddenLayers: Set<number>,
  dpr: number,
  lineWidth = 1,
) {
  const { scale, x, y } = view;
  ctx.setTransform(dpr * scale, 0, 0, -dpr * scale, dpr * x, dpr * y);
  ctx.lineWidth = lineWidth / scale;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';

  ctx.globalAlpha = 0.35;
  for (const item of prepared.paths) {
    if (!item.fill || hiddenLayers.has(item.layer)) continue;
    ctx.fillStyle = item.color;
    ctx.fill(item.path);
  }
  ctx.globalAlpha = 1;
  for (const item of prepared.paths) {
    if (hiddenLayers.has(item.layer)) continue;
    ctx.strokeStyle = item.color;
    ctx.stroke(item.path);
  }

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  for (const label of prepared.drawing.labels) {
    const pixels = label.height * scale;
    if (pixels < 3 || hiddenLayers.has(label.layer)) continue;
    ctx.save();
    ctx.translate(x + (label.x - prepared.centerX) * scale, y - (label.y - prepared.centerY) * scale);
    ctx.rotate(-label.rotation);
    ctx.font = `${pixels}px "IBM Plex Sans Arabic", sans-serif`;
    ctx.textAlign = label.align;
    ctx.textBaseline = label.baseline;
    ctx.direction = 'ltr';
    ctx.fillStyle = readable(label.color);
    ctx.fillText(label.text, 0, 0);
    ctx.restore();
  }
}
