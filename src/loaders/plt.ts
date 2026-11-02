// HPGL / PLT plotter files: pen up/down moves in units of 1/40 mm.
import { DrawingBuilder } from './drawing.ts';
import type { Drawing } from './drawing.ts';
import { msg } from '../../shared/i18n.ts';

const UNITS_PER_MM = 40;
const PENS = ['#f1efe7', '#ff5a1f', '#3fb6ff', '#55d17e', '#ffd43b', '#f06595', '#b197fc', '#ced4da'];

export function parsePlt(buffer: ArrayBuffer): Drawing {
  const text = new TextDecoder('latin1').decode(buffer);
  const builder = new DrawingBuilder();
  const layers = new Map<number, number>();
  const layerFor = (pen: number) => {
    let index = layers.get(pen);
    if (index === undefined) {
      index = builder.addLayer({ name: `Pen ${pen}`, color: PENS[pen % PENS.length] });
      layers.set(pen, index);
    }
    return index;
  };

  let pen = 1;
  let down = false;
  let relative = false;
  let x = 0;
  let y = 0;
  let stroke: number[] = [];

  const flush = () => {
    if (stroke.length >= 4) {
      const layer = layerFor(pen);
      builder.addStroke(layer, builder.layers[layer].color, stroke.map((v) => v / UNITS_PER_MM));
    }
    stroke = [];
  };
  const plot = (nx: number, ny: number) => {
    if (down) {
      if (!stroke.length) stroke.push(x, y);
      stroke.push(nx, ny);
    }
    x = nx;
    y = ny;
  };

  const pattern = /([A-Z]{2})([^A-Z;]*)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text))) {
    const [, op, args] = match;
    const values = args.split(/[\s,]+/).filter(Boolean).map(Number).filter(Number.isFinite);
    if (op === 'SP') {
      flush();
      pen = values[0] ?? 1;
    } else if (op === 'PU' || op === 'PD' || op === 'PA' || op === 'PR') {
      if (op === 'PU') {
        flush();
        down = false;
      } else if (op === 'PD') {
        down = true;
      } else {
        relative = op === 'PR';
      }
      for (let i = 0; i + 1 < values.length; i += 2) {
        plot(relative ? x + values[i] : values[i], relative ? y + values[i + 1] : values[i + 1]);
      }
    } else if (op === 'CI' && values[0] > 0) {
      flush();
      const circle: number[] = [];
      for (let a = 0; a <= 72; a++) {
        const t = (a / 72) * Math.PI * 2;
        circle.push((x + values[0] * Math.cos(t)) / UNITS_PER_MM, (y + values[0] * Math.sin(t)) / UNITS_PER_MM);
      }
      const layer = layerFor(pen);
      builder.addStroke(layer, builder.layers[layer].color, circle);
    }
  }
  flush();
  if (!builder.layers.length) throw new Error(msg('PLT: no drawing was found in this file'));
  return builder.build('mm', []);
}
