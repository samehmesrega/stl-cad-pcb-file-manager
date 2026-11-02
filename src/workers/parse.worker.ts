// CAD and machine files can take seconds to parse, so they never run on the UI thread.
import { buildDrawing, decodeDxf, dwgSource, dxfSource, normalizeDxf } from '../loaders/cad.ts';
import type { Drawing } from '../loaders/drawing.ts';
import { parseGcode } from '../loaders/gcode.ts';
import { parsePlt } from '../loaders/plt.ts';
import { parseRd } from '../loaders/rd.ts';
import { msg } from '../../shared/i18n.ts';

let libredwg: Promise<any> | null = null;

async function parseDwg(buffer: ArrayBuffer): Promise<Drawing> {
  const { LibreDwg, Dwg_File_Type } = await import('@mlightcad/libredwg-web');
  libredwg ??= LibreDwg.create('/vendor/libredwg/');
  const lib = await libredwg;
  const data = lib.dwg_read_data(buffer, Dwg_File_Type.DWG);
  if (!data) throw new Error(msg('Could not read the DWG file'));
  try {
    return buildDrawing(dwgSource(lib.convert(data)));
  } finally {
    lib.dwg_free(data);
  }
}

async function parseDxf(buffer: ArrayBuffer): Promise<Drawing> {
  const { DxfParser } = await import('@mlightcad/dxf-json');
  return buildDrawing(dxfSource(new DxfParser().parseSync(normalizeDxf(decodeDxf(buffer)))));
}

function drawingTransfer(drawing: Drawing): Transferable[] {
  return drawing.groups.flatMap((group) => [group.pts.buffer, group.starts.buffer] as ArrayBuffer[]);
}

self.onmessage = async (event: MessageEvent<{ id: number; kind: string; buffer: ArrayBuffer; files?: { name: string; buffer: ArrayBuffer }[] }>) => {
  const { id, kind, buffer, files } = event.data;
  try {
    if (kind === 'board') {
      const { renderBoardFiles } = await import('../loaders/board.ts');
      self.postMessage({ id, result: await renderBoardFiles(files!.map((file) => new File([file.buffer], file.name))) });
      return;
    }
    if (kind === 'gcode') {
      const result = parseGcode(buffer);
      (self as any).postMessage({ id, result }, [result.feed.buffer, result.travel.buffer]);
      return;
    }
    const result =
      kind === 'dwg' ? await parseDwg(buffer)
      : kind === 'dxf' ? await parseDxf(buffer)
      : kind === 'rd' ? parseRd(buffer)
      : parsePlt(buffer);
    (self as any).postMessage({ id, result }, drawingTransfer(result));
  } catch (error) {
    self.postMessage({ id, error: (error as Error)?.message ?? String(error) });
  }
};
