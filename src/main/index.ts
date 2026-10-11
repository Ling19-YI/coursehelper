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

/** 学习通页面可用宽度下限：低于此值播放器与目录会挤在一起显示不全 */
const MIN_VIEW_WIDTH = 820;
/** 左侧面板宽度上限，避免宽屏下日志/设置区空得太多 */
const MAX_PANEL_WIDTH = 620;

function layout() {
  if (!win || !session) return;
  const [w, h] = win.getContentSize();
  // 先按比例给右侧，再确保它不低于 MIN_VIEW_WIDTH。
  // 旧算法用 Math.max(420, w*0.46) 优先保障左侧面板，
  // 窗口收到最小宽度时右侧只剩约 560px，学习通页面必然显示不全。
  let view = Math.floor(w * 0.54);
  if (view < MIN_VIEW_WIDTH) view = Math.min(MIN_VIEW_WIDTH, w);
  let panel = w - view;
  if (panel > MAX_PANEL_WIDTH) {
    panel = MAX_PANEL_WIDTH;
    view = w - panel;
  }
  session.setBounds({ x: panel, y: 0, width: Math.max(0, w - panel), height: h });
}

async function createWindow() {
  store = new Store();

  win = new BrowserWindow({
    width: 1440,
    height: 900,
    // 最小宽度 = 左侧面板下限 420 + 右侧学习通下限 820
    minWidth: 1240,
    minHeight: 700,
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
