import { ipcMain, app, BrowserWindow } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { ChaoxingEngine } from './engine';
import type { Store } from './store';
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
      getDeepseekKey: () => store.settings.deepseekKey,
      getVideoSpeed: () => Number(store.settings.videoSpeed) || 1,
      getAgentEnabled: () => !!store.settings.agentEnabled,
      getVision: () => ({
        baseUrl: store.settings.visionBaseUrl || 'https://tokendance.space/gateway/v1',
        apiKey: store.loadVisionKey() ?? '',
        model: store.settings.visionModel || 'mimo-v2.6-flash',
      }),
    });
    engineDataDir = dataDir;
    return engine;
  }

  const requireCreds = () => {
    const c = store.loadCredentials();
    if (!c?.username) throw new Error('请先在「设置」中填写超星账号');
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
    store.saveCredentials({ username, password });
    return true;
  });
  ipcMain.handle('credentials:clear', () => {
    store.clearCredentials();
    return true;
  });

  ipcMain.handle('vision:get', () => {
    const key = store.loadVisionKey();
    return {
      // 只回传末4 位用于界面确认，不泄露完整 key
      configured: !!key,
      hint: key ? `\u2022\u2022\u2022\u2022${key.slice(-4)}` : '',
    };
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
