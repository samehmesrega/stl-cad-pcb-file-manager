import { cpSync, mkdirSync } from 'node:fs';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const API = 'http://127.0.0.1:4600';

/** The CAD readers load their WASM files by URL at run time, so they ship next to the built page. */
const copyVendorFiles = () => ({
  name: 'copy-vendor-files',
  closeBundle() {
    const copies: [string, string, string[]][] = [
      ['node_modules/occt-import-js/dist', 'dist/vendor/occt', ['occt-import-js.js', 'occt-import-js.wasm', 'occt-import-js-worker.js']],
      ['node_modules/@mlightcad/libredwg-web/wasm', 'dist/vendor/libredwg', ['libredwg-web.js', 'libredwg-web.wasm']],
      // OpenSCAD draws text() with these. Same files pdf.js ships, so no second copy in the repo.
      ['node_modules/pdfjs-dist/standard_fonts', 'dist/vendor/fonts', ['LiberationSans-Regular.ttf', 'LiberationSans-Bold.ttf', 'LiberationSans-Italic.ttf', 'LiberationSans-BoldItalic.ttf', 'LICENSE_LIBERATION']],
    ];
    for (const [from, to, files] of copies) {
      mkdirSync(to, { recursive: true });
      for (const file of files) cpSync(`${from}/${file}`, `${to}/${file}`);
    }
  },
});

export default defineConfig({
  plugins: [react(), copyVendorFiles()],
  worker: { format: 'es' },
  build: { target: 'es2022', chunkSizeWarningLimit: 4000 },
  server: { proxy: { '/api': API, '/vendor': API } },
});
