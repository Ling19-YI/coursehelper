import { app, type BrowserWindow } from 'electron';
import { autoUpdater } from 'electron-updater';

export interface UpdateInfo {
  checking: boolean;
  available: boolean;
  version?: string;
  notes?: string;
  releaseDate?: string;
  percent: number;
  speed: number;
  transferred: number;
  total: number;
  downloading: boolean;
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

/**
 * 更新源列表，按顺序尝试，失败自动回退到下一个。
 *
 * 为什么需要多源：国内大量用户无法访问 GitHub，
 * 只挂 GitHub 的话他们装完就再也收不到更新。
 *
 * GitCode 侧有两个坑，都实测踩过：
 *   1) 不能用 releases/latest/download/latest.yml 这种「跟随最新版本」的写法，
 *      该地址返回的是 HTML 登录页而非 yml；
 *   2) 正确结构是 releases/download/<tag>/，若写成 releases/<tag>/download/
 *      会返回一个 3.5KB 的 HTML 错误页（而不是报 404，极易误判为下载成功）。
 * 因此每次检查前先调 API 取回当前最新 tag，再拼出真实地址。
 */
const SOURCES: Array<{
  name: string;
  /** 应用内展示用，不含任何凭据 */
  build(timeoutMs: number): Promise<Record<string, unknown> | null>;
  timeoutMs: number;
}> = [
  {
    name: 'GitHub',
    timeoutMs: 12000,
    build: async () => ({
      provider: 'github',
      owner: 'Ling19-YI',
      repo: 'coursehelper',
      releaseType: 'release',
    }),
  },
  {
    name: 'GitCode',
    timeoutMs: 15000,
    build: async timeoutMs => {
      const tag = await resolveGitCodeLatestTag(timeoutMs);
      if (!tag) return null;
      return {
        provider: 'generic',
        url: `https://gitcode.com/2603_95808828/coursehelp/releases/download/${tag}`,
      };
    },
  },
];

/** 通过 GitCode API 取最新发行版 tag；该接口公开可读，无需令牌 */
async function resolveGitCodeLatestTag(timeoutMs: number): Promise<string | null> {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const r = await fetch(
        'https://gitcode.com/api/v5/repos/2603_95808828/coursehelp/releases/latest',
        { signal: ctrl.signal, headers: { 'User-Agent': 'coursehelper' } }
      );
      if (!r.ok) return null;
      const j: any = await r.json();
      return typeof j?.tag_name === 'string' && j.tag_name ? j.tag_name : null;
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return null;
  }
}

let win: BrowserWindow | null = null;
let checking = false;
/** 正在按顺序试多个源：此时单个源失败不该立刻报错，等所有源试完再说 */
let probing = false;
/** 当前生效的源名，用于把提示文案说清楚 */
let activeSource = '';

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
    const via = activeSource ? `（${activeSource}）` : '';
    merge({
      checking: false,
      available: true,
      version: info?.version,
      notes: String(info?.releaseNotes || '').slice(0, 2000),
      releaseDate: info?.releaseDate,
      message: `发现新版本 v${info?.version}${via}`,
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
    // 多源探测过程中的单个源失败由外层处理，这里不抢先报错
    if (probing) return;
    checking = false;
    const msg = String(e?.message || e || '未知错误');
    merge({ checking: false, downloading: false, message: `检查更新失败：${msg.slice(0, 120)}` });
    send({ error: msg.slice(0, 200) });
  });
}

/** 用指定源尝试一次检查，返回是否成功（含「已是最新」也算成功） */
function probeOnce(cfg: Record<string, unknown>, timeoutMs: number): Promise<boolean> {
  return new Promise<boolean>(resolve => {
    let settled = false;
    const done = (ok: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      autoUpdater.removeListener('update-available', onOk);
      autoUpdater.removeListener('update-not-available', onOk);
      autoUpdater.removeListener('error', onFail);
      resolve(ok);
    };
    const onOk = () => done(true);
    const onFail = () => done(false);

    const timer = setTimeout(() => done(false), timeoutMs);

    autoUpdater.on('update-available', onOk);
    autoUpdater.on('update-not-available', onOk);
    autoUpdater.on('error', onFail);

    try {
      autoUpdater.setFeedURL(cfg as any);
      autoUpdater.checkForUpdates().catch(() => onFail());
    } catch {
      onFail();
    }
  });
}

/** 手动检查更新：按顺序尝试所有源 */
export async function checkForUpdates(): Promise<void> {
  if (isDev || checking) return;
  checking = true;
  probing = true;
  merge({ checking: true, available: false, message: '正在检查更新…' });

  const failures: string[] = [];

  try {
    for (const src of SOURCES) {
      let cfg: Record<string, unknown> | null = null;
      try {
        cfg = await src.build(src.timeoutMs);
      } catch {
        cfg = null;
      }
      if (!cfg) {
        failures.push(`${src.name}: 无法定位更新地址`);
        continue;
      }

      activeSource = src.name;
      const ok = await probeOnce(cfg, src.timeoutMs);
      if (ok) return; // update-available / update-not-available 已触发并更新了 UI
      failures.push(`${src.name}: 不可达`);
    }

    merge({
      checking: false,
      available: false,
      message: `检查更新失败：${failures.join('；').slice(0, 160)}`,
    });
    send({ error: failures.join('; ').slice(0, 200) });
  } finally {
    probing = false;
    checking = false;
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