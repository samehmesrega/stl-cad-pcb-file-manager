// Thumbnails are rendered in the browser with the same code as the viewers, then stored on the server.
import { formatOf, isGerber } from '../shared/formats.ts';
import { api, fileUrl } from './api.ts';
import type { Design, DesignFile } from './types.ts';

const WIDTH = 520;
const HEIGHT = 390;
const STAGE = '#15191c';
const PAPER = '#f3f4f6';
/** Bigger files are viewable on demand, but not parsed in the background. */
const MAX_AUTO_BYTES = 250 * 1024 * 1024;
const MAX_3MF_RENDER_BYTES = 20 * 1024 * 1024;
const THUMB_TIMEOUT_MS = 3 * 60 * 1000;

export const canHaveThumb = (design: Design) => {
  // A many-file design can borrow its picture from any of its files.
  if (design.extra_files > 0) return true;
  const viewer = formatOf(design.ext).viewer;
  return viewer !== 'none' && viewer !== 'text' && viewer !== 'kicad';
};

function makeCanvas(background: string) {
  const canvas = document.createElement('canvas');
  canvas.width = WIDTH;
  canvas.height = HEIGHT;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = background;
  ctx.fillRect(0, 0, WIDTH, HEIGHT);
  return { canvas, ctx };
}

function toWebp(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('toBlob failed'))), 'image/webp', 0.82);
  });
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('image failed'));
    image.src = src;
  });
}

function drawContained(ctx: CanvasRenderingContext2D, source: CanvasImageSource, width: number, height: number) {
  const scale = Math.min(WIDTH / width, HEIGHT / height);
  ctx.drawImage(source, (WIDTH - width * scale) / 2, (HEIGHT - height * scale) / 2, width * scale, height * scale);
}

async function imageThumb(url: string, ext: string): Promise<Blob> {
  const { resolveImage } = await import('./loaders/raster.ts');
  const { src, revoke } = await resolveImage(url, ext);
  try {
    const image = await loadImage(src);
    const { canvas, ctx } = makeCanvas(PAPER);
    drawContained(ctx, image, image.naturalWidth || WIDTH, image.naturalHeight || HEIGHT);
    return await toWebp(canvas);
  } finally {
    if (revoke) URL.revokeObjectURL(src);
  }
}

async function pdfThumb(url: string): Promise<Blob> {
  const { fetchBuffer } = await import('./loaders/parseClient.ts');
  const { closePdf, openPdf, renderPage } = await import('./loaders/pdf.ts');
  const pdf = await openPdf(await fetchBuffer(url));
  try {
    const page = await pdf.getPage(1);
    const base = page.getViewport({ scale: 1 });
    const pageCanvas = document.createElement('canvas');
    await renderPage(pdf, 1, pageCanvas, Math.min(WIDTH / base.width, HEIGHT / base.height) * 1.5);
    const { canvas, ctx } = makeCanvas(STAGE);
    drawContained(ctx, pageCanvas, pageCanvas.width, pageCanvas.height);
    return await toWebp(canvas);
  } finally {
    await closePdf(pdf);
  }
}

async function drawingThumb(url: string, ext: string): Promise<Blob> {
  const { fetchBuffer, parseDrawing } = await import('./loaders/parseClient.ts');
  const { fitView, prepareDrawing, renderDrawing } = await import('./viewers/renderDrawing.ts');
  const drawing = await parseDrawing(ext, await fetchBuffer(url));
  const { canvas, ctx } = makeCanvas(STAGE);
  const hidden = new Set(drawing.layers.flatMap((layer, index) => (layer.hidden ? [index] : [])));
  renderDrawing(ctx, prepareDrawing(drawing), fitView(drawing.bounds, WIDTH, HEIGHT, 24), hidden, 1, 1.25);
  return toWebp(canvas);
}

/** Uses the picture stored in the file. Without one, only small files get rendered: 3MF parsing blocks the page. */
async function embedded3mfThumb(url: string, size: number): Promise<Blob | null> {
  const { extract3mfPreview } = await import('./loaders/raster.ts');
  const { fetchBuffer } = await import('./loaders/parseClient.ts');
  const preview = await extract3mfPreview(await fetchBuffer(url)).catch(() => null);
  if (!preview) {
    if (size > MAX_3MF_RENDER_BYTES) throw new Error('3MF too large to render in the background');
    return null;
  }
  const src = URL.createObjectURL(preview);
  try {
    const image = await loadImage(src);
    const { canvas, ctx } = makeCanvas(STAGE);
    drawContained(ctx, image, image.naturalWidth || WIDTH, image.naturalHeight || HEIGHT);
    return await toWebp(canvas);
  } finally {
    URL.revokeObjectURL(src);
  }
}

async function boardThumb(gerbers: DesignFile[]): Promise<Blob> {
  const { renderBoard } = await import('./loaders/parseClient.ts');
  const board = await renderBoard(gerbers.map((file) => ({ name: file.name, url: file.url })));
  const svg = board.hasShape && board.layers.some((layer) => layer.type === 'copper')
    ? board.top
    : board.layers.find((layer) => layer.visible)?.svg ?? board.layers[0].svg;
  const src = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
  try {
    const image = await loadImage(src);
    const { canvas, ctx } = makeCanvas(STAGE);
    drawContained(ctx, image, image.naturalWidth || WIDTH, image.naturalHeight || HEIGHT);
    return await toWebp(canvas);
  } finally {
    URL.revokeObjectURL(src);
  }
}

