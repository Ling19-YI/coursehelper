import { app, safeStorage } from 'electron';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DEFAULT_SETTINGS, type AppSettings, type Credentials } from '../shared/types';

/**
 * 旧版命令行版本的数据目录（用于一次性迁移账号与课程进度）。
 * 可用环境变量 COURSEHELPER_LEGACY_DIR 指定；默认在当前用户目录下按常见位置查找。
 */
export function legacyDirCandidates(): string[] {
  const env = process.env.COURSEHELPER_LEGACY_DIR;
  const home = os.homedir();
  const list = [
    ...(env ? [env] : []),
    path.join(home, 'Documents', 'Default Project', '-'),
    path.join(home, 'Documents', '刷课', '-'),
    path.join(home, 'Desktop', '-'),
  ];
  return [...new Set(list)];
}

function firstExistingLegacy(): string | null {
  for (const dir of legacyDirCandidates()) {
    try {
      if (fs.existsSync(path.join(dir, 'credentials.json')) || fs.existsSync(path.join(dir, 'data'))) {
        return dir;
      }
    } catch {}
  }
  return null;
}

function readJson<T>(file: string): T | null {
  try {
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch {}
  return null;
}

export class Store {
  readonly userData: string;
  readonly settingsFile: string;
  readonly credsFile: string;
  readonly visionFile: string;
  readonly dataDir: string;
  settings: AppSettings;

  constructor() {
    this.userData = app.getPath('userData');
    this.settingsFile = path.join(this.userData, 'settings.json');
    this.credsFile = path.join(this.userData, 'credentials.enc');
    this.visionFile = path.join(this.userData, 'vision.enc');
    this.dataDir = path.join(this.userData, 'data');

    const disk = readJson<Partial<AppSettings>>(this.settingsFile) || {};
    this.settings = { ...DEFAULT_SETTINGS, ...disk };
    if (!this.settings.dataDir) this.settings.dataDir = this.dataDir;

    this.migrateLegacy();
    if (!fs.existsSync(this.settings.dataDir)) fs.mkdirSync(this.settings.dataDir, { recursive: true });
  }

  saveSettings(patch?: Partial<AppSettings>) {
    if (patch) Object.assign(this.settings, patch);
    fs.writeFileSync(this.settingsFile, JSON.stringify(this.settings, null, 2), 'utf-8');
  }

  loadCredentials(): Credentials | null {
    try {
      if (fs.existsSync(this.credsFile)) {
        const buf = fs.readFileSync(this.credsFile);
        if (safeStorage.isEncryptionAvailable()) {
          return JSON.parse(safeStorage.decryptString(buf));
        }
        return JSON.parse(buf.toString('utf-8'));
      }
    } catch (e) {
      // 加密数据不可读（如被其他环境破坏）→ 删除并尝试重新迁移
      console.warn('[store] 读取账号失败，尝试重新迁移:', e);
      try {
        fs.unlinkSync(this.credsFile);
      } catch {}
      this.migrateLegacy();
      try {
        if (fs.existsSync(this.credsFile)) {
          const buf = fs.readFileSync(this.credsFile);
          if (safeStorage.isEncryptionAvailable()) {
            return JSON.parse(safeStorage.decryptString(buf));
          }
          return JSON.parse(buf.toString('utf-8'));
        }
      } catch {}
    }
    return null;
  }

  saveCredentials(c: Credentials) {
    const json = Buffer.from(JSON.stringify(c), 'utf-8');
    const out = safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(json.toString('utf-8')) : json;
    fs.writeFileSync(this.credsFile, out);
  }

  clearCredentials() {
    try {
      fs.unlinkSync(this.credsFile);
    } catch {}
  }

  /** 视觉服务 key：与账号同等级的系统加密存储，不写进 settings.json */
  loadVisionKey(): string | null {
    try {
      if (!fs.existsSync(this.visionFile)) return null;
      const buf = fs.readFileSync(this.visionFile);
      const raw = safeStorage.isEncryptionAvailable()
        ? safeStorage.decryptString(buf)
        : buf.toString('utf-8');
      const key = String(JSON.parse(raw) || '').trim();
      return key || null;
    } catch {
      return null;
    }
  }

  saveVisionKey(key: string) {
    const value = String(key || '').trim();
    if (!value) {
      this.clearVisionKey();
      return;
    }
    const json = Buffer.from(JSON.stringify(value), 'utf-8');
    const out = safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(json.toString('utf-8')) : json;
    fs.writeFileSync(this.visionFile, out);
  }

  clearVisionKey() {
    try {
      fs.unlinkSync(this.visionFile);
    } catch {}
  }

  /** 从旧命令行版本迁移凭证与进度（一次性） */
  private migrateLegacy() {
    try {
      const legacyRoot = firstExistingLegacy();
      if (!legacyRoot) return;
      const legacyCreds = path.join(legacyRoot, 'credentials.json');
      if (!fs.existsSync(this.credsFile) && fs.existsSync(legacyCreds)) {
        const c = readJson<Credentials>(legacyCreds);
        if (c?.username && c?.password) {
          this.saveCredentials(c);
          console.log('[store] 已从旧版迁移账号');
        }
      }
      const legacyData = path.join(legacyRoot, 'data');
      if (fs.existsSync(legacyData)) {
        for (const f of fs.readdirSync(legacyData).filter(f => f.endsWith('.json'))) {
          const dst = path.join(this.dataDir, f);
          if (!fs.existsSync(dst)) fs.copyFileSync(path.join(legacyData, f), dst);
        }
      }
    } catch (e) {
      console.warn('[store] 迁移旧版数据失败:', e);
    }
  }
}
