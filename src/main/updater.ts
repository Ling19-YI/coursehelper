import { app, type BrowserWindow } from 'electron';
import { autoUpdater } from 'electron-updater';

export interface UpdateInfo {
  /** 当前是否在检查中 */
  checking: boolean;
  /** 是否有新版本 */
  available: boolean;
  /** 最新版本号 */
  version?: string;
  /** 新版本更新说明 */
  notes?: string;
  /** 发布时间 */
  releaseDate?: string;
  /** 下载进度 0-100 */
  percent: number;
  /** 下载速度（字节/秒） */
  speed: number;
  transferred: number;
  total: number;
  /** 是否正在下载 */
  downloading: boolean;
  /** 上次检查结果文案 */
  message: string;
}

export interface UpdatePayload {
  type: 'update';
  info: Partial<UpdateInfo> & { error?: string; quitAndInstall?: boolean };
}

/**
 * 开发模式判定。
 * 不能只看 NODE_ENV：打包后的正式版该变量通常是 undefined，
 * 若按「未定义即开发」处理，打包版会永远跳过更新检查。
 * 改为依据 app 是否被打包（app.isPackaged）判断。
 */
const isDev = !app.isPackaged;

let win: BrowserWindow | null = null;
let checking = false;

const state: UpdateInfo = {
  checking: false,
  available: false,
  percent: 0,
  speed: 0,
  transferred: 0,
  total: 0,
  downloading: false,
  message: '',
};

function send(info: Partial<UpdateInfo> & { error?: string; quitAndInstall?: boolean }) {
  try {
    win?.webContents.send('update:event', { type: 'update', info } as UpdatePayload);
  } catch {}
}

function merge(patch: Partial<UpdateInfo>) {
  Object.assign(state, patch);
  send({ ...state });
}

/** 初始化自动更新 */
export function initUpdater(getWindow: () => BrowserWindow | null) {
  win = getWindow();
  if (isDev) {
    merge({ message: '开发模式下不检查更新' });
    return;
  }

  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;
  // 未发布签名时也要能下载更新：跳过校验会降低安全性，
  // 但本项目安装包本身也未做代码签名，因此保持一致
  autoUpdater.logger = null;

  autoUpdater.on('checking-for-update', () => {
    checking = true;
    merge({ checking: true, message: '正在检查更新…' });
  });

  autoUpdater.on('update-available', (info: any) => {
    checking = false;
    merge({
      checking: false,
      available: true,
      version: info?.version,
      notes: String(info?.releaseNotes || '').slice(0, 2000),
      releaseDate: info?.releaseDate,
      message: `发现新版本 v${info?.version}`,
    });
  });

  autoUpdater.on('update-not-available', (info: any) => {
    checking = false;
    merge({
      checking: false,
      available: false,
      version: info?.version,
      message: '当前已是最新版本',
    });
  });

  autoUpdater.on('download-progress', (p: any) => {
    merge({
      downloading: true,
      percent: Math.round((p?.percent ?? 0) * 100) / 100,
      speed: p?.bytesPerSecond ?? 0,
      transferred: p?.transferred ?? 0,
      total: p?.total ?? 0,
      message: `正在下载更新 ${Math.round(p?.percent ?? 0)}%`,
    });
  });

  autoUpdater.on('update-downloaded', (info: any) => {
    merge({
      downloading: false,
      percent: 100,
      version: info?.version,
      message: `v${info?.version} 已下载完成，重启即可安装`,
    });
  });

  autoUpdater.on('error', (e: any) => {
    checking = false;
    const msg = String(e?.message || e || '未知错误');
    merge({ checking: false, downloading: false, message: `检查更新失败：${msg.slice(0, 120)}` });
    send({ error: msg.slice(0, 200) });
  });
}

/** 手动检查更新 */
export async function checkForUpdates(): Promise<void> {
  if (isDev || checking) return;
  try {
    await autoUpdater.checkForUpdates();
  } catch (e: any) {
    checking = false;
    merge({ message: `检查更新失败：${String(e?.message || e).slice(0, 100)}` });
  }
}

/** 下载已发现的更新 */
export function downloadUpdate(): void {
  if (isDev) return;
  try {
    autoUpdater.downloadUpdate();
  } catch (e: any) {
    merge({ message: `下载失败：${String(e?.message || e).slice(0, 100)}` });
  }
}

/** 退出并安装更新 */
export function quitAndInstall(): void {
  if (isDev) return;
  try {
    autoUpdater.quitAndInstall(false, true);
  } catch {
    /* 已在安装流程中则忽略 */
  }
}

/** 当前状态快照 */
export function getUpdateState(): UpdateInfo {
  return { ...state };
}