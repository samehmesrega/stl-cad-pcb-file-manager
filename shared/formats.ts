// Everything the app knows about file formats lives here, used by both the server and the client.

export type Category = '3d' | '2d' | 'image' | 'machine' | 'pcb' | 'document' | 'other';
export type ViewerKind = 'model' | 'scad' | 'drawing' | 'toolpath' | 'image' | 'pdf' | 'text' | 'embedded' | 'gerber' | 'kicad' | 'none';

export interface FormatInfo {
  category: Category;
  viewer: ViewerKind;
  /** Slug of the design type picked automatically on upload. */
  autoType: string | null;
}

const table: [Category, ViewerKind, string | null, string][] = [
  ['3d', 'model', 'print3d', 'stl 3mf amf'],
  ['3d', 'model', 'cad', 'step stp iges igs brep brp obj ply glb gltf fbx 3ds wrl dae'],
  ['3d', 'scad', 'cad', 'scad'],
  ['3d', 'none', 'cad', 'sldprt sldasm ipt iam f3d skp 3dm blend max ma mb c4d x_t x_b sat catpart catproduct prt asm dgn'],
  ['2d', 'drawing', 'cad', 'dwg dxf'],
  ['2d', 'drawing', 'laser', 'plt hpgl'],
  ['2d', 'pdf', 'graphic', 'ai'],
  ['2d', 'embedded', 'graphic', 'cdr'],
  ['2d', 'none', 'graphic', 'eps cmx fh'],
  ['2d', 'none', 'laser', 'lbrn lbrn2 ezd dsp'],
  ['image', 'image', 'graphic', 'svg'],
  ['image', 'image', 'photo', 'png jpg jpeg webp gif bmp avif ico tif tiff psd'],
  ['machine', 'drawing', 'laser', 'rd'],
  ['machine', 'toolpath', 'print3d', 'gcode gco g'],
  ['machine', 'toolpath', 'cnc', 'nc ngc tap cnc'],
  ['machine', 'none', 'cnc', 'mpf mpt nci hsm'],
  ['pcb', 'gerber', 'pcb', 'gbr ger gtl gbl gts gbs gto gbo gtp gbp gko gm1 gm2 gm3 gml g1 g2 g3 g4 art pho drl xln exc'],
  ['pcb', 'kicad', 'pcb', 'kicad_pcb kicad_sch'],
  ['pcb', 'none', 'pcb', 'kicad_pro kicad_prl kicad_sym kicad_mod kicad_wks kicad_dru pcbdoc schdoc prjpcb pcblib schlib brd sch epro eprj easyeda pdsprj'],
  ['document', 'pdf', null, 'pdf'],
  ['document', 'text', null, 'txt csv json xml md log'],
  ['document', 'none', null, 'doc docx xls xlsx ppt pptx'],
];

const formats = new Map<string, FormatInfo>();
for (const [category, viewer, autoType, exts] of table) {
  for (const ext of exts.split(' ')) formats.set(ext, { category, viewer, autoType });
}

export function formatOf(ext: string): FormatInfo {
  return formats.get(ext.toLowerCase()) ?? { category: 'other', viewer: 'none', autoType: null };
}

export const CATEGORY_LABELS = {
  '3d': '3D models',
  '2d': '2D drawings',
  image: 'Images',
  machine: 'Machine files',
  pcb: 'PCB boards',
  document: 'Documents',
  other: 'Other',
} as const satisfies Record<Category, string>;

/** A new library starts with the English names. Older libraries hold the Arabic ones, and both show in the chosen language. */
export const DEFAULT_TYPES: { slug: string; name: string; arabic: string }[] = [
  { slug: 'laser', name: 'Laser cutting', arabic: 'قص وحفر ليزر' },
  { slug: 'print3d', name: '3D printing', arabic: 'طباعة 3D' },
  { slug: 'cnc', name: 'CNC', arabic: 'CNC' },
  { slug: 'cad', name: 'CAD', arabic: 'رسم هندسي' },
  { slug: 'graphic', name: 'Graphics', arabic: 'جرافيك' },
  { slug: 'photo', name: 'Photos', arabic: 'صور' },
  { slug: 'pcb', name: 'PCB', arabic: 'PCB' },
];

/** The label on cards: a board has many layer extensions, and all of them mean the same thing to the reader. */
export function displayExt(ext: string): string {
  return formatOf(ext).category === 'pcb' ? 'PCB' : ext.toUpperCase() || 'FILE';
}

export const isGerber = (ext: string) => formatOf(ext).viewer === 'gerber';

export type Grouping = 'separate' | 'one' | 'sub';

export interface FileGroup {
  name: string;
  /** Indexes into the paths given. The primary file comes first. */
  files: { index: number; rel: string }[];
}

