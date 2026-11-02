// Each render gets its own worker: OpenSCAD blocks until it finishes, and terminating is the only way to stop it.
import { createOpenSCAD } from 'openscad-wasm-prebuilt';

const FONTS = ['LiberationSans-Regular.ttf', 'LiberationSans-Bold.ttf', 'LiberationSans-Italic.ttf', 'LiberationSans-BoldItalic.ttf'];
const FONT_CONFIG = '<?xml version="1.0"?><!DOCTYPE fontconfig SYSTEM "fonts.dtd"><fontconfig><dir>/fonts</dir><cachedir>/tmp</cachedir></fontconfig>';

interface Job {
  main: string;
  files: { path: string; data: ArrayBuffer }[];
}

function writeWithFolders(fs: any, filePath: string, data: Uint8Array | string) {
  const parts = filePath.split('/').filter(Boolean);
  let dir = '';
  for (const part of parts.slice(0, -1)) {
    dir += `/${part}`;
    try {
      fs.mkdir(dir);
    } catch {}
  }
  fs.writeFile(`/${parts.join('/')}`, data);
}

async function run({ main, files }: Job, fonts: { name: string; data: Uint8Array }[], args: string[], output: string) {
  const log: string[] = [];
  const keep = (line: string) => log.push(line);
  const instance = (await createOpenSCAD({ noInitialRun: true, print: keep, printErr: keep })).getInstance() as any;
  for (const font of fonts) writeWithFolders(instance.FS, `/fonts/${font.name}`, font.data);
  writeWithFolders(instance.FS, '/fonts/fonts.conf', FONT_CONFIG);
  for (const file of files) writeWithFolders(instance.FS, file.path, new Uint8Array(file.data));
  let code: unknown;
  try {
    code = instance.callMain([`/${main}`, ...args, '-o', `/${output}`]);
  } catch (error) {
    code = (error as Error)?.message ?? error;
  }
  let bytes: Uint8Array | null = null;
  try {
    bytes = instance.FS.readFile(`/${output}`) as Uint8Array;
  } catch {}
  return { ok: code === 0 && Boolean(bytes?.length), bytes, log };
}

self.onmessage = async (event: MessageEvent<Job>) => {
  try {
    const fonts = await Promise.all(
      FONTS.map(async (name) => ({ name, data: new Uint8Array(await (await fetch(`/vendor/fonts/${name}`)).arrayBuffer()) })),
    );
    // The default CGAL backend takes minutes on a typical name block, and Manifold takes under a second.
    const solid = await run(event.data, fonts, ['--backend=manifold', '--export-format=binstl'], 'out.stl');
    if (solid.ok) {
      const buffer = solid.bytes!.slice().buffer;
      (self as any).postMessage({ format: 'stl', buffer, log: solid.log }, [buffer]);
      return;
    }
    // A 2D design has no solid to export, so it gets a drawing instead. A broken one fails here too.
    const flat = await run(event.data, fonts, [], 'out.dxf');
    if (flat.ok) {
      const buffer = flat.bytes!.slice().buffer;
      (self as any).postMessage({ format: 'dxf', buffer, log: flat.log }, [buffer]);
      return;
    }
    self.postMessage({ error: solid.log.join('\n') });
  } catch (error) {
    self.postMessage({ error: (error as Error)?.message ?? String(error) });
  }
};
