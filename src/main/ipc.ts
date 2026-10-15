import { ipcMain, app, BrowserWindow } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { ChaoxingEngine } from './engine';
import type { Store } from './store';
import { DEFAULT_SETTINGS } from '../shared/types';
import { normalizeBaseUrl } from '../shared/baseUrl';
import type { Session } from './session';
import type { Course, EngineEvent } from '../shared/types';
import type { AppInfo } from '../shared/api';
import { ProgressStore } from './engine/progress';
import { legacyDirCandidates } from './store';
import { checkForUpdates, downloadUpdate, quitAndInstall, getUpdateState } from './updater';

const pkgVersion = () => {
  try {
    return require('../../package.json').version as string;
  } catch {
    return '0.0.0';
  }
};

export function registerIpc(store: Store, session: Session, getWindow: () => BrowserWindow | null) {
  let engine: ChaoxingEngine | null = null;
  let engineDataDir: string | null = null;
  let cachedCourses: Course[] | null = null;

  const emit = (e: EngineEvent) => {
    if (e.type === 'courses') cachedCourses = e.courses;
    getWindow()?.webContents.send('engine:event', e);
  };

  async function getEngine(): Promise<ChaoxingEngine> {
    const dataDir = store.settings.dataDir;
    if (engine && engineDataDir === dataDir) return engine;
    if (engine?.isRunning) throw new Error('任务运行中，暂不能修改数据目录');
    const page = await session.ensurePage();
    engine = new ChaoxingEngine({
      page,
      dataDir,
      emit,
      getVideoSpeed: () => Number(store.settings.videoSpeed) || 1,
      getMuted: () => store.settings.muted !== false,
      getAgentEnabled: () => !!store.settings.agentEnabled,
      getVision: () => ({
        // 兜底一律取 DEFAULT_SETTINGS，不要在这里另写一份模型名默认值。
        // 这里曾经漏写成 mimo-v2.6-flash——用户在设置里把模型清空时会命中它，
        // 而它带图请求必 500，等于「清空模型 = 静默失能」。
        // normalizeBaseUrl 兜底：老版本存进来的脏地址（带 /chat/completions），
        // 用户不重新保存也能被纠正。
        baseUrl: normalizeBaseUrl(store.settings.visionBaseUrl || DEFAULT_SETTINGS.visionBaseUrl),
        apiKey: store.loadVisionKey() ?? '',
        model: store.settings.visionModel || DEFAULT_SETTINGS.visionModel,
      }),
      getSubmitCoverRate: () => {
        const v = Number(store.settings.submitCoverRate);
        return isNaN(v) ? 0.8 : Math.min(1, Math.max(0, v));
      },
      getAnswerPopup: () => !!store.settings.answerPopup,
      // 默认 false：验证类弹窗误判代价高（课程正文含这些词），不因它停摆
      getAutoPauseOnVerify: () => !!store.settings.autoPauseOnVerify,
    });
    engineDataDir = dataDir;
    return engine;
  }

  const requireCreds = () => {
    const c = store.loadCredentials();
    if (!c?.username) throw new Error('请先在「设置」中填写平台账号');
    return c;
  };

  ipcMain.handle('engine:listCourses', async () => {
    const creds = requireCreds();
    const e = await getEngine();
    const courses = await e.listCourses(creds);
    if (!courses.length) throw new Error('未获取到课程列表（登录失败或网络异常）');
    return courses;
  });

  ipcMain.handle('engine:start', async (_ev, courseIds: string[], resume: boolean) => {
    const creds = requireCreds();
    const e = await getEngine();
    if (e.isRunning) throw new Error('已有任务在运行');
    let courses = cachedCourses;
    if (!courses?.length) {
      courses = await e.listCourses(creds);
      if (!courses.length) throw new Error('未获取到课程列表');
    }
    const selected = courses.filter(c => courseIds.includes(c.courseId));
    if (!selected.length) throw new Error('请先选择至少一门课程');
    e.run(selected, creds, { resume }).catch(err =>
      emit({ type: 'error', message: String(err?.message || err), ts: Date.now() })
    );
    return { ok: true };
  });

  ipcMain.handle('engine:state', () => ({
    state: engine?.currentState ?? 'idle',
    running: engine?.isRunning ?? false,
    mode: session.mode,
  }));

  ipcMain.handle('engine:progress', () => {
    try {
      return new ProgressStore(store.settings.dataDir).listAll();
    } catch {
      return [];
    }
  });

  ipcMain.on('engine:pause', () => engine?.pause());
  ipcMain.on('engine:resume', () => engine?.resume());
  ipcMain.on('engine:stop', () => engine?.stop());

  ipcMain.handle('settings:get', () => store.settings);
  ipcMain.handle('settings:set', (_ev, patch: Record<string, unknown>) => {
    // 接口地址在保存侧就纠正：高频错误是把服务商文档里的完整接口路径
    // （…/chat/completions）整段粘进来，引擎再拼一次必然 400。
    if (typeof patch.visionBaseUrl === 'string') {
      patch.visionBaseUrl = normalizeBaseUrl(patch.visionBaseUrl);
    }
    const prevDir = store.settings.dataDir;
    store.saveSettings(patch);
    if (patch.dataDir && patch.dataDir !== prevDir && engine?.isRunning) {
      throw new Error('任务运行中，暂不能修改数据目录');
    }
    if (patch.dataDir && patch.dataDir !== prevDir) {
      engine = null;
      engineDataDir = null;
    }
    return store.settings;
  });

  ipcMain.handle('credentials:get', () => {
    const c = store.loadCredentials();
    return c?.username ?? null;
  });
  ipcMain.handle('credentials:set', (_ev, username: string, password: string) => {
    if (!username || !password) throw new Error('账号密码不能为空');
    const prev = store.loadCredentials();
    store.saveCredentials({ username, password });
    // 换了账号必须清掉浏览器的旧会话，否则登录时平台会直接沿用旧身份，
    // 表现为「填了新账号，进去还是之前那个账号的课程」。
    if (prev && prev.username && prev.username !== username) {
      session.clearAuthCookies().catch(() => {});
      // 课表缓存也必须一起清。缓存里的课程 URL 带着旧账号的 clazzid/cpi，
      // 用新账号的会话去打开只会是无权限页——目录里一个 chapter_item 都没有，
      // 用户看到的现象就是「换了账号后检测不到任务点」。
      cachedCourses = null;
    }
    return true;
  });
  ipcMain.handle('credentials:clear', async () => {
    store.clearCredentials();
    cachedCourses = null;
    // 关键：只删凭据文件不够。内嵌浏览器里旧账号的会话 Cookie 仍在，
    // 下次登录时超星会直接沿用旧身份——用户看到的就是「清空了却还是老账号」。
    try {
      await session.clearAuthCookies();
    } catch (e) {
      console.warn('[ipc] 清空凭据时清除 Cookie 失败:', e);
    }
    return true;
  });

  ipcMain.handle('vision:get', () => {
    const key = store.loadVisionKey();
    const baseUrl = store.settings.visionBaseUrl || '';
    // 判定必须和引擎侧一致：answerChannel()/visionChannel() 都要求
    // apiKey && baseUrl 同时存在。以前这里只看 key，用户只填密钥时
    // 设置页显示「已配置」、AI 开关能开，引擎却算出空通道，
    // 答题时只剩「未配置 AI 接口」——两边对「配没配」的定义不一样。
    const configured = !!key && !!baseUrl;
    let hint = '';
    if (key) hint = `\u2022\u2022\u2022\u2022${key.slice(-4)}`;
    if (key && !baseUrl) hint += '（还缺接口地址，答题不会调用 AI）';
    return { configured, hint };
  });

  ipcMain.handle('vision:set', (_ev, key: string) => {
    store.saveVisionKey(key);
    return { configured: !!store.loadVisionKey() };
  });

  ipcMain.handle('update:check', () => {
    void checkForUpdates();
    return getUpdateState();
  });

  ipcMain.handle('update:download', () => {
    downloadUpdate();
    return getUpdateState();
  });

  ipcMain.handle('update:install', () => {
    quitAndInstall();
    return true;
  });

  ipcMain.handle('update:state', () => getUpdateState());

  ipcMain.handle('app:info', (): AppInfo => {
    const settings = store.settings;
    let legacy = false;
    try {
      legacy = legacyDirCandidates().some(d => fs.existsSync(path.join(d, 'credentials.json')));
    } catch {}
    return { version: pkgVersion(), userData: store.userData, dataDir: settings.dataDir, legacy };
  });
}
