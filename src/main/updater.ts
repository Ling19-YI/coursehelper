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
 * 更新源列表，按顺序尝试，必要时回退到下一个。
 *
 * 为什么需要多源：国内大量用户无法访问 GitHub，
 * 只挂 GitHub 的话他们装完就再也收不到更新。
 *
 * 「继续试下一个源」有两种触发条件，缺一不可：
 *   1) 这个源不可达（超时 / 报错）；
 *   2) 这个源可达，但只回「已是最新」。
 * 第 2 条尤其容易漏：两个平台的发布节奏不保证同步——本次 v2.1.0 就是先发
 * GitCode、GitHub 当时还没发。若在「已是最新」处就收工，能上 GitHub 的用户
 * 会一直看不到更新（旧实现即如此）。
 *
 * GitCode 侧有三个坑，都实测踩过：
 *   1) 不能用 releases/latest/download/latest.yml 这种「跟随最新版本」的写法，
 *      该地址返回的是 HTML 登录页而非 yml；
 *   2) 正确结构是 releases/download/<tag>/，若写成 releases/<tag>/download/
 *      会返回一个 3.5KB 的 HTML 错误页（而不是报 404，极易误判为下载成功）。
 *   3) **URL 上一旦带查询串就 404**——`?noCache=1`、`?x=1` 全都 404，不带就 200。
 *      而 electron-updater 给 generic 源取 latest.yml 时会自动追加
 *      `?noCache=<随机>`（见其 util.js 的 newUrlFromBase），所以这条回退路径
 *      此前**从未成功过**:检查更新时表现为「GitCode 侧不可达」。
 *      对策见 initUpdater 里关掉 isAddNoCacheQuery 的那段注释。
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

  // 关掉 electron-updater 的 `?noCache=<随机>` 缓存破坏参数。
  //
  // 它给 generic 源取 latest.yml 时会自动追加这个查询串，而 GitCode 的下载域名
  // **只要 URL 带任何查询串就返回 404**（实测 `?noCache=1`、`?x=1` 全部 404，
  // 不带查询串则 200）。结果是 GitCode 这条回退路径永远失败，且错误文案是
  // 「Cannot find channel "latest.yml" update info: 404」，看着像文件没传上去，
  // 极易把人引向错误方向。
  //
  // 关掉它不影响缓存正确性：GitCode 每个版本有独立目录（/download/<tag>/），
  // URL 本身随版本变化，不靠查询串也已经不会取到旧的 latest.yml。
  //
  // isAddNoCacheQuery 是 electron-updater 原型上的 getter（无 setter），
  // 直接赋值在 ESM 严格模式下会抛错，必须用 defineProperty 遮蔽。
  Object.defineProperty(autoUpdater, 'isAddNoCacheQuery', {
    value: false,
    configurable: true,
  });
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
    // 多源探测期间不急着下结论：某个源说「已是最新」，另一个源可能已经发了新版
    // （两个平台的发布节奏不保证同步）。等所有源都试完，由 checkForUpdates 统一给结论。
    if (probing) return;
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

/**
 * 单次探测的结果。
 *
 * 必须区分「已是最新」和「不可达」——这两者含义完全不同：
 *   前者说明这个源工作正常、只是没有新版，此时仍要去问下一个源；
 *   后者才该记一笔失败。
 * 早期版本把两者都当成「成功」并立即收工，于是「GitHub 上还是旧版本、
 * GitCode 上已经发了新版」时，用户会一直看到「当前已是最新版本」。
 */
type ProbeResult = 'available' | 'uptodate' | 'failed';

/** 用指定源尝试一次检查 */
function probeOnce(cfg: Record<string, unknown>, timeoutMs: number): Promise<ProbeResult> {
  return new Promise<ProbeResult>(resolve => {
    let settled = false;
    const done = (r: ProbeResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      autoUpdater.removeListener('update-available', onAvail);
      autoUpdater.removeListener('update-not-available', onNot);
      autoUpdater.removeListener('error', onFail);
      resolve(r);
    };
    const onAvail = () => done('available');
    const onNot = () => done('uptodate');
    const onFail = () => done('failed');

    const timer = setTimeout(() => done('failed'), timeoutMs);

    autoUpdater.on('update-available', onAvail);
    autoUpdater.on('update-not-available', onNot);
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
  /** 至少有一个源明确答复「已是最新」。全都不行时，这就是最可信的结论 */
  let sawUptodate = false;

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
      const r = await probeOnce(cfg, src.timeoutMs);
      if (r === 'available') return; // update-available 已触发并更新了 UI
      if (r === 'uptodate') {
        // 这个源工作正常、只是没有新版 —— 但别的源可能有，继续问下去。
        sawUptodate = true;
        continue;
      }
      failures.push(`${src.name}: 不可达`);
    }

    if (sawUptodate) {
      merge({ checking: false, available: false, message: '当前已是最新版本' });
      return;
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