import type { BoardRender } from './board.ts';
import type { Drawing } from './drawing.ts';
import type { Toolpath } from './gcode.ts';
import { msg } from '../../shared/i18n.ts';

let worker: Worker | null = null;
let nextId = 1;
const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();

function getWorker(): Worker {
  if (worker) return worker;
  worker = new Worker(new URL('../workers/parse.worker.ts', import.meta.url), { type: 'module' });
  worker.onmessage = (event) => {
    const { id, result, error } = event.data;
    const job = pending.get(id);
    if (!job) return;
    pending.delete(id);
    if (error) job.reject(new Error(error));
    else job.resolve(result);
  };
  worker.onerror = (event) => {
    // A crash loses every job in flight. The next call starts a fresh worker.
    worker?.terminate();
    worker = null;
    for (const job of pending.values()) job.reject(new Error(event.message || msg('Could not read the file')));
    pending.clear();
  };
  return worker;
}

/** Abandons whatever the worker is parsing, for a file that never finishes. The next job starts a fresh worker. */
export function resetParseWorker() {
  worker?.terminate();
  worker = null;
  for (const job of pending.values()) job.reject(new Error(msg('Reading the file took too long')));
  pending.clear();
}

function parse<T>(kind: string, buffer: ArrayBuffer): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    getWorker().postMessage({ id, kind, buffer }, [buffer]);
  });
}

export function parseDrawing(ext: string, buffer: ArrayBuffer): Promise<Drawing> {
  const kind = ext === 'dwg' || ext === 'dxf' || ext === 'rd' ? ext : 'plt';
  return parse<Drawing>(kind, buffer);
}

export function parseToolpath(buffer: ArrayBuffer): Promise<Toolpath> {
  return parse<Toolpath>('gcode', buffer);
}

export async function renderBoard(sources: { name: string; url: string }[]): Promise<BoardRender> {
  const files = await Promise.all(sources.map(async ({ name, url }) => ({ name, buffer: await fetchBuffer(url) })));
  return new Promise<BoardRender>((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    getWorker().postMessage({ id, kind: 'board', files }, files.map((file) => file.buffer));
  });
}

export async function fetchBuffer(url: string): Promise<ArrayBuffer> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(msg('Could not load the file from the library'));
  return response.arrayBuffer();
}
