import { app, BrowserWindow, screen } from 'electron';
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

/**
 * 恢复的位置是否还落在某个显示器里。
 * 用户可能拔掉了副屏，此时按旧坐标开窗口会开在看不见的地方，
 * 表现为"程序启动了但没界面"。
 */
function isOnScreen(b: { x?: number; y?: number; width: number; height: number }): boolean {
  if (b.x === undefined || b.y === undefined) return true;
  const displays = screen.getAllDisplays();
  // 只要窗口有任意一部分压在某个屏内就认
  return displays.some(d => {
    const a = d.workArea;
    return (
      b.x! < a.x + a.width &&
      b.x! + b.width > a.x &&
      b.y! < a.y + a.height &&
      b.y! + b.height > a.y
    );
  });
}

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

  // 恢复上次的窗口大小/位置。用户嫌窗口太大挡着点刷课，改小一次就该记住，
  // 否则每次重启又弹回 1440x900，等于没改。
  const saved = store.settings.windowBounds;
  const bounds =
    saved && saved.width >= 1240 && saved.height >= 700 && isOnScreen(saved)
      ? saved
      : { width: 1440, height: 900 };

  win = new BrowserWindow({
    width: bounds.width,
    height: bounds.height,
    x: bounds.x,
    y: bounds.y,
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
  if (saved?.maximized) win.maximize();

  win.once('ready-to-show', () => win?.show());

  // 退出前把窗口形态写盘。debounce 一下，拖拽缩放时不要每帧都落盘。
  let saveTimer: NodeJS.Timeout | null = null;
  const persistBounds = () => {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      if (!win || !store) return;
      const [w, h] = win.getContentSize();
      const [x, y] = win.getPosition();
      store.saveSettings({
        windowBounds: { x, y, width: w, height: h, maximized: win.isMaximized() },
      });
    }, 400);
  };
  win.on('resize', () => {
    layout();
    persistBounds();
  });
  win.on('move', persistBounds);
  win.on('close', persistBounds);

  session = new Session(win);
  layout();
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
