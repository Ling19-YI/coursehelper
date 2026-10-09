import { app, BrowserWindow } from 'electron';
import * as path from 'path';
import { Store } from './store';
import { Session } from './session';
import { registerIpc } from './ipc';
import { initUpdater, checkForUpdates } from './updater';

app.setName('刷课助手 CourseHelper');

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();

const DEBUG_PORT = '9333';
app.commandLine.appendSwitch('remote-debugging-port', DEBUG_PORT);
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-blink-features', 'AutomationControlled');

let win: BrowserWindow | null = null;
let session: Session | null = null;
let store: Store | null = null;

function layout() {
  if (!win || !session) return;
  const [w, h] = win.getContentSize();
  const panel = Math.max(420, Math.floor(w * 0.46));
  session.setBounds({ x: panel, y: 0, width: Math.max(0, w - panel), height: h });
}

async function createWindow() {
  store = new Store();

  win = new BrowserWindow({
    width: 1360,
    height: 880,
    minWidth: 1040,
    minHeight: 640,
    backgroundColor: '#0b1220',
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'index.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.once('ready-to-show', () => win?.show());

  session = new Session(win);
  layout();
  win.on('resize', layout);
  registerIpc(store, session, () => win);

  const devUrl = process.env.VITE_DEV_SERVER_URL;
  if (devUrl) await win.loadURL(devUrl);
  else await win.loadFile(path.join(__dirname, '..', '..', 'renderer', 'index.html'));

  win.on('closed', () => {
    session?.dispose();
    win = null;
    session = null;
  });

  // 自动更新：启动后稍作延迟再检查，避免与登录流程抢网络
  initUpdater(() => win);
  setTimeout(() => {
    void checkForUpdates();
  }, 12000);
}

app.whenReady().then(() => {
  createWindow().catch(e => {
    console.error('[main] 创建窗口失败:', e);
    app.exit(1);
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) void createWindow();
});