async function scadThumb(url: string, name: string, designId: number): Promise<Blob> {
  const { SCAD_THUMB_TIMEOUT_MS, renderScad } = await import('./loaders/scadClient.ts');
  const result = await renderScad(url, name, designId, SCAD_THUMB_TIMEOUT_MS);
  const blobUrl = URL.createObjectURL(new Blob([result.buffer]));
  try {
    if (result.format === 'dxf') return await drawingThumb(blobUrl, 'dxf');
    const { snapshotModel } = await import('./viewers/snapshot3d.ts');
    return await snapshotModel(blobUrl, 'stl', WIDTH, HEIGHT, toWebp);
  } finally {
    URL.revokeObjectURL(blobUrl);
  }
}

/** For a design of many files: the board if it has Gerbers, else a picture or a model that came with it. */
async function packageThumb(design: Design): Promise<Blob> {
  const { files = [] } = await api.design(design.id);
  const gerbers = files.filter((file) => isGerber(file.ext));
  if (gerbers.length) return boardThumb(gerbers);
  const { viewer } = formatOf(design.ext);
  if (viewer !== 'none' && viewer !== 'kicad' && viewer !== 'text') return generateFor(design.ext, fileUrl(design.id), design);
  const fallback = files.find((file) => formatOf(file.ext).viewer === 'image') ?? files.find((file) => formatOf(file.ext).viewer === 'model');
  if (!fallback) throw new Error('nothing to preview');
  return generateFor(fallback.ext, fallback.url, design);
}

function generate(design: Design): Promise<Blob> {
  return design.extra_files > 0 ? packageThumb(design) : generateFor(design.ext, fileUrl(design.id), design);
}

async function generateFor(ext: string, url: string, design: Design): Promise<Blob> {
  const { viewer } = formatOf(ext);
  if (viewer === 'scad') return scadThumb(url, design.original_name, design.id);
  if (viewer === 'gerber') return boardThumb([{ id: null, rel_path: design.original_name, name: design.original_name, ext, size: design.size, url }]);
  if (ext === '3mf') {
    const thumb = await embedded3mfThumb(url, design.size);
    if (thumb) return thumb;
  }
  if (viewer === 'image' || viewer === 'embedded') return imageThumb(url, ext);
  if (viewer === 'pdf') return pdfThumb(url);
  if (viewer === 'drawing') return drawingThumb(url, ext);
  const { snapshotModel, snapshotToolpath } = await import('./viewers/snapshot3d.ts');
  if (viewer === 'toolpath') return snapshotToolpath(url, WIDTH, HEIGHT, toWebp);
  return snapshotModel(url, ext, WIDTH, HEIGHT, toWebp);
}

/** One file that never finishes parsing must not hold up the thumbnails queued behind it. */
async function withTimeout(work: Promise<Blob>): Promise<Blob> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(async () => {
      const { resetParseWorker } = await import('./loaders/parseClient.ts');
      resetParseWorker();
      reject(new Error('thumbnail timed out'));
    }, THUMB_TIMEOUT_MS);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

interface ThumbQueue {
  jobs: { design: Design; onDone: (design: Design) => void }[];
  running: boolean;
}

// An OpenSCAD model can take a minute, and everything else should not have to wait behind it.
const mainQueue: ThumbQueue = { jobs: [], running: false };
const scadQueue: ThumbQueue = { jobs: [], running: false };
const requested = new Set<number>();

async function drain(queue: ThumbQueue) {
  if (queue.running) return;
  queue.running = true;
  while (queue.jobs.length) {
    const { design, onDone } = queue.jobs.shift()!;
    try {
      onDone(await api.putThumb(design.id, await withTimeout(generate(design))));
    } catch (error) {
      console.warn(`Thumbnail failed for ${design.original_name}:`, error);
      await api.thumbFailed(design.id).catch(() => {});
      onDone({ ...design, thumb_state: 'failed' });
    }
  }
  queue.running = false;
}

/** Queues a thumbnail for a design shown in the grid. Runs one at a time to keep the UI responsive. */
export function requestThumb(design: Design, onDone: (design: Design) => void) {
  if (requested.has(design.id)) return;
  requested.add(design.id);
  if (design.size > MAX_AUTO_BYTES) {
    api.thumbFailed(design.id).catch(() => {});
    onDone({ ...design, thumb_state: 'failed' });
    return;
  }
  const queue = formatOf(design.ext).viewer === 'scad' ? scadQueue : mainQueue;
  queue.jobs.push({ design, onDone });
  void drain(queue);
}

/** Runs the automatic thumbnail again for one design, on the user's request. */
export async function regenerateThumb(design: Design): Promise<Design> {
  return api.putThumb(design.id, await generate(design));
}

/** Turns an image the user picked into a stored preview, for formats the app cannot render. */
export async function uploadCustomThumb(design: Design, file: File): Promise<Design> {
  const src = URL.createObjectURL(file);
  try {
    const image = await loadImage(src);
    const { canvas, ctx } = makeCanvas(PAPER);
    drawContained(ctx, image, image.naturalWidth || WIDTH, image.naturalHeight || HEIGHT);
    return await api.putThumb(design.id, await toWebp(canvas));
  } finally {
    URL.revokeObjectURL(src);
  }
}
