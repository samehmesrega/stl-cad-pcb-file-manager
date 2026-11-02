import { fetchBuffer } from './parseClient.ts';
import { msg } from '../../shared/i18n.ts';

export interface ScadOutput {
  format: 'stl' | 'dxf';
  buffer: ArrayBuffer;
}

/** Long enough for most models, and short enough not to freeze the queue behind a heavy one. */
export const SCAD_THUMB_TIMEOUT_MS = 60 * 1000;
export const SCAD_VIEW_TIMEOUT_MS = 5 * 60 * 1000;

const DEPENDENCY = /(?:\b(?:use|include)\s*<([^>\r\n]+)>)|(?:\b(?:import|surface)\s*\(\s*(?:file\s*=\s*)?"([^"\r\n]+)")/g;

/** Finds the files a script names. Comments are not removed first: a file that is not found is simply skipped. */
export function scadDependencies(source: string): string[] {
  const found = new Set<string>();
  for (const match of source.matchAll(DEPENDENCY)) found.add((match[1] ?? match[2]).trim().replace(/\\/g, '/'));
  // Fonts come from the bundled set.
  return [...found].filter((name) => !/\.(ttf|otf)$/i.test(name));
}

async function gatherFiles(url: string, mainName: string, designId: number) {
  const files: { path: string; data: ArrayBuffer }[] = [];
  const seen = new Set<string>([mainName.toLowerCase()]);
  const decoder = new TextDecoder();

  const visit = async (buffer: ArrayBuffer, filePath: string) => {
    files.push({ path: filePath, data: buffer });
    if (!/\.scad$/i.test(filePath)) return;
    const folder = filePath.includes('/') ? filePath.slice(0, filePath.lastIndexOf('/') + 1) : '';
    for (const name of scadDependencies(decoder.decode(buffer))) {
      const target = name.startsWith('/') || name.startsWith('..') ? name.replace(/^(\.\.\/|\/)+/, '') : `${folder}${name}`;
      if (seen.has(target.toLowerCase())) continue;
      seen.add(target.toLowerCase());
      const found = await fetch(`/api/scad-lookup?${new URLSearchParams({ name, design: String(designId) })}`);
      if (!found.ok) continue;
      const { url: dependencyUrl } = await found.json();
      await visit(await fetchBuffer(dependencyUrl), target);
    }
  };

  await visit(await fetchBuffer(url), mainName);
  return files;
}

export async function renderScad(url: string, mainName: string, designId: number, timeoutMs: number): Promise<ScadOutput> {
  const files = await gatherFiles(url, mainName, designId);
  return new Promise<ScadOutput>((resolve, reject) => {
    const worker = new Worker(new URL('../workers/scad.worker.ts', import.meta.url), { type: 'module' });
    const finish = (settle: () => void) => {
      clearTimeout(timer);
      worker.terminate();
      settle();
    };
    const timer = setTimeout(() => finish(() => reject(new Error(msg('This model is too heavy and took longer than allowed')))), timeoutMs);
    worker.onmessage = ({ data }) => {
      finish(() => {
        if (data.error !== undefined) reject(new Error(summarizeLog(data.error)));
        else resolve({ format: data.format, buffer: data.buffer });
      });
    };
    worker.onerror = (event) => finish(() => reject(new Error(event.message || msg('Could not start OpenSCAD'))));
    worker.postMessage({ main: mainName, files }, files.map((file) => file.data));
  });
}

/** The few lines of OpenSCAD's output that say what went wrong. */
function summarizeLog(log: string): string {
  if (/top level object is empty/i.test(log) && !/error/i.test(log.replace(/fontconfig error[^\n]*/gi, ''))) {
    return msg('This file has no model of its own. It is probably a library of functions used by other files.');
  }
  const lines = log.split('\n').filter((line) => /error|can't open/i.test(line) && !/fontconfig/i.test(line));
  return lines.slice(0, 3).join('\n') || msg('This file did not produce a model');
}
