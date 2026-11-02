// Entry point of the installed app: runs the library server inside the app and shows it in its own window.
import path from 'node:path';
import { BrowserWindow, Menu, app, dialog, shell } from 'electron';

const PREFERRED_PORT = 4610;

let mainWindow: BrowserWindow | null = null;

function showWindow(url: string) {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 480,
    minHeight: 500,
    show: false,
    title: 'Design Library',
    backgroundColor: '#15191c',
    icon: path.join(import.meta.dirname, '..', 'assets', 'icon.png'),
  });
  mainWindow.once('ready-to-show', () => {
    mainWindow?.maximize();
    mainWindow?.show();
  });
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
  // The page never navigates away. Dropping a file on the window must not replace the app with that file.
  mainWindow.webContents.on('will-navigate', (event, target) => {
    if (target !== url && !target.startsWith(url)) event.preventDefault();
  });
  mainWindow.webContents.setWindowOpenHandler(({ url: target }) => {
    if (/^https?:/.test(target)) void shell.openExternal(target);
    return { action: 'deny' };
  });
  void mainWindow.loadURL(url);
}

async function startServer(): Promise<string> {
  process.env.DATA_DIR ??= path.join(app.getPath('documents'), 'Design Library');
  // Imported here because the data folder must be set before the database module runs.
  const { app: server, setFileOpener } = await import('../server/app.ts');
  setFileOpener({
    open: (fullPath) => shell.openPath(fullPath),
    reveal: (fullPath) => shell.showItemInFolder(fullPath),
  });
  return new Promise((resolve, reject) => {
    const listen = (port: number) => {
      // Express also calls this on a failed listen. Going on would open the window on whatever holds the port.
      const listener = server.listen(port, '127.0.0.1', (error?: Error) => {
        if (error) return;
        const address = listener.address();
        resolve(`http://127.0.0.1:${typeof address === 'object' && address ? address.port : port}`);
      });
      listener.requestTimeout = 0;
      listener.on('error', (error: NodeJS.ErrnoException) => {
        // Another program holds the usual port, so let Windows pick a free one.
        if (error.code === 'EADDRINUSE' && port !== 0) listen(0);
        else reject(error);
      });
    };
    listen(PREFERRED_PORT);
  });
}

if (!app.requestSingleInstanceLock()) {
  // Already open, so the first instance brings its window forward.
  app.quit();
} else {
  let serverUrl = '';
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    } else if (serverUrl) {
      showWindow(serverUrl);
    }
  });
  app.on('window-all-closed', () => app.quit());

  app.whenReady().then(async () => {
    Menu.setApplicationMenu(null);
    try {
      serverUrl = await startServer();
      showWindow(serverUrl);
    } catch (error) {
      dialog.showErrorBox('Could not start Design Library', String((error as Error)?.message ?? error));
      app.quit();
    }
  });
}