const segments = (filePath: string) => filePath.split('/').filter(Boolean);
const baseName = (filePath: string) => segments(filePath).pop() ?? filePath;
const extOfPath = (filePath: string) => extensionOf(baseName(filePath));
const isBoardFile = (filePath: string) => formatOf(extOfPath(filePath)).category === 'pcb';

/** Files KiCad writes on its own. They would bury the real design files and nobody reads them. */
export function isGeneratedJunk(filePath: string): boolean {
  return /-backups\//i.test(filePath) || /(^|\/)(fp-info-cache|_autosave-[^/]*|~[^/]*\.lck)$/i.test(filePath) || /\.kicad_(pcb|sch)-bak$/i.test(filePath);
}

function primaryRank(filePath: string): number {
  const ext = extOfPath(filePath);
  if (ext === 'kicad_pcb') return 0;
  if (ext === 'gtl' || (isGerber(ext) && /f[._]cu/i.test(baseName(filePath)))) return 1;
  if (ext === 'kicad_sch') return 2;
  if (isGerber(ext)) return 3;
  const order: ViewerKind[] = ['model', 'scad', 'drawing', 'toolpath', 'pdf', 'image', 'embedded', 'text'];
  const rank = order.indexOf(formatOf(ext).viewer);
  return rank < 0 ? 20 : 4 + rank;
}

/** The file a many-file design shows first and is known by. */
export function pickPrimary(paths: string[]): number {
  let best = 0;
  for (let i = 1; i < paths.length; i++) {
    const delta = primaryRank(paths[i]) - primaryRank(paths[best]);
    if (delta < 0 || (delta === 0 && paths[i].length < paths[best].length)) best = i;
  }
  return best;
}

/** A chosen folder holding two or more boards becomes two or more designs. Other files stay separate, as they always were. */
export function detectGrouping(paths: string[]): Grouping {
  if (!paths.some(isBoardFile)) return 'separate';
  if (!paths.some((p) => segments(p).length > 1)) return paths.filter(isBoardFile).length > 1 ? 'one' : 'separate';
  const boardsBySub = new Map<string, { kicad: boolean; top: boolean }>();
  for (const filePath of paths) {
    const parts = segments(filePath);
    if (parts.length < 3) continue;
    const key = `${parts[0]}/${parts[1]}`;
    const entry = boardsBySub.get(key) ?? { kicad: false, top: false };
    entry.kicad ||= extOfPath(filePath) === 'kicad_pcb';
    entry.top ||= primaryRank(filePath) === 1;
    boardsBySub.set(key, entry);
  }
  const values = [...boardsBySub.values()];
  const withKicad = values.filter((v) => v.kicad).length;
  // One board keeps its sources and its Gerbers in different subfolders, so those alone must not split it.
  if (withKicad >= 2) return 'sub';
  return withKicad === 0 && values.filter((v) => v.top).length >= 2 ? 'sub' : 'one';
}

export function groupPaths(paths: string[], grouping: Grouping): FileGroup[] {
  const groups = new Map<string, { name: string; depth: number; indexes: number[] }>();
  paths.forEach((filePath, index) => {
    const parts = segments(filePath);
    let key: string;
    let depth: number;
    if (grouping === 'separate') {
      key = `#${index}`;
      depth = parts.length - 1;
    } else if (grouping === 'sub' && parts.length >= 3) {
      depth = 2;
      key = parts.slice(0, 2).join('/');
    } else {
      depth = parts.length > 1 ? 1 : 0;
      key = depth ? parts[0] : '';
    }
    const group = groups.get(key) ?? { name: depth && grouping !== 'separate' ? parts[depth - 1] : '', depth, indexes: [] };
    group.indexes.push(index);
    groups.set(key, group);
  });
  return [...groups.values()].map(({ name, depth, indexes }) => {
    const primary = indexes[pickPrimary(indexes.map((i) => paths[i]))];
    const ordered = [primary, ...indexes.filter((i) => i !== primary)];
    return {
      name: name || stripExtension(baseName(paths[primary])),
      files: ordered.map((index) => ({ index, rel: segments(paths[index]).slice(depth).join('/') })),
    };
  });
}

const ARABIC_DIGITS = '٠١٢٣٤٥٦٧٨٩';

/** Makes search forgiving: case, tashkeel, hamza forms, ta marbuta, Arabic digits and separators. */
export function normalizeSearch(text: string): string {
  return text
    .toLowerCase()
    .replace(/[ً-ْـ]/g, '')
    .replace(/[أإآ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/[٠-٩]/g, (d) => String(ARABIC_DIGITS.indexOf(d)))
    .replace(/[_\-.]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function extensionOf(fileName: string): string {
  const match = /\.([a-z0-9_]{1,12})$/i.exec(fileName);
  return match ? match[1].toLowerCase() : '';
}

export function stripExtension(fileName: string): string {
  return fileName.replace(/\.[a-z0-9_]{1,12}$/i, '');
}
