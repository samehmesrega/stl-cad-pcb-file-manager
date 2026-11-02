// Turns whatever the user dropped or picked into a flat list of files, each with the path it had.
import { extensionOf, formatOf, isGeneratedJunk } from '../shared/formats.ts';

export interface UploadSource {
  file: File;
  /** Forward slashes, starting with the chosen folder. Just the file name for a loose file. */
  path: string;
}

const JUNK_FILES = /^(thumbs\.db|desktop\.ini|\.ds_store)$/i;

export function sourcesFromFiles(files: Iterable<File>): UploadSource[] {
  return [...files].map((file) => ({ file, path: file.webkitRelativePath || file.name }));
}

function readAllEntries(reader: any): Promise<any[]> {
  return new Promise((resolve, reject) => {
    const all: any[] = [];
    // Each call returns a batch at most, and an empty one means the end.
    const next = () => reader.readEntries((batch: any[]) => {
      if (!batch.length) return resolve(all);
      all.push(...batch);
      next();
    }, reject);
    next();
  });
}

async function walkEntry(entry: any, prefix: string, out: UploadSource[]) {
  const here = prefix ? `${prefix}/${entry.name}` : entry.name;
  if (entry.isFile) {
    const file = await new Promise<File>((resolve, reject) => entry.file(resolve, reject));
    out.push({ file, path: here });
  } else if (entry.isDirectory) {
    for (const child of await readAllEntries(entry.createReader())) await walkEntry(child, here, out);
  }
}

/** Dropped folders only show up as folders through the entries API. The list has to be taken before any await. */
export async function sourcesFromDrop(transfer: DataTransfer): Promise<UploadSource[]> {
  const entries = [...transfer.items].map((item) => item.webkitGetAsEntry?.()).filter(Boolean);
  if (!entries.length) return sourcesFromFiles(transfer.files);
  const out: UploadSource[] = [];
  for (const entry of entries) await walkEntry(entry, '', out);
  return out;
}

/** A ZIP of Gerbers is how boards usually travel, so it opens up into its files. Any other ZIP stays one file. */
async function expandBoardZip(source: UploadSource): Promise<UploadSource[]> {
  const { default: JSZip } = await import('jszip');
  let zip: Awaited<ReturnType<typeof JSZip.loadAsync>>;
  try {
    zip = await JSZip.loadAsync(source.file);
  } catch {
    return [source];
  }
  const entries = Object.values(zip.files).filter((entry) => !entry.dir && !entry.name.startsWith('__MACOSX/'));
  if (!entries.some((entry) => formatOf(extensionOf(entry.name)).category === 'pcb')) return [source];
  const folder = source.file.name.replace(/\.zip$/i, '');
  return Promise.all(entries.map(async (entry) => {
    const name = entry.name.split('/').pop() as string;
    const file = new File([await entry.async('blob')], name, { lastModified: source.file.lastModified });
    return { file, path: `${folder}/${entry.name}` };
  }));
}

export interface PreparedSources {
  sources: UploadSource[];
  /** How many files were left out because KiCad generates them. */
  skipped: number;
}

export async function prepareSources(raw: UploadSource[]): Promise<PreparedSources> {
  const sources: UploadSource[] = [];
  let skipped = 0;
  for (const source of raw) {
    if (JUNK_FILES.test(source.file.name)) continue;
    if (isGeneratedJunk(source.path)) {
      skipped++;
      continue;
    }
    // Only a ZIP picked on its own. One inside a board's folder is that board's own package for the factory.
    if (!source.path.includes('/') && /\.zip$/i.test(source.file.name)) sources.push(...await expandBoardZip(source));
    else sources.push(source);
  }
  return { sources, skipped };
}
