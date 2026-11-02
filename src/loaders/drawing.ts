// The neutral 2D model every vector format (DWG, DXF, RD, PLT) is converted to before rendering.

export interface DrawingLayer {
  name: string;
  color: string;
  hidden?: boolean;
  /** Extra text next to the layer, such as laser speed and power. */
  detail?: string;
}

export interface StrokeGroup {
  layer: number;
  color: string;
  fill: boolean;
  /** Flat x,y pairs of all strokes in this group. */
  pts: Float64Array;
  /** Point index (not array index) where each stroke starts. */
  starts: Uint32Array;
}

export interface DrawingLabel {
  layer: number;
  color: string;
  text: string;
  x: number;
  y: number;
  height: number;
  rotation: number;
  align: 'left' | 'center' | 'right';
  baseline: 'alphabetic' | 'middle' | 'top';
}

export interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface Drawing {
  layers: DrawingLayer[];
  groups: StrokeGroup[];
  labels: DrawingLabel[];
  bounds: Bounds;
  unit: string;
  info: [string, string][];
}

export class DrawingBuilder {
  layers: DrawingLayer[] = [];
  labels: DrawingLabel[] = [];
  private groups = new Map<string, { layer: number; color: string; fill: boolean; pts: number[]; starts: number[] }>();
  private bounds: Bounds = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };

  addLayer(layer: DrawingLayer): number {
    this.layers.push(layer);
    return this.layers.length - 1;
  }

  private extend(x: number, y: number) {
    if (x < this.bounds.minX) this.bounds.minX = x;
    if (x > this.bounds.maxX) this.bounds.maxX = x;
    if (y < this.bounds.minY) this.bounds.minY = y;
    if (y > this.bounds.maxY) this.bounds.maxY = y;
  }

  /** Adds one continuous stroke. `points` is a flat x,y list. */
  addStroke(layer: number, color: string, points: number[], fill = false) {
    if (points.length < 4) return;
    for (let i = 0; i < points.length; i++) if (!Number.isFinite(points[i])) return;
    const key = `${layer}|${color}|${fill}`;
    let group = this.groups.get(key);
    if (!group) {
      group = { layer, color, fill, pts: [], starts: [] };
      this.groups.set(key, group);
    }
    group.starts.push(group.pts.length / 2);
    for (let i = 0; i < points.length; i += 2) {
      group.pts.push(points[i], points[i + 1]);
      this.extend(points[i], points[i + 1]);
    }
  }

  addLabel(label: DrawingLabel) {
    if (!label.text || !Number.isFinite(label.x) || !Number.isFinite(label.y) || !(label.height > 0)) return;
    this.labels.push(label);
    this.extend(label.x, label.y);
  }

  build(unit: string, info: [string, string][]): Drawing {
    const groups: StrokeGroup[] = [...this.groups.values()].map((g) => ({
      layer: g.layer,
      color: g.color,
      fill: g.fill,
      pts: Float64Array.from(g.pts),
      starts: Uint32Array.from(g.starts),
    }));
    const empty = !Number.isFinite(this.bounds.minX);
    return {
      layers: this.layers,
      groups,
      labels: this.labels,
      bounds: empty ? { minX: 0, minY: 0, maxX: 1, maxY: 1 } : this.bounds,
      unit,
      info,
    };
  }
}
