// Runs the library from source, for start.bat and development. The installed app starts from electron/main.ts.
import { spawn } from 'node:child_process';
import { app } from './app.ts';
import { DATA_DIR } from './db.ts';

const PORT = Number(process.env.PORT ?? 4600);
// Local only by default: the library has no login. Set HOST=0.0.0.0 to share it on the LAN.
const HOST = process.env.HOST ?? '127.0.0.1';

function openBrowser(url: string) {
  // Edge's app mode gives the library its own window. Falls back to the default browser.
  const run = (command: string) =>
    spawn('cmd', ['/c', command], { stdio: 'ignore', windowsHide: true, windowsVerbatimArguments: true });
  run(`start "" msedge --app=${url}`).on('exit', (code) => {
    if (code) run(`start "" ${url}`);
  });
}

const url = `http://localhost:${PORT}`;
// Express also calls this on a failed listen, which the error handler below deals with.
const server = app.listen(PORT, HOST, (error?: Error) => {
  if (error) return;
  console.log(`Design library is running at ${url}`);
  console.log(`Data folder: ${DATA_DIR}`);
  if (process.argv.includes('--open') && process.platform === 'win32') openBrowser(url);
});
server.on('error', (error: NodeJS.ErrnoException) => {
  if (error.code === 'EADDRINUSE' && process.argv.includes('--open')) {
    // Already running from an earlier launch: just show it.
    openBrowser(url);
    setTimeout(() => process.exit(0), 500);
    return;
  }
  console.error(error);
  process.exit(1);
});
server.requestTimeout = 0;
